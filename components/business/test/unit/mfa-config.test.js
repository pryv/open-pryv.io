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
 * (rules N1/N2/N3); the key resolver validates the inline secret path and
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
