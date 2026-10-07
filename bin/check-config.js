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

let config;
try {
  config = yaml.load(fs.readFileSync(absPath, 'utf8'));
} catch (e) {
  console.error(`check-config: failed to parse YAML: ${e.message}`);
  process.exit(1);
}

function get (dottedPath, from = config) {
  return dottedPath.split('.').reduce((obj, key) => (obj == null ? obj : obj[key]), from);
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
const baseLayerNote = baseLayer != null
  ? `Base layer: NODE_ENV=${nodeEnv}, so boot without --config adds ${baseLayerName} under this file (and default-config.yml under both).`
  : `Base layer: none (NODE_ENV=${nodeEnv || '<unset>'} has no config file); boot adds only default-config.yml under this file.`;

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
// the server). The base layer may supply it.
{
  const { parseTrustedApps } = require('../components/business/src/auth/trustedApps.ts');
  const own = get('auth.trustedApps');
  const value = own != null ? own : get('auth.trustedApps', baseLayer);
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

// auth.emailVerificationPageURL — a PROBLEM only when the checked file
// EXPLICITLY enables the verify-email sub-feature. The shipped default is now
// `verifyEmail: true`, but this script reads the override standalone, without
// the default merge: a file that never mentions the key inherits the default,
// where a missing page URL is a warning (see below) rather than a refusal.
// The scalar case matters: `enabled: true` (not an object) enables every message
// class at runtime, so it does require the URL.
{
  const emailEnabled = get('services.email.enabled');
  let verifyEmailNeeded = false;
  if (emailEnabled === true) verifyEmailNeeded = true;
  if (emailEnabled && typeof emailEnabled === 'object' && emailEnabled.verifyEmail === true) verifyEmailNeeded = true;
  if (verifyEmailNeeded && isMissingOrSentinel(get('auth.emailVerificationPageURL'))) {
    problems.push('auth.emailVerificationPageURL missing or unset (required when services.email.enabled.verifyEmail is true)');
  }
}

// Default-on email verification: when the checked file does not mention
// verifyEmail, the shipped default (true) applies. A missing page URL then
// degrades the feature to off with a boot warning rather than a refusal.
{
  const emailEnabled = get('services.email.enabled');
  const explicit = emailEnabled === true ||
    (emailEnabled && typeof emailEnabled === 'object' && emailEnabled.verifyEmail !== undefined);
  if (emailEnabled !== false && !explicit && isMissingOrSentinel(get('auth.emailVerificationPageURL'))) {
    warnings.push('auth.emailVerificationPageURL missing or unset: email verification is on by default and stays off (with a warning at every boot) until this URL is set. Set it to the /verify-email page of your auth UI, or set services.email.enabled.verifyEmail: false.');
  }
}

// account.emailVerification.requireAtRegistration: the registration email
// gate mails a code on every sign-up, so it needs a complete mail config.
// This script reads the override standalone, without the default merge, so a
// missing `services.email.method` means "inherits the default (in-process)"
// and cannot be checked further here; the boot-time validator sees the merged
// config and catches that case.
if (get('account.emailVerification.requireAtRegistration') === true) {
  const method = get('services.email.method');
  if (get('services.email.enabled') === false) {
    problems.push('account.emailVerification.requireAtRegistration is true but services.email.enabled is false');
  }
  if (method === 'in-process') {
    for (const key of ['smtp.host', 'from.address']) {
      if (isMissingOrSentinel(get(`services.email.${key}`))) {
        problems.push(`services.email.${key} missing or unset (required by the registration email gate with method in-process)`);
      }
    }
  } else if (method === 'microservice' || method === 'mandrill') {
    for (const key of ['url', 'key']) {
      if (isMissingOrSentinel(get(`services.email.${key}`))) {
        problems.push(`services.email.${key} missing or unset (required by the registration email gate with method ${method})`);
      }
    }
  } else if (method != null) {
    problems.push(`services.email.method="${method}" but only in-process, microservice or mandrill are supported`);
  }
}

// letsEncrypt.* — required when letsEncrypt.enabled is true
if (get('letsEncrypt.enabled') === true) {
  for (const key of ['atRestKey', 'email']) {
    if (isMissingOrSentinel(get(`letsEncrypt.${key}`))) {
      problems.push(`letsEncrypt.${key} missing or unset (required when letsEncrypt.enabled is true)`);
    }
  }
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
// at runtime, so for a dns-active config it must be explicitly false in
// the file — absent is just as broken as true.
if (get('dns.active') === true && get('dnsLess.isActive') !== false) {
  problems.push('dns.active is true but dnsLess.isActive is not explicitly false — ' +
    'the API would route path-style and reserved subdomains (reg/access/mfa) plus ' +
    'per-user subdomains would misroute. Add `dnsLess:\n  isActive: false`');
}

// storages.base.engine + matching engine config block
if (isMissingOrSentinel(get('storages.base.engine'))) {
  problems.push('storages.base.engine missing or unset');
} else if (get('storages.base.engine') === 'postgresql') {
  for (const key of ['host', 'port', 'database', 'user', 'password']) {
    if (isMissingOrSentinel(get(`storages.engines.postgresql.${key}`))) {
      problems.push(`storages.engines.postgresql.${key} missing or unset`);
    }
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

// dnsLess.isActive XOR dns.active — server cannot route without at least one
{
  const dnsLessOn = get('dnsLess.isActive') === true;
  const dnsOn = get('dns.active') === true;
  if (!dnsLessOn && !dnsOn) {
    problems.push('Neither dnsLess.isActive nor dns.active is true — server cannot resolve user → core');
  }
  if (dnsLessOn && isMissingOrSentinel(get('dnsLess.publicUrl'))) {
    problems.push('dnsLess.publicUrl missing or unset (required when dnsLess.isActive)');
  }
  if (dnsOn && isMissingOrSentinel(get('dns.domain'))) {
    problems.push('dns.domain missing or unset (required when dns.active)');
  }
}

// hostedSites: shape only (this script has no database and does not read the
// site folders; master.js checks the folders and the usernames at boot).
if (get('hostedSites') != null) {
  try {
    const { describeHostedSites } = require('../components/business/src/hostedSites.ts');
    const staticEntries = get('dns.staticEntries');
    const report = describeHostedSites({
      hostedSites: get('hostedSites'),
      domain: get('dns.domain') || null,
      // dnsLess.isActive defaults to true at runtime (see the topology check above)
      dnsLessActive: get('dnsLess.isActive') !== false,
      publicUrl: get('dnsLess.publicUrl') || null,
      coreId: get('core.id') || null,
      staticEntryNames: (staticEntries && typeof staticEntries === 'object') ? Object.keys(staticEntries) : []
    });
    for (const p of report.problems) problems.push(p);
    for (const w of report.warnings) warnings.push(w);
  } catch (err) {
    warnings.push(`hostedSites could not be checked here (${err.message}); master.js still checks it at boot.`);
  }
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

// services.mfa — the same check master.js runs at boot. The override is merged
// over the shipped defaults first, as at boot, so a partial block is judged by
// the configuration it actually produces.
if (get('services.mfa') != null) {
  try {
    const defaults = yaml.load(fs.readFileSync(path.join(__dirname, '../config/default-config.yml'), 'utf8'));
    const merge = (base, over) => {
      if (over == null || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
      const out = Object.assign({}, (base != null && typeof base === 'object' && !Array.isArray(base)) ? base : {});
      for (const k of Object.keys(over)) out[k] = merge(out[k], over[k]);
      return out;
    };
    const { describeMfaConfig } = require('../components/business/src/mfa/configCheck.ts');
    const mfa = describeMfaConfig(merge(defaults.services && defaults.services.mfa, get('services.mfa')));
    for (const p of mfa.problems) problems.push(`${p.path.join('.')}: ${p.message}`);
    for (const w of mfa.warnings) warnings.push(w);
  } catch (err) {
    warnings.push(`services.mfa could not be checked here (${err.message}); master.js still checks it at boot.`);
  }
}

// http.trustedProxies: the same check master.js runs at boot (every entry an
// IP, a CIDR or a proxy-addr name; loopback needed while HFS workers run).
if (get('http.trustedProxies') != null) {
  try {
    const { checkTrustedProxiesConfig } = require('../components/middleware/src/clientIp.ts');
    const hfsWorkers = get('cluster.hfsWorkers') ?? 1; // shipped default
    const report = checkTrustedProxiesConfig(get('http.trustedProxies'), hfsWorkers);
    for (const p of report.problems) problems.push(p.message);
    for (const w of report.warnings) warnings.push(w);
  } catch (err) {
    warnings.push(`http.trustedProxies could not be checked here (${err.message}); master.js still checks it at boot.`);
  }
}

// core.id grammar and, on a multi-core config (dnsLess off), core.url as a
// peer URL (mirrors checkCoreIdentity in config/plugins/config-validation.js).
// Raft TLS is reported as a warning when core.ip is set (multi-core).
{
  const { coreIdProblem, peerUrlProblem } = require('../components/platform/src/coreIdentity.ts');
  if (get('core.id') != null) {
    const p = coreIdProblem(get('core.id'));
    if (p != null) problems.push(p);
  }
  if (get('core.url') && get('dnsLess.isActive') === false) {
    const p = peerUrlProblem(get('core.url'), { allowInsecure: get('cluster.allowInsecurePeerUrl') === true });
    if (p != null) problems.push(p);
  }
  if (get('core.ip') && get('storages.engines.rqlite.external') !== true && get('storages.engines.rqlite.tls') == null) {
    warnings.push('core.ip is set (multi-core) but storages.engines.rqlite.tls is not: the Raft channel is not authenticated; ' +
      'a later release will refuse to start a multi-core node without it (see SINGLE-TO-MULTIPLE.md).');
  }
}

// summary
if (problems.length > 0) {
  console.error(`✗ ${absPath}`);
  console.error(`  ${baseLayerNote}`);
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
console.log('  All required-at-boot checks passed.');
if (warnings.length > 0) {
  console.log(`  ${warnings.length} warning(s):`);
  warnings.forEach(w => console.log(`    ⚠ ${w}`));
}
console.log('  Note: this is a structural check, not a runtime check — it does not contact PostgreSQL, rqlite, or Let\'s Encrypt.');
process.exit(0);
