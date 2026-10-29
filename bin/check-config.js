#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Validates an override-config.yml against the same REQUIRED / REQUIRED_WHEN
// rules master.js enforces at boot — without actually booting.
//
// Usage:
//   docker run --rm -v /host/config:/app/config \
//     pryvio/open-pryv.io check-config /app/config/override-config.yml
//
// Locally:
//   node bin/check-config.js /tmp/test-override.yml
//
// Exit 0 = all checks passed.  Exit 1 = at least one problem (printed).

'use strict';

const fs = require('fs');
const path = require('path');

let yaml;
try {
  yaml = require('js-yaml');
} catch (err) {
  console.error('check-config: js-yaml is required but not installed.');
  process.exit(1);
}

// Same secret rule as the boot validation, so the two can never disagree.
const { weakSecretReason } = require('../config/plugins/config-validation.js');

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: check-config <config-path>');
  process.exit(1);
}
const absPath = path.resolve(configPath);
if (!fs.existsSync(absPath)) {
  console.error(`check-config: file not found: ${absPath}`);
  process.exit(1);
}

let fileConfig;
try {
  fileConfig = yaml.load(fs.readFileSync(absPath, 'utf8'));
} catch (e) {
  console.error(`check-config: failed to parse YAML: ${e.message}`);
  process.exit(1);
}

function merge (base, over) {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Object.assign({}, (base != null && typeof base === 'object' && !Array.isArray(base)) ? base : {});
  for (const k of Object.keys(over)) out[k] = merge(out[k], over[k]);
  return out;
}

// Environment variables (`platform__piiHmacKey=...`) are read at boot with the
// same nconf options as here, below the override file and above the base layer.
// Docker deployments often supply secrets this way.
const envConfig = new (require('nconf').Provider)().env({ parseValues: true, separator: '__' }).get() || {};
const envKeys = Object.keys(process.env).filter((k) => /^[^_].*__/.test(k));
// A core joined to a cluster: `--bootstrap` wrote bootstrap-config.yml next to
// the operator's override-config.yml; boot loads it just below that file.
const bootstrapPath = path.join(path.dirname(absPath), 'bootstrap-config.yml');
let bootstrapConfig = null;
if (bootstrapPath !== absPath && fs.existsSync(bootstrapPath)) {
  try {
    bootstrapConfig = yaml.load(fs.readFileSync(bootstrapPath, 'utf8'));
  } catch (e) {
    console.error(`check-config: failed to parse ${bootstrapPath}: ${e.message}`);
    process.exit(1);
  }
}
// The base layer boot adds under this file when it runs as
// config/override-config.yml without `--config` (Docker image default):
// config/<NODE_ENV>-config.yml. With `--config <file>` no such layer is added.
const nodeEnv = process.env.NODE_ENV;
const baseLayerName = nodeEnv ? `config/${nodeEnv}-config.yml` : null;
const baseLayerPath = baseLayerName ? path.resolve(__dirname, '..', baseLayerName) : null;
let baseLayer = null;
if (baseLayerPath != null && fs.existsSync(baseLayerPath)) {
  try {
    baseLayer = yaml.load(fs.readFileSync(baseLayerPath, 'utf8'));
  } catch (e) {
    baseLayer = null;
  }
}

// The shipped defaults, the lowest layer at boot.
let defaultConfig;
try {
  defaultConfig = yaml.load(fs.readFileSync(path.join(__dirname, '../config/default-config.yml'), 'utf8'));
} catch (e) {
  console.error(`check-config: failed to read config/default-config.yml: ${e.message}`);
  process.exit(1);
}

// The layers in boot's order, lowest first: default-config.yml, the base
// layer, the environment, bootstrap-config.yml, then this file.
// `operatorConfig` is everything above the shipped defaults: the checks that
// depend on whether the operator set a key (rather than inheriting its
// default) read it, as boot does. Every other check reads `config`, the
// merged configuration boot runs with.
const operatorConfig = merge(merge(merge(baseLayer ?? undefined, envConfig), bootstrapConfig ?? undefined), fileConfig ?? undefined);
const config = merge(defaultConfig, operatorConfig);

function get (dottedPath, from = config) {
  return dottedPath.split('.').reduce((obj, key) => (obj == null ? obj : obj[key]), from);
}

// The boot-side helpers read keys through a config object (`a:b:c` keys).
const configReader = { get: (key) => get(key.split(':').join('.')) };
// Single or multi-core, decided as at boot: the core-identity plugin runs
// before boot loads default-config.yml, so it sees the operator's layers only.
const coreIdentity = require('../config/plugins/core-identity.js')
  .deriveCoreIdentity((key) => get(key.split(':').join('.'), operatorConfig));
const baseLayerNote = baseLayer != null
  ? `Base layer: NODE_ENV=${nodeEnv}, so boot without --config adds ${baseLayerName} under this file (and default-config.yml under both).`
  : `Base layer: none (NODE_ENV=${nodeEnv || '<unset>'} has no config file); boot adds only default-config.yml under this file.`;
const bootstrapNote = bootstrapConfig != null
  ? `Bootstrap layer: ${bootstrapPath} (written by --bootstrap) merged under this file, as at boot.`
  : null;
const envNote = envKeys.length > 0
  ? `Environment: ${envKeys.length} variable(s) merged under this file, as at boot (${envKeys.sort().join(', ')}).`
  : 'Environment: no `a__b` variables set; keys can also come from the environment at boot.';

function isMissingOrSentinel (v) {
  if (v == null) return true;
  if (typeof v !== 'string') return false;
  if (v === '') return true;
  if (v.includes('REPLACE')) return true;
  if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(v)) return true;
  return false;
}

const problems = [];
const warnings = [];

// Node runtime floor (engines.node is advisory only; master.js warns at boot).
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && (nodeMinor < 22 || (nodeMinor === 22 && nodePatch < 1)))) {
  problems.push(`Node.js ${process.version} is below 24.22.1 (security fixes of 2026-10-21): upgrade Node and run \`npm rebuild\`, see INSTALL.md "Node major bumps"`);
}

// service.* required (mirrors REQUIRED_SERVICE_FIELDS in config/plugins/config-validation.js)
const REQUIRED_SERVICE_FIELDS = ['name', 'serial', 'home', 'support', 'terms', 'eventTypes'];
for (const field of REQUIRED_SERVICE_FIELDS) {
  if (isMissingOrSentinel(get(`service.${field}`))) {
    problems.push(`service.${field} missing or unset`);
  }
}

// auth.* always-required secrets
for (const key of ['adminAccessKey', 'filesReadTokenSecret']) {
  const value = get(`auth.${key}`);
  if (isMissingOrSentinel(value)) {
    problems.push(`auth.${key} missing or unset`);
  } else if (weakSecretReason(value) != null) {
    problems.push(`auth.${key} ${weakSecretReason(value)}: set a long random value of your own`);
  } else if (weakSecretReason(value, { production: true }) != null) {
    warnings.push(`auth.${key} ${weakSecretReason(value, { production: true })}: a production core refuses to boot with it`);
  }
}

// auth.trustedApps — required at boot, every entry must parse (same parser as
// the server).
{
  const { parseTrustedApps } = require('../components/business/src/auth/trustedApps.ts');
  const value = get('auth.trustedApps');
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push("auth.trustedApps missing or empty (list your auth UI and app origins, e.g. '*@https://account.example.com')");
  } else {
    for (const error of parseTrustedApps(value).errors) problems.push(`auth.trustedApps: ${error}`);
  }
}

// auth.passwordResetPageURL — required unless services.email.enabled.resetPassword === false
{
  const emailEnabled = get('services.email.enabled');
  let resetPasswordNeeded = true;
  if (emailEnabled === false) resetPasswordNeeded = false;
  if (emailEnabled && typeof emailEnabled === 'object' && emailEnabled.resetPassword === false) resetPasswordNeeded = false;
  if (resetPasswordNeeded && isMissingOrSentinel(get('auth.passwordResetPageURL'))) {
    problems.push('auth.passwordResetPageURL missing or unset (required unless services.email.enabled.resetPassword is false)');
  }
}

// auth.emailVerificationPageURL, with boot's own predicate
// (describeVerificationMail): a PROBLEM only when the operator set
// `services.email.enabled.verifyEmail` themselves (mirrors REQUIRED_WHEN in
// config/plugins/config-validation.js). When the key is inherited from the
// shipped default (true), a missing page URL turns the feature off with a
// warning at every boot instead. Whether it is inherited is decided like
// boot's getScopeAndValue: the first layer, highest first, where the key
// resolves. A plain `services.email.enabled: true` holds no `verifyEmail`, so
// the key resolves in the defaults and is inherited, as at boot.
{
  const { describeVerificationMail } = require('../components/business/src/emails/mailCapability.ts');
  const layers = [['override-file', fileConfig], ['bootstrap-file', bootstrapConfig], ['env', envConfig],
    ['base', baseLayer], ['default-file', defaultConfig]];
  const scopedReader = {
    get: configReader.get,
    getScopeAndValue: (key) => {
      for (const [scope, layer] of layers) {
        if (layer == null) continue;
        const value = get(key.split(':').join('.'), layer);
        if (value !== undefined) return { value, scope, info: '' };
      }
      return null;
    }
  };
  const status = describeVerificationMail(scopedReader);
  if (status.reason === 'missing-page-url') {
    if (status.explicit) {
      problems.push('auth.emailVerificationPageURL missing or unset (required when services.email.enabled.verifyEmail is true)');
    } else {
      warnings.push('auth.emailVerificationPageURL missing or unset: email verification is on by default and stays off (with a warning at every boot) until this URL is set. Set it to the /verify-email page of your auth UI, or set services.email.enabled.verifyEmail: false.');
    }
  }
}

// account.emailVerification.requireAtRegistration: the registration email
// gate mails a code on every sign-up, so it needs a complete mail config
// (mirrors checkEmailVerificationGate in config/plugins/config-validation.js,
// with the same predicate).
if (get('account.emailVerification.requireAtRegistration') === true) {
  const { describeMailCapability } = require('../components/business/src/emails/mailCapability.ts');
  const capability = describeMailCapability(configReader);
  for (const p of capability.problems) {
    problems.push(p.endsWith('missing or unset')
      ? `${p} (required by the registration email gate with method ${capability.method})`
      : `account.emailVerification.requireAtRegistration is true but ${p}`);
  }
}

// platform.piiHmacKey: required when PlatformDB PII is hashed, the
// default-config value of platform.piiMode (mirrors REQUIRED_WHEN in
// config/plugins/config-validation.js)
{
  const piiMode = get('platform.piiMode');
  const key = get('platform.piiHmacKey');
  if (piiMode === 'hashed' && (typeof key !== 'string' || isMissingOrSentinel(key))) {
    problems.push('platform.piiHmacKey missing or unset (required when platform.piiMode is hashed, the default): ' +
      'base64 of 32 random bytes, the same value on every core');
  } else if (piiMode === 'hashed' && weakSecretReason(key) != null) {
    problems.push(`platform.piiHmacKey ${weakSecretReason(key)}: base64 of 32 random bytes of your own`);
  } else if (piiMode === 'hashed' && weakSecretReason(key, { production: true }) != null) {
    warnings.push(`platform.piiHmacKey ${weakSecretReason(key, { production: true })}: a production core refuses to boot with it`);
  }
}

// letsEncrypt.atRestKey — required when letsEncrypt.enabled is true
// (letsEncrypt.email is optional: the ACME account then has no contact)
if (get('letsEncrypt.enabled') === true && isMissingOrSentinel(get('letsEncrypt.atRestKey'))) {
  problems.push('letsEncrypt.atRestKey missing or unset (required when letsEncrypt.enabled is true)');
}
// ...but a placeholder left in it still stops the boot (REPLACE scan of enabled blocks)
const leEmail = get('letsEncrypt.email');
if (get('letsEncrypt.enabled') === true && typeof leEmail === 'string' && leEmail !== '' && isMissingOrSentinel(leEmail)) {
  problems.push('letsEncrypt.email holds a placeholder: set a real address or remove the key');
}

// sso.* — third-party sign-in (OIDC relying party). Mirrors checkSsoConfig +
// the sso.landingPageURL REQUIRED_WHEN in config/plugins/config-validation.js.
if (get('sso.enabled') === true) {
  if (get('dns.active') === true) {
    problems.push('sso.enabled is true but dns.active is also true — SSO is single-core / dnsLess only in this version; disable one of the two');
  }
  if (get('sharedSecrets.enabled') === false) {
    problems.push('sso.enabled is true but sharedSecrets.enabled is false — the sign-in callback hands the session token to the auth app via a one-time shared secret, never the URL; enable shared secrets or disable SSO');
  }
  const landingPageURL = get('sso.landingPageURL');
  if (typeof landingPageURL === 'string' && landingPageURL.includes('#')) {
    problems.push('sso.landingPageURL must not contain a URL fragment ("#...") — the sign-in callback appends its result as a fragment and an existing one would corrupt it');
  }
  const callbackBaseURL = get('sso.callbackBaseURL');
  if (typeof callbackBaseURL === 'string' && callbackBaseURL !== '') {
    let cbOk = false;
    try { cbOk = new URL(callbackBaseURL).protocol === 'https:'; } catch (e) { cbOk = false; }
    if (!cbOk) problems.push('sso.callbackBaseURL must be a valid https URL when set');
  }
  const providers = get('sso.providers');
  if (Array.isArray(providers)) {
    problems.push('sso.providers must be a map keyed by provider id, not a list');
  }
  const providerIds = (providers && typeof providers === 'object' && !Array.isArray(providers)) ? Object.keys(providers) : [];
  if (providerIds.length > 0 && isMissingOrSentinel(get('sso.landingPageURL'))) {
    problems.push('sso.landingPageURL missing or unset (required when sso.enabled is true and providers are configured)');
  }
  const SSO_PROVIDER_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
  for (const id of providerIds) {
    if (!SSO_PROVIDER_ID_RE.test(id)) {
      problems.push(`sso.providers.${id}: id must be a url-safe slug (lowercase letters/digits, '-' or '_')`);
    }
    const issuer = get(`sso.providers.${id}.issuer`);
    if (isMissingOrSentinel(issuer)) {
      problems.push(`sso.providers.${id}.issuer missing or unset`);
    } else {
      let httpsOk = false;
      try { httpsOk = new URL(issuer).protocol === 'https:'; } catch (e) { httpsOk = false; }
      if (!httpsOk) problems.push(`sso.providers.${id}.issuer must be a valid https URL`);
    }
    for (const key of ['clientId', 'clientSecret']) {
      if (isMissingOrSentinel(get(`sso.providers.${id}.${key}`))) {
        problems.push(`sso.providers.${id}.${key} missing or unset (required for a configured provider)`);
      }
    }
  }
}

// DNS topology consistency (mirrors checkDnsTopologyConsistency in
// config/plugins/config-validation.js). dnsLess.isActive DEFAULTS to true
// (default-config.yml), so a dns-active config must set it to false: absent
// is just as broken as true.
if (get('dns.active') === true && get('dnsLess.isActive') !== false) {
  problems.push('dns.active is true but dnsLess.isActive is not explicitly false — ' +
    'the API would route path-style and reserved subdomains (reg/access/mfa) plus ' +
    'per-user subdomains would misroute. Add `dnsLess:\n  isActive: false`');
}

// storages.base.engine + matching engine config block. The engine and the
// connection settings default to a local PostgreSQL (default-config.yml). An
// empty password is accepted at boot (a server with trust or peer
// authentication needs none), so it is only a warning here; a placeholder left
// in it stops the boot.
if (isMissingOrSentinel(get('storages.base.engine'))) {
  problems.push('storages.base.engine missing or unset');
} else if (get('storages.base.engine') === 'postgresql') {
  for (const key of ['host', 'port', 'database', 'user']) {
    if (isMissingOrSentinel(get(`storages.engines.postgresql.${key}`))) {
      problems.push(`storages.engines.postgresql.${key} missing or unset`);
    }
  }
  const password = get('storages.engines.postgresql.password');
  if (password == null || password === '') {
    warnings.push('storages.engines.postgresql.password is empty: the core connects without a password, which only works when the PostgreSQL server trusts it (trust or peer authentication).');
  } else if (isMissingOrSentinel(password)) {
    problems.push('storages.engines.postgresql.password holds a placeholder: set the real password');
  }
}

// storages.series.engine: postgresql needs a PostgreSQL base engine (mirrors
// checkSeriesEngineDependency in config/plugins/config-validation.js). The
// series engine defaults to postgresql, so a file that only switches the base
// engine to SQLite is refused too.
{
  const baseEngine = get('storages.base.engine');
  const seriesEngine = get('storages.series.engine');
  if (!isMissingOrSentinel(baseEngine) && baseEngine !== 'postgresql' && seriesEngine === 'postgresql') {
    problems.push(`storages.series.engine=postgresql requires storages.base.engine: postgresql (got "${baseEngine}"); with a SQLite base set storages.series.engine: sqlite or influxdb (the series engine defaults to postgresql)`);
  }
}

// storages.platform.engine — rqlite (default, multi-core capable) or
// postgresql (single-core dnsLess diskless shape; mirrors
// checkPlatformEngineTopology in config/plugins/config-validation.js)
{
  const platformEngine = get('storages.platform.engine');
  if (platformEngine && platformEngine !== 'rqlite' && platformEngine !== 'postgresql') {
    problems.push(`storages.platform.engine="${platformEngine}" but only "rqlite" or "postgresql" are supported`);
  }
  if (platformEngine === 'postgresql') {
    if (get('dnsLess.isActive') !== true) {
      problems.push('storages.platform.engine=postgresql requires dnsLess.isActive: true (single-core only; multi-core keeps rqlite)');
    }
    if (get('storages.base.engine') !== 'postgresql') {
      problems.push('storages.platform.engine=postgresql requires storages.base.engine: postgresql (full PG mode)');
    }
    if (get('dns.active') === true) {
      problems.push('storages.platform.engine=postgresql cannot run with dns.active: true (embedded DNS implies multi-core / per-user subdomains)');
    }
    if (get('cluster.discoveryEnabled') === true) {
      problems.push('storages.platform.engine=postgresql cannot run with cluster.discoveryEnabled: true (multi-core rqlite discovery)');
    }
  }
}

// dnsLess.isActive or dns.active: a single core cannot route without at
// least one. A multi-core member (classified as boot does, see
// config/plugins/core-identity.js) may run neither: its per-user names are
// resolved by the embedded DNS of a peer core, or by an external DNS. Boot
// accepts that topology, so it is a warning there.
{
  const dnsLessOn = get('dnsLess.isActive') === true;
  const dnsOn = get('dns.active') === true;
  if (!dnsLessOn && !dnsOn) {
    if (coreIdentity.isSingleCore === false) {
      warnings.push('Neither dnsLess.isActive nor dns.active is true: this multi-core member runs no DNS of its own, ' +
        `so user → core resolution (per-user names under ${get('dns.domain') || 'the platform domain'}) must be served by a peer core's ` +
        'embedded DNS (dns.active: true there) or by an external DNS.');
    } else {
      problems.push('Neither dnsLess.isActive nor dns.active is true — server cannot resolve user → core');
    }
  }
  // A DNSless multi-core member (core.url set, dnsLess left to its default, the
  // shape `bootstrap new-core --url` writes) routes path-style without a
  // public URL of its own: boot derives its service URLs from core.url.
  if (dnsLessOn && coreIdentity.isSingleCore !== false && isMissingOrSentinel(get('dnsLess.publicUrl'))) {
    problems.push('dnsLess.publicUrl missing or unset (required when dnsLess.isActive)');
  }
  if (dnsOn && isMissingOrSentinel(get('dns.domain'))) {
    problems.push('dns.domain missing or unset (required when dns.active)');
  }
}

// hostedSites: shape only (this script has no database and does not read the
// site folders; master.js checks the folders and the usernames at boot).
try {
  const { describeHostedSites, hostedSitesInputFromConfig } = require('../components/business/src/hostedSites.ts');
  const report = describeHostedSites(hostedSitesInputFromConfig(configReader));
  for (const p of report.problems) problems.push(p);
  for (const w of report.warnings) warnings.push(w);
} catch (err) {
  warnings.push(`hostedSites could not be checked here (${err.message}); master.js still checks it at boot.`);
}

// access.defaultAuthUrl — not required at boot (master.js starts fine
// without it) but the /reg/access flow silently returns `authUrl: null`,
// which leaves every SDK unable to open the auth popup. Surface as a
// warning so hand-written configs that forgot this key are caught here
// instead of at the implementer's first sign-in attempt.
if (isMissingOrSentinel(get('access.defaultAuthUrl'))) {
  warnings.push('access.defaultAuthUrl missing or unset — /reg/access responses will carry authUrl=null, breaking SDK sign-in flows. Set this to the URL of your app-web-user-account deployment (e.g. https://account.pryv.me/auth).');
}

// service.account — the account app root, served in service info. Without it
// the sign-in button's "Manage my account" link has to guess the address from
// the auth page URL.
if (!isMissingOrSentinel(get('access.defaultAuthUrl')) && isMissingOrSentinel(get('service.account'))) {
  warnings.push('service.account is not set — clients cannot link to the account pages. Set it to the root URL of your app-web-user-account deployment (the access.defaultAuthUrl without its trailing /auth).');
}

// oauth.consentUrl: not required at boot (OAuth has no enable flag and a core
// that does not use it runs fine without it), but GET /oauth2/authorize answers
// 500 while it is empty. Same rule as the boot warning: reported whenever the
// OAuth routes mount, i.e. an issuer can be derived (oauth.issuer,
// dnsLess.publicUrl, or service.api, which dns.domain provides).
{
  const { CONSENT_URL_WARNING, isConsentUrlSet } = require('../components/oauth2/src/consentUrlCheck.ts');
  const oauthMounted = ['oauth.issuer', 'dnsLess.publicUrl', 'service.api', 'dns.domain']
    .some((key) => !isMissingOrSentinel(get(key)));
  const consentUrl = get('oauth.consentUrl');
  if (oauthMounted && (!isConsentUrlSet(consentUrl) || isMissingOrSentinel(consentUrl))) {
    warnings.push(CONSENT_URL_WARNING);
  }
}

// services.mfa: the same check master.js runs at boot, on the merged
// configuration: a partial block is judged by the configuration it produces.
try {
  const { describeMfaConfig } = require('../components/business/src/mfa/configCheck.ts');
  const mfa = describeMfaConfig(get('services.mfa'));
  for (const p of mfa.problems) problems.push(`${p.path.join('.')}: ${p.message}`);
  for (const w of mfa.warnings) warnings.push(w);
} catch (err) {
  warnings.push(`services.mfa could not be checked here (${err.message}); master.js still checks it at boot.`);
}

// account.autoDeletion: the same check master.js runs at boot, judged on the
// configuration the file produces over the shipped defaults.
if (get('account.autoDeletion') != null) {
  try {
    const defaults = yaml.load(fs.readFileSync(path.join(__dirname, '../config/default-config.yml'), 'utf8'));
    const effective = merge(defaults, config);
    const reader = { get: (key) => get(key.replace(/:/g, '.'), effective) };
    const { describeAutoDeletionConfig } = require('../components/business/src/autoDeletion/config.ts');
    const { describeMailCapability } = require('../components/business/src/emails/mailCapability.ts');
    const report = describeAutoDeletionConfig(get('account.autoDeletion'), {
      accessTrackingActive: get('accessTracking.isActive', effective) !== false,
      mailOk: describeMailCapability(reader).ok,
      accountAppSet: !isMissingOrSentinel(get('service.account', effective))
    });
    for (const p of report.problems) problems.push(`${p.path.join('.')}: ${p.message}`);
    for (const w of report.warnings) warnings.push(w);
  } catch (err) {
    warnings.push(`account.autoDeletion could not be checked here (${err.message}); master.js still checks it at boot.`);
  }
}

// http.trustedProxies: the same check master.js runs at boot (every entry an
// IP, a CIDR or a proxy-addr name; loopback needed while HFS workers run).
try {
  const { checkTrustedProxiesConfig } = require('../components/middleware/src/clientIp.ts');
  const report = checkTrustedProxiesConfig(get('http.trustedProxies'), get('cluster.hfsWorkers'));
  for (const p of report.problems) problems.push(p.message);
  for (const w of report.warnings) warnings.push(w);
} catch (err) {
  warnings.push(`http.trustedProxies could not be checked here (${err.message}); master.js still checks it at boot.`);
}

// core.id grammar and, on a multi-core member, its core URL (explicit or
// derived) as a peer URL (mirrors checkCoreIdentity in
// config/plugins/config-validation.js).
// A multi-core node (core.ip set) that spawns its own rqlited without Raft TLS
// is a problem: the node refuses to start (same rule as the boot validation).
{
  const { coreIdProblem, peerUrlProblem, insecurePeerUrlAllowed } = require('../components/platform/src/coreIdentity.ts');
  if (get('core.id') != null) {
    const p = coreIdProblem(get('core.id'));
    if (p != null) problems.push(p);
  }
  if (coreIdentity.isSingleCore === false && coreIdentity.coreUrl) {
    const p = peerUrlProblem(coreIdentity.coreUrl, { allowInsecure: insecurePeerUrlAllowed(configReader) });
    if (p != null) problems.push(p);
  }
  const { raftTlsProblem } = require('../storages/engines/rqlite/src/rqliteProcess.ts');
  const raftProblem = raftTlsProblem({
    coreIp: get('core.ip'),
    tls: get('storages.engines.rqlite.tls'),
    external: get('storages.engines.rqlite.external'),
    platformEngine: get('storages.platform.engine')
  });
  if (raftProblem != null) problems.push(raftProblem);
}

// integrity.algorithm: the checksums of events, accesses and attachments;
// md5 and sha1 are refused (mirrors checkIntegrityAlgorithm in
// config/plugins/config-validation.js).
{
  const algorithm = get('integrity.algorithm');
  const { integrityAlgorithmProblem } = require('../components/business/src/integrity/algorithms.ts');
  const p = integrityAlgorithmProblem(algorithm);
  if (p != null) problems.push(p);
}

// custom.systemStreams: the same loader boot runs (config/plugins/systemStreams),
// which refuses an invalid custom stream and any "other" stream.
{
  const value = get('custom.systemStreams');
  if (value != null) {
    const store = new (require('nconf').Provider)();
    store.use('memory');
    store.set('custom:systemStreams', value);
    try {
      require('../config/plugins/systemStreams').load(store);
    } catch (e) {
      problems.push(e.message);
    }
  }
}

// storages.engines.rqlite.url: the spawned rqlited's HTTP API listens on
// 127.0.0.1 unless httpBindAddr is set, so the core's own client must use loopback.
{
  const url = get('storages.engines.rqlite.url');
  const platformEngine = get('storages.platform.engine') || 'rqlite';
  if (platformEngine === 'rqlite' && url != null &&
      get('storages.engines.rqlite.external') !== true &&
      get('storages.engines.rqlite.httpBindAddr') == null) {
    let host = null;
    let port = '4001';
    try {
      const u = new URL(url);
      host = u.hostname;
      if (u.port) port = u.port;
    } catch (e) { /* reported below */ }
    if (host !== '127.0.0.1' && host !== 'localhost') {
      warnings.push(`storages.engines.rqlite.url="${url}" is not a loopback address, but rqlite's HTTP API listens on 127.0.0.1 ` +
        `unless storages.engines.rqlite.httpBindAddr is set: the core would not reach its platform database. Use http://127.0.0.1:${port}.`);
    }
  }
}

// summary
if (problems.length > 0) {
  console.error(`✗ ${absPath}`);
  console.error(`  ${baseLayerNote}`);
  console.error(`  ${envNote}`);
  if (bootstrapNote != null) console.error(`  ${bootstrapNote}`);
  console.error(`  ${problems.length} problem(s):`);
  problems.forEach(p => console.error(`    - ${p}`));
  if (warnings.length > 0) {
    console.error(`  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.error(`    ⚠ ${w}`));
  }
  process.exit(1);
}

console.log(`✓ ${absPath}`);
console.log(`  ${baseLayerNote}`);
console.log(`  ${envNote}`);
if (bootstrapNote != null) console.log(`  ${bootstrapNote}`);
console.log('  All required-at-boot checks passed.');
if (warnings.length > 0) {
  console.log(`  ${warnings.length} warning(s):`);
  warnings.forEach(w => console.log(`    ⚠ ${w}`));
}
console.log('  Note: this is a structural check, not a runtime check — it does not contact PostgreSQL, rqlite, or Let\'s Encrypt.');
process.exit(0);
