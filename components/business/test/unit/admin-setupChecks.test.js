/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADSC] the checks summary of the setup page: what blocks DNS delegation and
 * certificate issuance, per topology; no secret value in any check.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { setupChecks } from '../../src/admin/setupChecks.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = yaml.load(fs.readFileSync(path.resolve(here, '../../../../config/default-config.yml'), 'utf8'));
const NOW = Date.UTC(2026, 10, 26);

function config (overrides = {}) {
  return {
    get (key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
      return key.split(':').reduce((o, k) => (o == null ? undefined : o[k]), DEFAULTS);
    }
  };
}

function run (overrides, extra = {}) {
  const checks = setupChecks({ config: config(overrides), certificates: [], pendingMigrations: 0, now: NOW, ...extra });
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

const DNS = { 'dnsLess:isActive': false, 'dns:domain': 'example.invalid', 'core:url': 'https://core.example.invalid' };

describe('[ADSC] setup checks', function () {
  it('[ADSC1] dnsLess: the public address; plain HTTP is a warning, none is blocking', () => {
    assert.equal(run({ 'dnsLess:isActive': true, 'dnsLess:publicUrl': 'https://pryv.example.com/' }).topology.status, 'ok');
    assert.equal(run({ 'dnsLess:isActive': true, 'dnsLess:publicUrl': 'http://10.0.0.1:3000' }).topology.status, 'warn');
    assert.equal(run({ 'dnsLess:isActive': true, 'dnsLess:publicUrl': null }).topology.status, 'blocking');
    assert.equal(run({ 'dnsLess:isActive': true, 'dnsLess:publicUrl': 'https://pryv.example.com/' }).dns, undefined, 'no DNS check in dnsLess');
  });

  it('[ADSC2] DNS topology with the embedded DNS: no answer address is blocking; the delegation and a non-53 port are named', () => {
    const blocked = run({ ...DNS, 'dns:active': true, 'dns:publicIp': null, 'core:ip': null });
    assert.equal(blocked.dns.status, 'blocking');
    const ok = run({ ...DNS, 'dns:active': true, 'dns:publicIp': '203.0.113.7', 'dns:port': 5353 });
    assert.equal(ok.dns.status, 'info');
    assert.match(ok.dns.detail, /NS records/);
    assert.match(ok.dns.detail, /203\.0\.113\.7/);
    assert.equal(ok['dns-port'].status, 'warn');
    assert.equal(run({ ...DNS, 'dns:active': true, 'dns:publicIp': '203.0.113.7', 'dns:port': 53 })['dns-port'], undefined);
  });

  it('[ADSC3] certificates: the challenge named, a missing storage key blocking, none issued yet a warning', () => {
    const le = { ...DNS, 'dns:active': true, 'dns:publicIp': '203.0.113.7', 'letsEncrypt:enabled': true, 'letsEncrypt:atRestKey': 'a-key' };
    const none = run(le);
    assert.equal(none.certificates.status, 'warn');
    assert.match(none.certificates.detail, /DNS-01/);
    assert.equal(none['certificates-key'], undefined);
    assert.equal(run({ ...le, 'letsEncrypt:atRestKey': 'REPLACE ME' })['certificates-key'].status, 'blocking');
    const issued = run(le, { certificates: [{ hostname: '*.example.invalid', expiresAt: NOW + 60 * 86400000 }] });
    assert.equal(issued.certificates.status, 'ok');
    const http01 = run({ 'dnsLess:isActive': true, 'dnsLess:publicUrl': 'https://pryv.example.com/', 'letsEncrypt:enabled': true, 'letsEncrypt:atRestKey': 'k' });
    assert.match(http01.certificates.detail, /HTTP-01/);
    assert.equal(run({}).certificates.status, 'info', 'letsEncrypt off');
  });

  it('[ADSC4] migrations pending or unreadable are warnings; no secret value appears', () => {
    assert.equal(run({}, { pendingMigrations: 2 }).migrations.status, 'warn');
    assert.equal(run({}, { pendingMigrations: null }).migrations.status, 'warn');
    assert.equal(run({}).migrations.status, 'ok');
    const secret = 'an-admin-key-value-1234567890';
    const all = JSON.stringify(setupChecks({ config: config({ 'auth:adminAccessKey': secret, 'letsEncrypt:enabled': true, 'letsEncrypt:atRestKey': secret, ...DNS }), certificates: null, pendingMigrations: 0, now: NOW }));
    assert.ok(!all.includes(secret));
  });
});
