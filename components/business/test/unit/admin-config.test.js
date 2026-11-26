/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADCF] the setup and administration keys: defaults, validation (portal.site
 * must name a configured hosted site), derived addresses, and the boot-time
 * config validation entry.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describeAdminConfig, readAdminConfig, adminMfaRequired, portalUrl, setupPageUrl } from '../../src/admin/config.ts';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = yaml.load(fs.readFileSync(path.resolve(here, '../../../../config/default-config.yml'), 'utf8'));

/** A config reader over the shipped defaults with `overrides` (keys `a:b:c`) on top. */
function config (overrides = {}) {
  return {
    get (key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
      return key.split(':').reduce((o, k) => (o == null ? undefined : o[k]), DEFAULTS);
    }
  };
}

function messages (c) {
  return describeAdminConfig(c).problems.map((p) => p.message);
}

describe('[ADCF] setup and administration configuration', function () {
  it('[ADCF1] the shipped defaults are valid: full key scope, no portal, 24 h codes, 60 min sessions', function () {
    assert.deepEqual(messages(config()), []);
    const v = readAdminConfig(config());
    assert.equal(v.adminAccessKeyScope, 'full');
    assert.equal(v.portal.site, null);
    assert.deepEqual(v.portal.allowedOrigins, []);
    assert.equal(v.setup.codeTtlMs, 24 * 3600 * 1000);
    assert.equal(v.setup.codeHash, null);
    assert.equal(v.setup.printCode, true);
    assert.equal(v.setup.registrationWhilePending, 'closed');
    assert.equal(v.session.ttlMs, 60 * 60 * 1000);
    assert.equal(v.session.stepUpMs, 5 * 60 * 1000);
    assert.equal(v.session.requireMfa, true);
  });

  it('[ADCF2] portal.site must name a configured hosted site', function () {
    assert.match(messages(config({ 'portal:site': 'admin' }))[0], /portal\.site names the hosted site 'admin', which is not configured/);
    const sites = { admin: { proxy: 'https://example.github.io/portal/' } };
    assert.deepEqual(messages(config({ 'portal:site': 'Admin', hostedSites: sites })), []);
    assert.equal(readAdminConfig(config({ 'portal:site': 'Admin', hostedSites: sites })).portal.site, 'admin');
    assert.equal(messages(config({ 'portal:site': 7 })).length, 1);
  });

  it('[ADCF3] values out of range or of the wrong kind are refused, each naming its key', function () {
    const bad = messages(config({
      'portal:cors:allowedOrigins': ['https://ok.example', 'https://x.example/path', 'ftp://y.example'],
      'setup:codeTtlHours': 0,
      'setup:codeHash': 'abc',
      'setup:printCode': 'maybe',
      'setup:registrationWhilePending': 'ajar',
      'auth:adminAccessKeyScope': 'some',
      'admin:session:ttlMinutes': 1.5,
      'admin:session:stepUpMinutes': 0,
      'admin:session:requireMfa': 'no'
    }));
    for (const key of ['portal.cors.allowedOrigins', 'setup.codeTtlHours', 'setup.codeHash', 'setup.printCode',
      'setup.registrationWhilePending', 'auth.adminAccessKeyScope', 'admin.session.ttlMinutes',
      'admin.session.stepUpMinutes', 'admin.session.requireMfa']) {
      assert.ok(bad.some((m) => m.startsWith(key + ' ')), key + ' in ' + JSON.stringify(bad));
    }
    assert.equal(bad.filter((m) => m.startsWith('portal.cors.allowedOrigins')).length, 2, 'one problem per bad origin');
    assert.throws(() => readAdminConfig(config({ 'auth:adminAccessKeyScope': 'some' })), /Invalid administration configuration/);
  });

  it('[ADCF4] environment-style strings are accepted; a supplied hash is normalized to lowercase', function () {
    const hash = 'AB'.repeat(32);
    const v = readAdminConfig(config({
      'setup:codeHash': hash, 'setup:printCode': 'false', 'setup:codeTtlHours': '2', 'admin:session:ttlMinutes': '30', 'auth:adminAccessKeyScope': 'break-glass'
    }));
    assert.equal(v.setup.codeHash, hash.toLowerCase());
    assert.equal(v.setup.printCode, false);
    assert.equal(v.setup.codeTtlMs, 2 * 3600 * 1000);
    assert.equal(v.session.ttlMs, 30 * 60 * 1000);
    assert.equal(v.adminAccessKeyScope, 'break-glass');
  });

  it('[ADCF5] MFA is required for administrators only when the platform has it on and requireMfa holds', function () {
    assert.equal(adminMfaRequired(config({ 'services:mfa': { active: true } })), true);
    assert.equal(adminMfaRequired(config({ 'services:mfa': { active: false } })), false);
    assert.equal(adminMfaRequired(config({ 'services:mfa': { active: true }, 'admin:session:requireMfa': false })), false);
  });

  it('[ADCF6] portal and setup page addresses follow the topology', function () {
    const sites = { admin: { proxy: 'https://example.github.io/portal/' } };
    const dnsLess = config({ 'dnsLess:isActive': true, 'dnsLess:publicUrl': 'https://pryv.example.com/', hostedSites: sites, 'portal:site': 'admin' });
    assert.equal(portalUrl(dnsLess), 'https://pryv.example.com/admin/');
    assert.equal(setupPageUrl(dnsLess), 'https://pryv.example.com/system/setup/');
    const dns = config({ 'dnsLess:isActive': false, 'dns:domain': 'pryv.example.org', 'core:url': 'https://core-1.pryv.example.org', hostedSites: sites, 'portal:site': 'admin' });
    assert.equal(portalUrl(dns), 'https://admin.pryv.example.org/');
    assert.equal(setupPageUrl(dns), 'https://core-1.pryv.example.org/system/setup/');
    assert.equal(portalUrl(config()), null, 'no portal configured');
  });

  it('[ADCF7] the boot-time validation reports the same problems', function () {
    const { checkAdminConfig } = require('../../../../config/plugins/config-validation.js');
    const problems = [];
    checkAdminConfig(config({ 'portal:site': 'admin' }), problems);
    assert.equal(problems.length, 1);
    assert.deepEqual(problems[0].path, ['portal', 'site']);
    const none = [];
    checkAdminConfig(config(), none);
    assert.deepEqual(none, []);
  });
});
