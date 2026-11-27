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
import { describeAdminConfig, readAdminConfig, adminMfaRequired, portalUrl, portalSettings, portalServiceInfo, setupPageUrl } from '../../src/admin/config.ts';

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
    assert.equal(v.portal.url, null);
    assert.deepEqual(v.portal.spaces, ['admin', 'developer']);
    assert.deepEqual(v.portal.modules, { disabled: [], order: [] });
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

  it('[ADCF8] portal.url, portal.spaces and portal.modules: valid values are kept, invalid ones are problems', function () {
    const ok = config({
      'portal:url': 'https://portal.example.com/',
      'portal:spaces': ['admin'],
      'portal:modules:disabled': ['users', 'x-example', 'users'],
      'portal:modules:order': ['overview', 'config-effective']
    });
    assert.deepEqual(messages(ok), []);
    const v = readAdminConfig(ok).portal;
    assert.equal(v.url, 'https://portal.example.com/');
    assert.deepEqual(v.spaces, ['admin']);
    assert.deepEqual(v.modules, { disabled: ['users', 'x-example'], order: ['overview', 'config-effective'] });

    for (const bad of ['ftp://portal.example.com/', 'portal.example.com', 'https://u:p@portal.example.com/', 'https://portal.example.com/?a=1', 7]) {
      assert.match(messages(config({ 'portal:url': bad })).join('\n'), /^portal\.url must be/m, String(bad));
    }
    const sites = { admin: { proxy: 'https://example.github.io/portal/' } };
    const both = config({ 'portal:url': 'https://portal.example.com/', 'portal:site': 'admin', hostedSites: sites });
    assert.match(messages(both)[0], /portal\.url and portal\.site are both set/);
    assert.equal(describeAdminConfig(both).value.portal.url, null, 'the gate then knows the site origin only');
    assert.equal(describeAdminConfig(both).value.portal.site, 'admin');
    // One published form: lower-case host, a path.
    assert.equal(readAdminConfig(config({ 'portal:url': 'HTTPS://Portal.Example.com' })).portal.url, 'https://portal.example.com/');
    for (const bad of [[], ['admin', 'admin'], ['admin', 'ops'], 'admin', [1]]) {
      assert.match(messages(config({ 'portal:spaces': bad }))[0], /^portal\.spaces must be/, JSON.stringify(bad));
    }
    for (const key of ['disabled', 'order']) {
      for (const bad of ['users', [''], ['a b'], [3], ['-x']]) {
        assert.match(messages(config({ ['portal:modules:' + key]: bad }))[0], new RegExp('^portal\\.modules\\.' + key + ' must be'), JSON.stringify(bad));
      }
    }
    // Invalid values fall back to the defaults.
    const fallback = describeAdminConfig(config({ 'portal:spaces': ['ops'], 'portal:modules:order': 'x' })).value.portal;
    assert.deepEqual(fallback.spaces, ['admin', 'developer']);
    assert.deepEqual(fallback.modules.order, []);
  });

  it('[ADCF9] the portal settings and the service info field follow the configuration', function () {
    const { PORTAL_CONTRACT } = require('../../src/admin/portalDefaults.ts');
    assert.deepEqual(portalSettings(config()), { contract: PORTAL_CONTRACT, spaces: ['admin', 'developer'], modules: { disabled: [], order: [] } });
    assert.deepEqual(portalSettings(config({ 'portal:spaces': ['developer'], 'portal:modules:disabled': ['users'] })),
      { contract: PORTAL_CONTRACT, spaces: ['developer'], modules: { disabled: ['users'], order: [] } });
    assert.equal(portalServiceInfo(config()), null, 'no portal configured');
    const sites = { admin: { proxy: 'https://example.github.io/portal/' } };
    // portal.site without a known address (no publicUrl, no dns.domain): absent.
    assert.equal(portalServiceInfo(config({ 'dnsLess:isActive': false, hostedSites: sites, 'portal:site': 'admin' })), null);
    assert.deepEqual(portalServiceInfo(config({ 'dnsLess:isActive': false, 'dns:domain': 'pryv.example.org', hostedSites: sites, 'portal:site': 'admin' })),
      { contract: PORTAL_CONTRACT, url: 'https://admin.pryv.example.org/' });
    const external = config({ 'portal:url': 'https://portal.example.com/' });
    assert.deepEqual(portalServiceInfo(external), { contract: PORTAL_CONTRACT, url: 'https://portal.example.com/' });
    assert.equal(portalUrl(external), 'https://portal.example.com/', 'its origin is the portal origin of the /system gate');
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
