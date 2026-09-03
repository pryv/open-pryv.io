/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Unit tests for the MFA config normalizer (the back-compat keystone) and the
 * TOTP at-rest key resolver. The normalizer maps both the new
 * active/defaultMethod/methods shape and the legacy `mode` onto one form
 * (rules N0 explicit-off / N2 legacy-mode-wins / N1 new-model / N3 off); the
 * key resolver validates the inline secret path and
 * fails closed.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { normalizeMfaConfig } = require('../../src/mfa/index.ts');
const { resolveTotpKey } = require('../../src/mfa/totpKeys.ts');

describe('[MNORM] normalizeMfaConfig', function () {
  it('[MNORM1] N3: disabled / absent / empty -> MFA off', function () {
    assert.deepStrictEqual(normalizeMfaConfig({ mode: 'disabled' }), { active: false });
    assert.deepStrictEqual(normalizeMfaConfig(undefined), { active: false });
    assert.deepStrictEqual(normalizeMfaConfig({}), { active: false });
  });

  it('[MNORM2] N2: legacy mode "single" shims to an active SMS method', function () {
    const n = normalizeMfaConfig({ mode: 'single', sms: { endpoints: { single: { url: 'x' } } } });
    assert.strictEqual(n.active, true);
    assert.strictEqual(n.defaultMethod, 'sms');
    assert.strictEqual(n.methods.sms.active, true);
    assert.strictEqual(n.methods.sms.mode, 'single');
    assert.deepStrictEqual(n.methods.sms.endpoints, { single: { url: 'x' } });
    assert.strictEqual(n.methods.totp.active, false);
  });

  it('[MNORM3] N2: legacy mode "challenge-verify" shims likewise', function () {
    const n = normalizeMfaConfig({ mode: 'challenge-verify', sms: { endpoints: { challenge: {}, verify: {} } } });
    assert.strictEqual(n.active, true);
    assert.strictEqual(n.methods.sms.mode, 'challenge-verify');
    assert.strictEqual(n.methods.totp.active, false);
  });

  it('[MNORM4] N1: new model defaults totp active + defaultMethod totp', function () {
    const n = normalizeMfaConfig({ active: true, methods: { totp: { secretsKey: 'k' } } });
    assert.strictEqual(n.active, true);
    assert.strictEqual(n.defaultMethod, 'totp');
    assert.strictEqual(n.methods.totp.active, true);
    assert.strictEqual(n.methods.sms.active, false);
  });

  it('[MNORM5] N1: methods.sms.endpoints falls back to the legacy sms.endpoints when empty', function () {
    const n = normalizeMfaConfig({ active: true, methods: { sms: { active: true } }, sms: { endpoints: { single: { url: 'y' } } } });
    assert.deepStrictEqual(n.methods.sms.endpoints, { single: { url: 'y' } });
  });

  it('[MNORM6] an unknown legacy mode still throws', function () {
    assert.throws(() => normalizeMfaConfig({ mode: 'weird' }), /Unknown MFA mode/);
  });

  it('[MNORM7] a defaultMethod naming an inactive method does NOT throw (login path must not brick)', function () {
    const n = normalizeMfaConfig({ active: true, defaultMethod: 'sms', methods: { totp: { active: true }, sms: { active: false } } });
    assert.strictEqual(n.active, true);
    assert.strictEqual(n.defaultMethod, 'sms');
  });

  it('[MNORM8] a legacy `mode` TAKES PRECEDENCE over the active-by-default (upgrade-safety): SMS-only shim', function () {
    // The default now supplies active:true; a legacy operator config (mode set,
    // no explicit active) must keep its SMS second factor, not silently drop to
    // a TOTP-only model where its SMS users would have no active method.
    const n = normalizeMfaConfig({ active: true, mode: 'single', sms: { endpoints: { single: { url: 'x' } } } });
    assert.strictEqual(n.active, true);
    assert.strictEqual(n.defaultMethod, 'sms');
    assert.strictEqual(n.methods.sms.active, true);
    assert.strictEqual(n.methods.sms.mode, 'single');
    assert.deepStrictEqual(n.methods.sms.endpoints, { single: { url: 'x' } });
    assert.strictEqual(n.methods.totp.active, false);
  });

  it('[MNORM9] an explicit active:false wins even over a leftover legacy mode', function () {
    assert.deepStrictEqual(normalizeMfaConfig({ active: false, mode: 'single' }), { active: false });
  });

  const ATTEMPTS_DEFAULTS = {
    perSession: 5,
    perAccount: 20,
    perAccountWindowSeconds: 900,
    lockoutSeconds: 900
  };

  it('[MNORM10] N1: the attempts block gets its defaults when absent', function () {
    const n = normalizeMfaConfig({ active: true });
    assert.deepStrictEqual(n.attempts, ATTEMPTS_DEFAULTS);
  });

  it('[MNORM11] N2: the legacy mode shim also carries the attempts defaults', function () {
    const n = normalizeMfaConfig({ mode: 'single', sms: { endpoints: { single: { url: 'x' } } } });
    assert.deepStrictEqual(n.attempts, ATTEMPTS_DEFAULTS);
  });

  it('[MNORM12] explicit attempts values pass through unchanged', function () {
    const attempts = { perSession: 3, perAccount: 9, perAccountWindowSeconds: 60, lockoutSeconds: 120 };
    assert.deepStrictEqual(normalizeMfaConfig({ active: true, attempts }).attempts, attempts);
  });

  it('[MNORM13] perAccount:0 is preserved (limiter disabled); junk values fall back per-field', function () {
    // 0 is meaningful: it disables the per-account limiter.
    const off = normalizeMfaConfig({ active: true, attempts: { perAccount: 0 } });
    assert.strictEqual(off.attempts.perAccount, 0);
    assert.strictEqual(off.attempts.perSession, 5, 'other fields keep their defaults');

    // A negative / NaN / non-numeric field must not weaken anything silently.
    const junk = normalizeMfaConfig({
      active: true,
      attempts: { perSession: -1, perAccount: NaN, perAccountWindowSeconds: 'abc', lockoutSeconds: null }
    });
    assert.deepStrictEqual(junk.attempts, ATTEMPTS_DEFAULTS);
  });
});

describe('[MKEY] resolveTotpKey', function () {
  it('[MKEY1] a valid base64 32-byte secretsKey resolves to that key', async function () {
    const raw = crypto.randomBytes(32);
    const key = await resolveTotpKey({ secretsKey: raw.toString('base64') });
    assert.ok(Buffer.isBuffer(key));
    assert.strictEqual(key.length, 32);
    assert.ok(key.equals(raw));
  });

  it('[MKEY2] a wrong-length secretsKey fails closed (throws)', async function () {
    await assert.rejects(
      () => resolveTotpKey({ secretsKey: crypto.randomBytes(16).toString('base64') }),
      /must decode to 32 bytes/
    );
  });
});
