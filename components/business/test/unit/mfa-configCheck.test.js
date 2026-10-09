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
const { describeMfaConfig, describeInactiveSmsEnrolments } = require('../../src/mfa/configCheck.ts');

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

  it('[MCHK11] any stepUp setting (with or without MFA active) gives exactly the removal warning and no problem', function () {
    assert.ok(!('stepUp' in SHIPPED), 'the shipped default no longer carries stepUp');
    for (const stepUp of [{ required: false }, { required: true }, { required: 'false' }, 'off', [], null, {}]) {
      const label = JSON.stringify(stepUp);
      const withMfa = withChange((c) => { c.stepUp = stepUp; });
      assert.deepStrictEqual(withMfa.problems, [], label);
      assert.strictEqual(withMfa.warnings.length, 1, label + ' ' + JSON.stringify(withMfa.warnings));
      assert.match(withMfa.warnings[0], /^services\.mfa\.stepUp was removed and is ignored: .*always require a step-up/, label);
      const withoutMfa = describeMfaConfig({ active: false, stepUp });
      assert.deepStrictEqual(withoutMfa, { problems: [], warnings: withMfa.warnings }, label);
    }
  });

  it('[MCHK13] SMS contentKeys: a list of names; a reserved name is a problem, "phone" a warning', function () {
    const sms = (fn) => withChange((c) => {
      c.methods.sms.active = true;
      c.methods.sms.endpoints = { single: { url: 'https://sms.example/s' } };
      fn(c);
    });
    assert.deepStrictEqual(sms(() => {}), { problems: [], warnings: [] }, 'the shipped empty list');
    assert.deepStrictEqual(sms((c) => { c.methods.sms.contentKeys = ['language']; }), { problems: [], warnings: [] });
    for (const bad of ['language', [1], [''], { a: 1 }]) {
      assert.deepStrictEqual(paths(sms((c) => { c.methods.sms.contentKeys = bad; })), ['services.mfa.methods.sms.contentKeys'], JSON.stringify(bad));
    }
    assert.deepStrictEqual(paths(sms((c) => { c.sms.contentKeys = ['code']; })), ['services.mfa.sms.contentKeys']);
    const phone = sms((c) => { c.methods.sms.contentKeys = ['phone']; });
    assert.deepStrictEqual(phone.problems, []);
    assert.match(phone.warnings[0], /"phone".*no effect/);
  });

  it('[MCHK14] SMS codeLength (4 to 10), codeTtlSeconds and sendLimits are type-checked; a disabled limit warns', function () {
    const sms = (fn) => withChange((c) => {
      c.methods.sms.active = true;
      c.methods.sms.endpoints = { single: { url: 'https://sms.example/s' } };
      fn(c);
    });
    assert.deepStrictEqual(sms((c) => { c.methods.sms.codeLength = 8; c.methods.sms.codeTtlSeconds = 120; }), { problems: [], warnings: [] });
    for (const bad of [3, 11, 6.5, 'six', true]) {
      assert.deepStrictEqual(paths(sms((c) => { c.methods.sms.codeLength = bad; })), ['services.mfa.methods.sms.codeLength'], JSON.stringify(bad));
    }
    assert.deepStrictEqual(paths(sms((c) => { c.sms.codeLength = 2; })), ['services.mfa.sms.codeLength']);
    assert.deepStrictEqual(paths(sms((c) => { c.methods.sms.codeTtlSeconds = 0; })), ['services.mfa.methods.sms.codeTtlSeconds']);
    assert.deepStrictEqual(paths(sms((c) => { c.methods.sms.sendLimits = 'strict'; })), ['services.mfa.methods.sms.sendLimits']);
    assert.deepStrictEqual(paths(sms((c) => { c.methods.sms.sendLimits.perUserPerHour = -1; c.methods.sms.sendLimits.minIntervalSeconds = 'soon'; })).sort(),
      ['services.mfa.methods.sms.sendLimits.minIntervalSeconds', 'services.mfa.methods.sms.sendLimits.perUserPerHour']);
    const off = sms((c) => { c.methods.sms.sendLimits.perDestinationPerDay = 0; });
    assert.deepStrictEqual(off.problems, []);
    assert.match(off.warnings.join(' '), /perDestinationPerDay is 0, which disables this limit/);
    const longCode = sms((c) => { c.methods.sms.codeTtlSeconds = 3600; });
    assert.match(longCode.warnings.join(' '), /codeTtlSeconds \(3600\) exceeds sessions\.ttlSeconds/);
  });

  it('[MCHK15] challenge-verify: a missing verify success predicate warns, a malformed one is a problem', function () {
    const cv = (fn) => withChange((c) => {
      c.methods.sms.active = true;
      c.methods.sms.mode = 'challenge-verify';
      c.sms.endpoints.challenge.url = 'https://sms.example/c';
      c.sms.endpoints.verify.url = 'https://sms.example/v';
      fn(c);
    });
    const missing = cv(() => {});
    assert.deepStrictEqual(missing.problems, []);
    assert.strictEqual(missing.warnings.length, 1, JSON.stringify(missing.warnings));
    assert.match(missing.warnings[0], /services\.mfa\.sms\.endpoints\.verify\.success is not set.*2xx with a body is refused/);
    assert.deepStrictEqual(cv((c) => { c.sms.endpoints.verify.success = { jsonPath: 'data.status', equals: 'approved' }; }), { problems: [], warnings: [] });
    for (const bad of [{ jsonPath: 'status' }, { jsonPath: '', equals: 'x' }, { jsonPath: 'status', equals: ['x'] }, 'status']) {
      assert.deepStrictEqual(paths(cv((c) => { c.sms.endpoints.verify.success = bad; })), ['services.mfa.sms.endpoints.verify.success'], JSON.stringify(bad));
    }
    // The legacy mode too.
    const legacy = withChange((c) => {
      c.mode = 'challenge-verify';
      c.sms.endpoints.challenge.url = 'https://sms.example/c';
      c.sms.endpoints.verify.url = 'https://sms.example/v';
    });
    assert.match(legacy.warnings.join(' '), /verify\.success is not set/);
  });

  it('[MCHK9] sessions.ttlSeconds below 1 is a problem', function () {
    assert.deepStrictEqual(paths(withChange((c) => { c.sessions.ttlSeconds = 0; })), ['services.mfa.sessions.ttlSeconds']);
  });

  it('[MCHK16] sessions.maxPending: a non-negative integer; 0 warns (no cap); anything else is a problem', function () {
    assert.strictEqual(SHIPPED.sessions.maxPending, 10000);
    for (const bad of [-1, 1.5, 'many', true, [3]]) {
      assert.deepStrictEqual(paths(withChange((c) => { c.sessions.maxPending = bad; })), ['services.mfa.sessions.maxPending'], JSON.stringify(bad));
    }
    const off = withChange((c) => { c.sessions.maxPending = 0; });
    assert.deepStrictEqual(off.problems, []);
    assert.match(off.warnings.join(' '), /maxPending is 0/);
    assert.deepStrictEqual(withChange((c) => { c.sessions.maxPending = '25'; }), { problems: [], warnings: [] });
  });

  it('[MCHK12] allowLoginWhenMethodInactive: true warns; a non-boolean is a problem; false or absent says nothing', function () {
    const on = withChange((c) => { c.allowLoginWhenMethodInactive = true; });
    assert.deepStrictEqual(on.problems, []);
    assert.strictEqual(on.warnings.length, 1, JSON.stringify(on.warnings));
    assert.match(on.warnings[0], /allowLoginWhenMethodInactive is true.*password only/);
    assert.deepStrictEqual(paths(withChange((c) => { c.allowLoginWhenMethodInactive = 'yes'; })), ['services.mfa.allowLoginWhenMethodInactive']);
    assert.deepStrictEqual(withChange((c) => { c.allowLoginWhenMethodInactive = false; }), { problems: [], warnings: [] });
    assert.deepStrictEqual(withChange((c) => { delete c.allowLoginWhenMethodInactive; }), { problems: [], warnings: [] });
  });
});

describe('[MSIE] describeInactiveSmsEnrolments (boot check of SMS enrolments)', function () {
  const smsOff = () => clone(SHIPPED); // shipped default: MFA on, TOTP only, no legacy mode
  function counter (n) {
    const c = async () => { c.calls++; if (n instanceof Error) throw n; return n; };
    c.calls = 0;
    return c;
  }

  it('[MSIE1] no SMS enrolment: no warning', async function () {
    const count = counter(0);
    assert.strictEqual(await describeInactiveSmsEnrolments(smsOff(), count), null);
    assert.strictEqual(count.calls, 1);
  });

  it('[MSIE2] SMS enrolments while SMS is not active: a warning naming the count and the refusal', async function () {
    const message = await describeInactiveSmsEnrolments(smsOff(), counter(3));
    assert.match(message, /^3 account\(s\) on this core are enrolled in SMS MFA/);
    assert.match(message, /refused \(403 mfa-method-inactive\)/);
    const allowed = smsOff();
    allowed.allowLoginWhenMethodInactive = true;
    assert.match(await describeInactiveSmsEnrolments(allowed, counter(3)), /log in with the password only/);
  });

  it('[MSIE3] SMS active (new model or legacy mode), MFA off, or no count available: not counted, no warning', async function () {
    const smsOn = smsOff();
    smsOn.methods.sms.active = true;
    const legacy = smsOff();
    legacy.mode = 'single';
    const off = smsOff();
    off.active = false;
    for (const cfg of [smsOn, legacy, off]) {
      const count = counter(3);
      assert.strictEqual(await describeInactiveSmsEnrolments(cfg, count), null, JSON.stringify(cfg));
      assert.strictEqual(count.calls, 0, 'the storage is not queried');
    }
    assert.strictEqual(await describeInactiveSmsEnrolments(smsOff(), null), null);
  });

  it('[MSIE4] a failing count or an unknown mode never throws: no warning, the error goes to onError', async function () {
    const errors = [];
    assert.strictEqual(await describeInactiveSmsEnrolments(smsOff(), counter(new Error('db down')), (e) => errors.push(e.message)), null);
    assert.deepStrictEqual(errors, ['db down']);
    assert.strictEqual(await describeInactiveSmsEnrolments({ mode: 'bogus' }, counter(3)), null);
  });
});
