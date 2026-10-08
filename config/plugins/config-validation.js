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

const fs = require('node:fs');
const path = require('node:path');
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
  // `auth.emailVerificationPageURL` backs the verify-email link.
  //
  // Required only when the operator turned the sub-feature on explicitly.
  // The shipped default is ON; a default-on deployment that never set the
  // page URL must keep booting: the feature degrades to off with a boot
  // warning (see collectWarnings) instead of refusing the boot on upgrade.
  {
    path: 'auth:emailVerificationPageURL',
    when: c => {
      const { describeVerificationMail } = require('../../components/business/src/emails/mailCapability.ts');
      const status = describeVerificationMail(c);
      if (status.reason === 'disabled') return false;
      return status.explicit;
    }
  },
  // Admin keys & secrets — always required at boot. Multi-core bootstrap
  // already enforces `filesReadTokenSecret` via REQUIRED_AUTH_SECRETS;
  // single-core deploys had no equivalent guard until now.
  { path: 'auth:adminAccessKey', when: () => true },
  { path: 'auth:filesReadTokenSecret', when: () => true },
  // LetsEncrypt at-rest secrets — required only when the feature is on.
  { path: 'letsEncrypt:atRestKey', when: c => c.get('letsEncrypt:enabled') === true },
  // PlatformDB PII pepper — required when PII is hashed (the shipped default).
  // Platform defers a missing key to the first PII operation so CLI tools that
  // never touch PII can start; a server would then boot and refuse every
  // registration. The gate mirrors Platform's own resolution (unset = cleartext).
  {
    path: 'platform:piiHmacKey',
    when: c => (c.get('platform:piiMode') || 'cleartext') === 'hashed',
    // Platform only accepts a string; anything else is deferred like a missing key.
    isMissing: v => typeof v !== 'string' || isMissingOrSentinel(v),
    hint: 'set it to base64 of 32 random bytes (`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`), ' +
      'the same value on every core (or env var `platform__piiHmacKey`), or set platform.piiMode: cleartext'
  },
  // `sso.landingPageURL` receives the one-time sign-in handoff after a
  // successful third-party (OIDC) login — required once SSO is enabled with at
  // least one provider, else the callback has nowhere to hand off. (Structural
  // per-provider validation is in checkSsoConfig below.)
  {
    path: 'sso:landingPageURL',
    when: c => {
      if (c.get('sso:enabled') !== true) return false;
      const providers = c.get('sso:providers');
      return providers != null && typeof providers === 'object' && Object.keys(providers).length > 0;
    }
  }
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
  for (const { path, when, isMissing, hint } of REQUIRED_WHEN) {
    if (!when(config)) continue;
    const value = config.get(path);
    if ((isMissing || isMissingOrSentinel)(value)) {
      problems.push({
        message: `required configuration key '${path}' is missing or unset — required for this deployment's feature set.` +
          (hint ? ' ' + hint : ''),
        path: path.split(':'),
        payload: { path, presentButEmpty: value === '' || (typeof value === 'string' && (value.includes('REPLACE') || /\$\{[A-Z_][A-Z0-9_]*\}/.test(value))) }
      });
      continue;
    }
    if (SECRET_PATHS.includes(path)) {
      const reason = weakSecretReason(value, { production: process.env.NODE_ENV === 'production' });
      if (reason != null) {
        problems.push({
          message: `secret '${path}' ${reason}: ` +
            (hint || 'set a long random value of your own (e.g. `openssl rand -hex 32`).'),
          path: path.split(':'),
          payload: { path, weakSecret: true }
        });
      }
    }
  }
}

// Secrets that grant platform-wide powers. A value shipped as a placeholder in
// a config file (or a common stand-in) is as good as public, so it never boots;
// in production a short value, or one published for development and tests, is
// refused too.
const SECRET_PATHS = ['auth:adminAccessKey', 'auth:filesReadTokenSecret', 'platform:piiHmacKey'];
const { weakSecretReason, MIN_SECRET_LENGTH } = require('../../components/business/src/secretValues.ts');

// `auth.trustedApps` gates the browser login and password-reset flows. Absent,
// every such call would fail at request time; a malformed entry would be
// silently skipped. Both refuse the boot instead.
function checkTrustedApps (config, problems) {
  const { parseTrustedApps } = require('../../components/business/src/auth/trustedApps.ts');
  const value = config.get('auth:trustedApps');
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push({
      message: "required configuration key 'auth:trustedApps' is missing or empty: list the origins of your auth UI and apps, e.g. '*@https://account.example.com'.",
      path: ['auth', 'trustedApps'],
      payload: { path: 'auth:trustedApps' }
    });
    return;
  }
  for (const error of parseTrustedApps(value).errors) {
    problems.push({
      message: `'auth:trustedApps' entry is invalid: ${error}`,
      path: ['auth', 'trustedApps'],
      payload: { path: 'auth:trustedApps' }
    });
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

// PostgreSQL platform storage is a single-core, dnsLess-only option (the
// "diskless" deployment shape: platform data lives in the same PG instance
// as user data, no rqlite process / data dir). PostgreSQL is not replicated
// across cores, so any multi-core signal alongside it would silently break
// cross-core registration uniqueness — refuse the boot instead, naming the
// migration path back to rqlite.
function checkPlatformEngineTopology (config, problems) {
  if (config.get('storages:platform:engine') !== 'postgresql') return;
  const refuse = (message, payload) => problems.push({
    message, path: ['storages', 'platform', 'engine'], payload
  });
  if (config.get('dnsLess:isActive') !== true) {
    refuse("'storages.platform.engine: postgresql' is single-core only and requires 'dnsLess.isActive: true'. Multi-core / dns-active deployments must keep 'storages.platform.engine: rqlite' (migrate platform data with `node bin/migrate-platform.js` before switching).",
      { 'dnsLess.isActive': config.get('dnsLess:isActive') });
  }
  if (config.get('dns:active') === true) {
    refuse("'storages.platform.engine: postgresql' cannot run with the embedded DNS ('dns.active: true') — that topology implies per-user subdomains / multi-core and requires the rqlite platform engine.",
      { 'dns.active': true });
  }
  if (config.get('storages:base:engine') !== 'postgresql') {
    refuse(`'storages.platform.engine: postgresql' requires 'storages.base.engine: postgresql' (full PG mode) — got '${config.get('storages:base:engine')}'.`,
      { 'storages.base.engine': config.get('storages:base:engine') });
  }
  if (config.get('cluster:discoveryEnabled') === true) {
    refuse("'storages.platform.engine: postgresql' cannot run with 'cluster.discoveryEnabled: true' (multi-core rqlite discovery). Keep the rqlite platform engine for multi-core deployments.",
      { 'cluster.discoveryEnabled': true });
  }
}

// The PostgreSQL series engine runs on the base engine's PostgreSQL
// connection, which the storage layer opens only when the base engine is
// PostgreSQL. With a SQLite base the server would boot and fail every series
// read and write (and the series step of account deletion). The PostgreSQL
// audit and file engines open their own pool, so they work with any base.
// The series engine defaults to postgresql: a config that switches only the
// base engine to SQLite lands here too.
function checkSeriesEngineDependency (config, problems) {
  const seriesEngine = config.get('storages:series:engine');
  const baseEngine = config.get('storages:base:engine');
  if (seriesEngine !== 'postgresql' || baseEngine === 'postgresql') return;
  problems.push({
    message: `'storages.series.engine: postgresql' requires 'storages.base.engine: postgresql' (the PostgreSQL series engine uses the base storage connection), got '${baseEngine}'. With a SQLite base, set 'storages.series.engine: sqlite' or 'influxdb' (the series engine defaults to postgresql).`,
    path: ['storages', 'series', 'engine'],
    payload: { 'storages.series.engine': seriesEngine, 'storages.base.engine': baseEngine }
  });
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

// Structural validation for the third-party sign-in (OIDC relying party)
// block. Only runs when `sso.enabled` is true (the opt-in feature). Enforces:
//   - v1 is single-core / dnsLess only: `sso.enabled` alongside the embedded
//     DNS (`dns.active: true`) is refused — per-core callback URIs / cross-core
//     session handoff have no clean v1 answer (deferred to a dedicated design);
//   - each provider id is a url-safe slug (it appears in callback paths and in
//     platform field names);
//   - each configured provider carries a parseable https `issuer` and a
//     non-sentinel `clientId` / `clientSecret`.
const SSO_PROVIDER_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

function checkSsoConfig (config, problems) {
  if (config.get('sso:enabled') !== true) return;

  if (config.get('dns:active') === true) {
    problems.push({
      message: "'sso.enabled: true' is single-core / dnsLess only in this version and cannot run with the embedded DNS ('dns.active: true'). Multi-core SSO is deferred — disable one of the two.",
      path: ['sso', 'enabled'],
      payload: { 'dns.active': true }
    });
  }

  // The SSO callback hands the minted (non-MFA) session token to the auth app
  // ONLY through a one-time shared secret, never in the redirect URL. If shared
  // secrets are disabled the callback cannot do that and MUST NOT fall back to a
  // token-in-URL, so it would fail every non-MFA sign-in at runtime. Refuse at
  // boot instead: sso.enabled requires sharedSecrets.enabled (default true).
  if (config.get('sharedSecrets:enabled') === false) {
    problems.push({
      message: "'sso.enabled: true' requires 'sharedSecrets.enabled: true': the sign-in callback hands the session token to the auth app via a one-time shared secret and never through the URL. Enable shared secrets, or disable SSO.",
      path: ['sso', 'enabled'],
      payload: { 'sharedSecrets.enabled': false }
    });
  }

  // Optional callback base — when set it is the base of the IdP-registered
  // redirect URI, so a non-https / unparseable value is a misconfiguration.
  const callbackBaseURL = config.get('sso:callbackBaseURL');
  if (typeof callbackBaseURL === 'string' && callbackBaseURL !== '') {
    let parsed = null;
    try { parsed = new URL(callbackBaseURL); } catch (e) { parsed = null; }
    if (parsed == null || parsed.protocol !== 'https:') {
      problems.push({
        message: `sso.callbackBaseURL must be a valid https URL when set. Got: ${JSON.stringify(callbackBaseURL)}.`,
        path: ['sso', 'callbackBaseURL'],
        payload: { callbackBaseURL }
      });
    }
  }

  // The sign-in callback appends its result as a URL FRAGMENT to landingPageURL
  // (`<landingPageURL>#ssoStatus=…`). A landingPageURL that already carries a
  // fragment would double-hash and corrupt the hand-off, so forbid it at boot.
  const landingPageURL = config.get('sso:landingPageURL');
  if (typeof landingPageURL === 'string' && landingPageURL.includes('#')) {
    problems.push({
      message: 'sso.landingPageURL must not contain a URL fragment ("#..."): the sign-in callback appends its result as a fragment and an existing one would corrupt it.',
      path: ['sso', 'landingPageURL'],
      payload: { landingPageURL }
    });
  }

  const providers = config.get('sso:providers');
  // Empty providers is allowed: the feature soft-degrades to no routes.
  if (providers == null || typeof providers !== 'object') return;
  // Must be a MAP keyed by provider id, not a YAML list — array indices would
  // pass the slug check and mount `/auth/sso/0/...`, silently wrong.
  if (Array.isArray(providers)) {
    problems.push({
      message: 'sso.providers must be a map keyed by provider id (e.g. `providers:` then `  google: {...}`), not a list.',
      path: ['sso', 'providers'],
      payload: {}
    });
    return;
  }

  for (const id of Object.keys(providers)) {
    const base = ['sso', 'providers', id];
    if (!SSO_PROVIDER_ID_RE.test(id)) {
      problems.push({
        message: `sso provider id '${id}' must be a url-safe slug (lowercase letters/digits, '-' or '_') — it appears in callback paths and platform field names.`,
        path: base,
        payload: { id }
      });
    }
    const provider = providers[id] || {};
    const issuer = provider.issuer;
    if (isMissingOrSentinel(issuer)) {
      problems.push({ message: `sso.providers.${id}.issuer is missing or unset.`, path: base.concat('issuer'), payload: { id } });
    } else {
      let parsed = null;
      try { parsed = new URL(issuer); } catch (e) { parsed = null; }
      if (parsed == null || parsed.protocol !== 'https:') {
        problems.push({
          message: `sso.providers.${id}.issuer must be a valid https URL. Got: ${JSON.stringify(issuer)}.`,
          path: base.concat('issuer'),
          payload: { id, issuer }
        });
      }
    }
    for (const key of ['clientId', 'clientSecret']) {
      if (isMissingOrSentinel(provider[key])) {
        problems.push({
          message: `sso.providers.${id}.${key} is missing or unset (required for a configured provider).`,
          path: base.concat(key),
          payload: { id }
        });
      }
    }
  }
}

// Registration email gate. When `account.emailVerification.requireAtRegistration`
// is true every registration needs a mailed code, so an incomplete mail
// configuration would block all sign-ups platform-wide. Refuse the boot instead
// of discovering it from the first failed registration.
function checkEmailVerificationGate (config, problems) {
  if (config.get('account:emailVerification:requireAtRegistration') !== true) return;
  const { describeMailCapability } = require('../../components/business/src/emails/mailCapability.ts');
  const capability = describeMailCapability(config);
  if (capability.ok) return;
  problems.push({
    message: "'account.emailVerification.requireAtRegistration: true' requires a complete mail configuration (every registration needs a mailed code): " +
      capability.problems.join('; ') + '. Fix services.email or set the gate to false.',
    path: ['account', 'emailVerification', 'requireAtRegistration'],
    payload: { method: capability.method, problems: capability.problems }
  });
}

// MFA settings that cannot work refuse the boot here, where the message is
// clear; the login-path normalizer stays non-throwing so a typo never bricks
// logins.
function checkMfaConfig (config, problems) {
  const { describeMfaConfig } = require('../../components/business/src/mfa/configCheck.ts');
  for (const p of describeMfaConfig(config.get('services:mfa')).problems) {
    problems.push({ message: 'MFA: ' + p.message, path: p.path, payload: {} });
  }
}

// hostedSites shape (names, exactly one of static/proxy, upstream loop, header
// allow-list, topology). The folder and username checks need the filesystem and
// the users database: the api-server runs them before it listens.
function checkHostedSites (config, problems) {
  const { describeHostedSites, hostedSitesInputFromConfig } = require('../../components/business/src/hostedSites.ts');
  for (const message of describeHostedSites(hostedSitesInputFromConfig(config)).problems) {
    problems.push({ message, path: ['hostedSites'], payload: {} });
  }
}

// http.trustedProxies: every entry must compile (IP, CIDR or a proxy-addr name).
function checkTrustedProxies (config, problems) {
  const { checkTrustedProxiesConfig } = require('../../components/middleware/src/clientIp.ts');
  for (const p of checkTrustedProxiesConfig(config.get('http:trustedProxies'), config.get('cluster:hfsWorkers')).problems) {
    problems.push({ message: p.message, path: p.path, payload: {} });
  }
}

// webhooks.allowedPrivateHosts entries (host names, IPs, CIDR ranges) and
// webhooks.requestTimeoutMs.
function checkWebhooks (config, problems) {
  const { describeWebhooksConfig } = require('../../components/business/src/webhooks/destination.ts');
  for (const p of describeWebhooksConfig(config.get('webhooks')).problems) {
    problems.push({ message: p.message, path: p.path, payload: {} });
  }
}

// core.id becomes a DNS label and the host of derived core URLs; on a
// multi-core deployment core.url is where peers send the admin key.
function checkCoreIdentity (config, problems) {
  const { coreIdProblem, peerUrlProblem, insecurePeerUrlAllowed } = require('../../components/platform/src/coreIdentity.ts');
  const coreId = config.get('core:id');
  if (coreId != null) {
    const problem = coreIdProblem(coreId);
    if (problem != null) problems.push({ message: problem + '.', path: ['core', 'id'], payload: { coreId } });
  }
  if (config.get('core:isSingleCore') !== false) return;
  const coreUrl = config.get('core:url');
  if (coreUrl == null || coreUrl === '') return;
  const problem = peerUrlProblem(coreUrl, { allowInsecure: insecurePeerUrlAllowed(config) });
  if (problem != null) problems.push({ message: problem + '.', path: ['core', 'url'], payload: { coreUrl } });
}

// Inside the published image (PRYV_IMAGE_TAG is baked into it), refuse to boot
// when the user data root (per-user databases, attachments, SQLite audit and
// series) would sit on the container's own filesystem or on a tmpfs: it would
// be lost when the container is recreated. Only the mount the path lands on is
// checked; a named volume, a bind mount or an anonymous volume all count as
// mounted. Raw installs never see PRYV_IMAGE_TAG, where "mount point /" is a
// real disk, so the check must stay behind it.
function checkUserDataRootPersistence (config, problems, deps = {}) {
  const env = deps.env || process.env;
  if (typeof env.PRYV_IMAGE_TAG !== 'string' || env.PRYV_IMAGE_TAG === '') return;
  if (env.PRYV_EPHEMERAL_DATA_OK === 'true') return;
  const engines = {
    base: config.get('storages:base:engine'),
    file: config.get('storages:file:engine'),
    audit: config.get('storages:audit:engine'),
    series: config.get('storages:series:engine')
  };
  const usesRoot = engines.base === 'sqlite' || engines.file === 'filesystem' ||
    engines.audit === 'sqlite' || engines.series === 'sqlite';
  if (!usesRoot) return;
  const rootSetting = config.get('storages:engines:sqlite:path');
  if (typeof rootSetting !== 'string' || rootSetting === '') return;
  let mountinfo;
  try {
    mountinfo = (deps.readMountinfo || (() => fs.readFileSync('/proc/self/mountinfo', 'utf8')))();
  } catch (err) {
    logger?.debug('user data root check skipped, mount table unreadable: ' + (err instanceof Error ? err.message : String(err)));
    return;
  }
  const dataRoot = path.resolve(rootSetting);
  let best = null;
  for (const line of mountinfo.split('\n')) {
    if (line === '') continue;
    const fields = line.split(' ');
    const separator = fields.indexOf('-', 6);
    if (fields.length < 5 || separator === -1) continue;
    const mountPoint = fields[4].replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    const covers = mountPoint === '/' || dataRoot === mountPoint || dataRoot.startsWith(mountPoint + '/');
    // On equal length the later line wins: a later mount shadows an earlier one at the same point.
    if (covers && (best == null || mountPoint.length >= best.mountPoint.length)) {
      best = { mountPoint, fstype: fields[separator + 1] };
    }
  }
  if (best == null || (best.mountPoint !== '/' && best.fstype !== 'tmpfs')) return;
  problems.push({
    message: `user data root 'storages.engines.sqlite.path' (${dataRoot}) is on the container's ephemeral filesystem (${best.mountPoint}, ${best.fstype}): per-user databases, attachments and the SQLite audit log written there are lost when the container is recreated. Point it at a mounted volume, e.g. 'storages.engines.sqlite.path: /app/data/users' with '-v /host/pryv/data:/app/data', or set PRYV_EPHEMERAL_DATA_OK=true for a throwaway container.`,
    path: ['storages', 'engines', 'sqlite', 'path'],
    payload: { path: dataRoot, mountPoint: best.mountPoint, fstype: best.fstype, engines }
  });
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
  checkTrustedApps(config, problems);
  checkAuditOnUserDeleteMode(config, problems);
  checkDnsTopologyConsistency(config, problems);
  checkPlatformEngineTopology(config, problems);
  checkSeriesEngineDependency(config, problems);
  checkSsoConfig(config, problems);
  checkEmailVerificationGate(config, problems);
  checkMfaConfig(config, problems);
  checkHostedSites(config, problems);
  checkTrustedProxies(config, problems);
  checkWebhooks(config, problems);
  checkUserDataRootPersistence(config, problems);
  checkCoreIdentity(config, problems);

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
    // sentinels on fields they don't use (e.g. letsEncrypt.atRestKey
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

/**
 * Report all validation problems to BOTH the boiler logger and stderr.
 *
 * The logger's only sink is the configured log file, which on a fresh deploy
 * may not exist yet / be unwritable - the logger then silently swallows the
 * writes and the operator sees a bare `exit 1` with no diagnostics. Mirroring
 * to stderr unconditionally guarantees the problems reach the operator
 * (terminal, systemd journal, container stdout) even when the file sink is
 * dead. Does NOT exit - the caller decides that.
 */
function reportProblems (problems) {
  if (logger == null) logger = getLogger('validate-config');
  const header = `Configuration is invalid — ${problems.length} problem(s) found:`;
  logger.error(header);
  process.stderr.write('[config-validation] ' + header + '\n');
  for (const p of problems) {
    logger.error(formatProblem(p), p.payload);
    process.stderr.write('[config-validation] ' + formatProblem(p) + '\n');
  }
}

/**
 * Non-fatal configuration findings. Logged at every boot; never stop the boot.
 *
 * These are settings that leave a shipped-on feature unable to work. The
 * operator did not ask for the feature, so refusing the boot would punish an
 * upgrade; saying nothing would leave the feature silently dead.
 */
function collectWarnings (config) {
  const warnings = [];
  const {
    describeVerificationMail,
    describeMailCapability
  } = require('../../components/business/src/emails/mailCapability.ts');
  const status = describeVerificationMail(config);
  if (!status.enabled && status.reason !== 'disabled' &&
      !(status.explicit && status.reason === 'missing-page-url')) {
    const why = status.reason === 'missing-page-url'
      ? "'auth.emailVerificationPageURL' is not set"
      : "'services.email' is incomplete (" + describeMailCapability(config).problems.join('; ') + ')';
    warnings.push('email verification is on by default but ' + why +
      ': verification mails are not sent and account email addresses cannot be proved. ' +
      'Set the missing keys (the page is the /verify-email route of your auth UI), or set ' +
      "'services.email.enabled.verifyEmail: false' to turn the feature off explicitly.");
  }
  const { describeMfaConfig } = require('../../components/business/src/mfa/configCheck.ts');
  warnings.push(...describeMfaConfig(config.get('services:mfa')).warnings);
  const { describeHostedSites, hostedSitesInputFromConfig } = require('../../components/business/src/hostedSites.ts');
  warnings.push(...describeHostedSites(hostedSitesInputFromConfig(config)).warnings);
  const { checkTrustedProxiesConfig } = require('../../components/middleware/src/clientIp.ts');
  warnings.push(...checkTrustedProxiesConfig(config.get('http:trustedProxies'), config.get('cluster:hfsWorkers')).warnings);
  return warnings;
}

module.exports = {
  load: async function (store) {
    logger = getLogger('validate-config');
    for (const warning of collectWarnings(store)) {
      logger.warn(warning);
    }
    const problems = await validate(store);
    if (problems.length === 0) return;
    reportProblems(problems);
    process.exit(1);
  },
  // Exported for unit testing — kept stable so [CV-REQ] / future tests can
  // exercise the validator without booting the boiler init lifecycle.
  validate,
  reportProblems,
  collectWarnings,
  checkRequiredWhen,
  checkTrustedApps,
  checkAuditOnUserDeleteMode,
  checkDnsTopologyConsistency,
  checkPlatformEngineTopology,
  checkSeriesEngineDependency,
  checkSsoConfig,
  checkEmailVerificationGate,
  checkMfaConfig,
  checkHostedSites,
  checkTrustedProxies,
  checkUserDataRootPersistence,
  checkCoreIdentity,
  isMissingOrSentinel,
  weakSecretReason,
  MIN_SECRET_LENGTH,
  REQUIRED_WHEN,
  AUDIT_ON_USER_DELETE_MODES
};
