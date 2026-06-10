/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plugin to run at the end of the config loading.
 * Should validate (or not) the configuration and display appropriate messages
 */

const { getLogger } = require('@pryv/boiler');
let logger; // initalized at load();

// Fields that MUST be populated in `service:` before the process can start.
// Matches the schema in components/api-server/src/schema/service-info.js —
// `api`, `access`, `register` are auto-populated by the public-url plugin.
//
const REQUIRED_SERVICE_FIELDS = ['name', 'serial', 'home', 'support', 'terms', 'eventTypes'];

// Feature-gated required keys. Each entry: when `when(config)` returns
// truthy, `config.get(path)` must return a non-empty, non-sentinel value
// at boot. Caught here, the missing key fails the boot — strictly better
// than the same key being missing at request time and silently degrading
// downstream (PR 71 root cause: `auth.passwordResetPageURL` missing →
// password-reset email rendered with empty href).
//
// The existing `checkIncompleteFields` walker covers `REPLACE` sentinels
// and unresolved `${VAR}` env placeholders on values that ARE present in
// the tree. REQUIRED_WHEN adds detection for keys that are simply absent
// (no entry to descend into) when the feature gating says they ought to
// be there.
const REQUIRED_WHEN = [
  // `services.email.enabled` is an object `{ welcome, resetPassword }`
  // in the default config — mirror the gating logic from
  // `methods/account.ts:174` exactly so the boot-time check tracks the
  // runtime behaviour.
  {
    path: 'auth:passwordResetPageURL',
    when: c => {
      const enabled = c.get('services:email:enabled');
      if (enabled === false) return false;
      if (enabled != null && typeof enabled === 'object' && enabled.resetPassword === false) return false;
      return true;
    }
  },
  // Admin keys & secrets — always required at boot. Multi-core bootstrap
  // already enforces `filesReadTokenSecret` via REQUIRED_AUTH_SECRETS;
  // single-core deploys had no equivalent guard until now.
  { path: 'auth:adminAccessKey', when: () => true },
  { path: 'auth:filesReadTokenSecret', when: () => true },
  // LetsEncrypt at-rest secrets — required only when the feature is on.
  { path: 'letsEncrypt:atRestKey', when: c => c.get('letsEncrypt:enabled') === true },
  { path: 'letsEncrypt:email', when: c => c.get('letsEncrypt:enabled') === true }
];

// A value is treated as "missing / unset" if it would render the feature
// non-functional. Includes `null`/`undefined`, empty strings, and the two
// sentinels (`REPLACE …`, `${VAR}`) — the sentinels are also caught by
// `checkIncompleteFields` but a redundant problem with a clearer message
// is strictly better operator UX than a single generic one.
function isMissingOrSentinel (value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  if (value.includes('REPLACE')) return true;
  if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(value)) return true;
  return false;
}

function checkRequiredWhen (config, problems) {
  for (const { path, when } of REQUIRED_WHEN) {
    if (!when(config)) continue;
    const value = config.get(path);
    if (isMissingOrSentinel(value)) {
      problems.push({
        message: `required configuration key '${path}' is missing or unset — required for this deployment's feature set.`,
        path: path.split(':'),
        payload: { path, presentButEmpty: value === '' || (typeof value === 'string' && (value.includes('REPLACE') || /\$\{[A-Z_][A-Z0-9_]*\}/.test(value))) }
      });
    }
  }
}

// Enum-style validation for `audit:onUserDelete` mode + gate for
// `pseudonymise` which depends on the not-yet-shipped ALIASES
// primitive. Lives alongside REQUIRED_WHEN so future enum-style gates
// land in the same shape.
const AUDIT_ON_USER_DELETE_MODES = ['erase', 'keep', 'pseudonymise'];

function checkAuditOnUserDeleteMode (config, problems) {
  const value = config.get('audit:onUserDelete');
  if (value == null) return; // default 'erase' wired in default-config.yml — absence here means override removed it, treat as 'erase'
  if (!AUDIT_ON_USER_DELETE_MODES.includes(value)) {
    problems.push({
      message: `'audit:onUserDelete' must be one of: ${AUDIT_ON_USER_DELETE_MODES.join(', ')}. Got: ${JSON.stringify(value)}.`,
      path: ['audit', 'onUserDelete'],
      payload: { value, allowed: AUDIT_ON_USER_DELETE_MODES }
    });
    return;
  }
  if (value === 'pseudonymise') {
    problems.push({
      message: "'audit:onUserDelete: pseudonymise' is not yet available — it requires the auth.randomAlias primitive (open-pryv.io#38, backlog slug ALIASES). Use 'erase' (default) or 'keep' until ALIASES ships, then re-enable.",
      path: ['audit', 'onUserDelete'],
      payload: { value: 'pseudonymise', dependsOn: 'ALIASES (open-pryv.io#38)' }
    });
  }
}

// Conflicting DNS-topology flags. `dns.active: true` runs the embedded DNS
// and advertises per-user-subdomain URLs (service/info `api`, reserved
// `reg.<domain>` register URL, …), but `dnsLess.isActive` — which defaults
// to TRUE — gates the express-side subdomain routing (username hoist +
// reg/access/mfa path mapping). Both on at once means DNS resolves names
// whose requests the API then misroutes path-style: `reg.<domain>/…`
// answers "Unknown user reg" and `https://<user>.<domain>/events` breaks.
// Fail the boot with the one-line fix instead.
function checkDnsTopologyConsistency (config, problems) {
  if (config.get('dns:active') === true && config.get('dnsLess:isActive') === true) {
    problems.push({
      message: "conflicting DNS topology — 'dns.active: true' (per-user subdomains) requires 'dnsLess.isActive: false', but it is true (the default). Add `dnsLess:\\n  isActive: false` to your config.",
      path: ['dnsLess', 'isActive'],
      payload: { 'dns.active': true, 'dnsLess.isActive': true }
    });
  }
}

async function validate (config) {
  // Collect every validation problem in one pass so the operator sees the
  // full list in a single boot-and-fail cycle instead of one-per-restart.
  const problems = [];

  checkIncompleteFields(config.get(), false, [], null, problems, config);

  const service = config.get('service') || {};
  const missing = REQUIRED_SERVICE_FIELDS.filter(f => !service[f]);
  if (missing.length > 0) {
    problems.push({
      message: 'required service fields missing — /service/info would be invalid. Set them in your override-config.yml under `service:`.',
      path: ['service'],
      payload: { missing, required: REQUIRED_SERVICE_FIELDS }
    });
  }

  checkRequiredWhen(config, problems);
  checkAuditOnUserDeleteMode(config, problems);
  checkDnsTopologyConsistency(config, problems);

  return problems;
}

/**
 * Parse all string fields and record a problem for each "REPLACE" sentinel
 * or unresolved `${VAR}` env placeholder. Stops recursing on `active:false`
 * or `enabled:false` blocks.
 *
 * @param {*} obj The object to inspect
 * @param {Array<string>|false} finalPath is !== false the path to access the value (set when passing thru first Array)
 * @param {Array<string>} parentPath path to display in case of error. If in array the index of the array is happened to the path
 * @param {string|null} key the key to construct the path
 * @param {Array<object>} problems accumulator for all problems found
 * @param {object} config the boiler config store (for `getScopeAndValue`)
 */
function checkIncompleteFields (obj, finalPath, parentPath, key, problems, config) {
  const path = key != null ? parentPath.concat(key) : parentPath;
  if (typeof obj === 'undefined' || obj === null) return;
  if (typeof obj === 'string') {
    if (obj.includes('REPLACE')) {
      const queryPath = finalPath || parentPath;
      const res = config.getScopeAndValue(queryPath.join(':'));
      problems.push({ message: 'field content should be replaced', path, payload: res });
    }
    // Unresolved env-var placeholder (`${FOO}`): nothing in the stack expands
    // these, so the literal string reaches consumers and (for paths) creates
    // a literal `${FOO}` directory on disk. Report it.
    const envMatch = obj.match(/\$\{([A-Z_][A-Z0-9_]*)\}/);
    if (envMatch) {
      const queryPath = finalPath || parentPath;
      const res = config.getScopeAndValue(queryPath.join(':'));
      problems.push({
        message: `unresolved env placeholder \${${envMatch[1]}} — export ${envMatch[1]} or replace the literal in config`,
        path,
        payload: { ...res, envVar: envMatch[1] }
      });
    }
  }
  if (typeof obj === 'object') {
    // Skip REPLACE scan on disabled blocks — operators leave `REPLACE ME`
    // sentinels on fields they don't use (e.g. letsEncrypt.{email,atRestKey}
    // when letsEncrypt.enabled=false), and these would otherwise fail-fast
    // the whole startup.
    if (obj.active === false) return;
    if (obj.enabled === false) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        checkIncompleteFields(obj[i], finalPath || parentPath, path, i, problems, config);
      }
    } else {
      for (const k of Object.keys(obj)) {
        checkIncompleteFields(obj[k], finalPath, path, k, problems, config);
      }
    }
  }
}

function formatProblem (p) {
  return 'Configuration is invalid at [' + (p.path || []).join(':') + '] ' + p.message;
}

module.exports = {
  load: async function (store) {
    logger = getLogger('validate-config');
    const problems = await validate(store);
    if (problems.length === 0) return;
    logger.error(`Configuration is invalid — ${problems.length} problem(s) found:`);
    for (const p of problems) {
      logger.error(formatProblem(p), p.payload);
    }
    process.exit(1);
  },
  // Exported for unit testing — kept stable so [CV-REQ] / future tests can
  // exercise the validator without booting the boiler init lifecycle.
  validate,
  checkRequiredWhen,
  checkAuditOnUserDeleteMode,
  checkDnsTopologyConsistency,
  isMissingOrSentinel,
  REQUIRED_WHEN,
  AUDIT_ON_USER_DELETE_MODES
};
