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

function get (dottedPath) {
  return dottedPath.split('.').reduce((obj, key) => (obj == null ? obj : obj[key]), config);
}

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
  if (isMissingOrSentinel(get(`auth.${key}`))) {
    problems.push(`auth.${key} missing or unset`);
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

// letsEncrypt.* — required when letsEncrypt.enabled is true
if (get('letsEncrypt.enabled') === true) {
  for (const key of ['atRestKey', 'email']) {
    if (isMissingOrSentinel(get(`letsEncrypt.${key}`))) {
      problems.push(`letsEncrypt.${key} missing or unset (required when letsEncrypt.enabled is true)`);
    }
  }
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

// storages.platform.engine must be rqlite (only supported value since Plan 25)
{
  const platformEngine = get('storages.platform.engine');
  if (platformEngine && platformEngine !== 'rqlite') {
    problems.push(`storages.platform.engine="${platformEngine}" but only "rqlite" is supported`);
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

// access.defaultAuthUrl — not required at boot (master.js starts fine
// without it) but the /reg/access flow silently returns `authUrl: null`,
// which leaves every SDK unable to open the auth popup. Surface as a
// warning so hand-written configs that forgot this key are caught here
// instead of at the implementer's first sign-in attempt.
if (isMissingOrSentinel(get('access.defaultAuthUrl'))) {
  warnings.push('access.defaultAuthUrl missing or unset — /reg/access responses will carry authUrl=null, breaking SDK sign-in flows. Set this to the URL of your app-web-auth3 deployment (e.g. https://pryv.github.io/app-web-auth3/access/access.html).');
}

// summary
if (problems.length > 0) {
  console.error(`✗ ${absPath}`);
  console.error(`  ${problems.length} problem(s):`);
  problems.forEach(p => console.error(`    - ${p}`));
  if (warnings.length > 0) {
    console.error(`  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.error(`    ⚠ ${w}`));
  }
  process.exit(1);
}

console.log(`✓ ${absPath}`);
console.log('  All required-at-boot checks passed.');
if (warnings.length > 0) {
  console.log(`  ${warnings.length} warning(s):`);
  warnings.forEach(w => console.log(`    ⚠ ${w}`));
}
console.log('  Note: this is a structural check, not a runtime check — it does not contact PostgreSQL, rqlite, or Let\'s Encrypt.');
process.exit(0);
