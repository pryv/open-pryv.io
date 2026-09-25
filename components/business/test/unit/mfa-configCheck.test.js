/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Boot-time check of services.mfa (describeMfaConfig): settings that cannot
 * work are problems (the boot is refused), ignored or defaulted ones warnings.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { describeMfaConfig } = require('../../src/mfa/configCheck.ts');

const SHIPPED = yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, '../../../../config/default-config.yml'), 'utf8')).services.mfa;
const clone = (o) => JSON.parse(JSON.stringify(o));
function withChange (fn) {
  const cfg = clone(SHIPPED);
  fn(cfg);
  return describeMfaConfig(cfg);
}
const paths = (r) => r.problems.map((p) => p.path.join('.'));

describe('[MCHK] describeMfaConfig', function () {
  it('[MCHK1] the shipped default: no problem, no warning; absent or disabled MFA: nothing either', function () {
    assert.deepStrictEqual(describeMfaConfig(SHIPPED), { problems: [], warnings: [] });
    assert.deepStrictEqual(describeMfaConfig(undefined), { problems: [], warnings: [] });
    assert.deepStrictEqual(describeMfaConfig({ active: false, mode: 'single' }), { problems: [], warnings: [] });
  });

  it('[MCHK2] an unknown mode is a problem', function () {
    assert.deepStrictEqual(paths(withChange((c) => { c.mode = 'bogus'; })), ['services.mfa.mode']);
  });

  it('[MCHK3] an explicit defaultMethod that is unknown or inactive is a problem; an implicit one only warns', function () {
    assert.deepStrictEqual(paths(withChange((c) => { c.defaultMethod = 'sms'; })), ['services.mfa.defaultMethod']);
    assert.deepStrictEqual(paths(withChange((c) => { c.defaultMethod = 'push'; })), ['services.mfa.defaultMethod']);
    // SMS-only modern config that never set defaultMethod: the implicit "totp" is inactive.
    const implicit = withChange((c) => {
      delete c.defaultMethod;
      c.methods.totp.active = false;
      c.methods.sms.active = true;
      c.sms.endpoints.single.url = 'https://sms.example/s';
    });
    assert.deepStrictEqual(implicit.problems, []);
    assert.match(implicit.warnings.join(' '), /defaultMethod is not set/);
  });

  it('[MCHK4] a secretsKey that is not 32 bytes of base64 is a problem; a valid one is not', function () {
    assert.deepStrictEqual(paths(withChange((c) => { c.methods.totp.secretsKey = 'dG9vLXNob3J0'; })), ['services.mfa.methods.totp.secretsKey']);
    const ok = crypto.randomBytes(32).toString('base64');
    assert.deepStrictEqual(paths(withChange((c) => { c.methods.totp.secretsKey = ok; })), []);
  });

  it('[MCHK5] out-of-range TOTP parameters are problems', function () {
    const r = withChange((c) => { c.methods.totp.digits = 4; c.methods.totp.periodSeconds = 0; c.methods.totp.driftSteps = 1.5; });
    assert.deepStrictEqual(paths(r).sort(), ['services.mfa.methods.totp.digits', 'services.mfa.methods.totp.driftSteps', 'services.mfa.methods.totp.periodSeconds']);
  });

  it('[MCHK6] an active SMS method needs a known mode and the endpoints of that mode', function () {
    assert.deepStrictEqual(paths(withChange((c) => { c.methods.sms.active = true; })), ['services.mfa.methods.sms.endpoints']);
    assert.deepStrictEqual(paths(withChange((c) => { c.methods.sms.active = true; c.methods.sms.mode = 'push'; })), ['services.mfa.methods.sms.mode']);
    assert.deepStrictEqual(paths(withChange((c) => {
      c.methods.sms.active = true;
      c.methods.sms.mode = 'challenge-verify';
      c.sms.endpoints.challenge.url = 'https://sms.example/c';
      c.sms.endpoints.verify.url = 'https://sms.example/v';
    })), [], 'the legacy endpoints location is honoured');
  });

  it('[MCHK7] the legacy mode: a warning, and a problem only when its endpoints are missing', function () {
    const bare = withChange((c) => { c.mode = 'single'; });
    assert.deepStrictEqual(paths(bare), ['services.mfa.mode.endpoints']);
    const ok = withChange((c) => { c.mode = 'single'; c.sms.endpoints.single.url = 'https://sms.example/s'; });
    assert.deepStrictEqual(ok.problems, []);
    assert.strictEqual(ok.warnings.length, 1);
    assert.match(ok.warnings[0], /SMS-only/);
  });

  it('[MCHK8] removed or invalid attempts keys warn and never refuse the boot', function () {
    const r = withChange((c) => {
      c.attempts.perAccount = 20;
      c.attempts.lockoutSeconds = 900;
      c.attempts.perSession = -1;
      c.attempts.backoff.maxSeconds = 'soon';
    });
    assert.deepStrictEqual(r.problems, []);
    assert.strictEqual(r.warnings.length, 3, JSON.stringify(r.warnings));
    assert.match(r.warnings[0], /perAccount and services\.mfa\.attempts\.lockoutSeconds are no longer read/);
    const notMapping = withChange((c) => { c.attempts.backoff = 'fast'; });
    assert.match(notMapping.warnings.join(' '), /not a mapping/);
    assert.deepStrictEqual(withChange((c) => { c.attempts.backoff = {}; }).warnings, []);
  });

  it('[MCHK10] backoff combinations that silently weaken it warn', function () {
    assert.match(withChange((c) => { c.attempts.backoff.baseSeconds = 0; }).warnings.join(' '), /baseSeconds is 0/);
    assert.match(withChange((c) => { c.attempts.backoff.maxSeconds = 1200; }).warnings.join(' '), /exceeds perAccountWindowSeconds/);
    assert.deepStrictEqual(withChange((c) => { c.attempts.backoff.baseSeconds = 0; c.attempts.backoff.maxSeconds = 0; }).warnings, []);
  });

  it('[MCHK9] sessions.ttlSeconds below 1 is a problem', function () {
    assert.deepStrictEqual(paths(withChange((c) => { c.sessions.ttlSeconds = 0; })), ['services.mfa.sessions.ttlSeconds']);
  });
});
