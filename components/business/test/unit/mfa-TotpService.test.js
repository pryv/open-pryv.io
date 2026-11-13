/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Unit tests for the server-side TOTP MfaMethod.
 *
 * Uses the inline `secretsKey` at-rest key path (no config needed). Covers the
 * enrolment shape, that the stored secret is encrypted at rest, a happy-path
 * verify, the replay guard, and wrong-code rejection. The key-resolution paths
 * (valid inline key, wrong-length fail-closed) are covered in
 * `mfa-config.test.js` ([MKEY]); the adminAccessKey-derived path needs a live
 * config and is exercised by the api-server MFA suite.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const TotpService = require('../../src/mfa/TotpService.ts').default;
const Profile = require('../../src/mfa/Profile.ts').default;
const { base32Decode, totpCode } = require('../../src/mfa/totp.ts');

function newService () {
  const secretsKey = crypto.randomBytes(32).toString('base64');
  return new TotpService({ secretsKey, digits: 6, periodSeconds: 30, driftSteps: 1 });
}

describe('[MTOTP] TotpService', function () {
  it('[MTOTP1] enroll returns an otpauth URI + Base32 secret and stores it encrypted', async function () {
    const svc = newService();
    const profile = new Profile();
    const extra = await svc.enroll('alice', profile, {});
    assert.strictEqual(extra.method, 'totp');
    assert.match(extra.otpauthUri, /^otpauth:\/\/totp\/.+secret=[A-Z2-7]+/);
    assert.match(extra.secret, /^[A-Z2-7]+$/);
    assert.strictEqual(profile.method, 'totp');
    assert.strictEqual(profile.totp.confirmedAt, null);
    assert.strictEqual(profile.totp.lastUsedStep, -1);
    // Stored secret is an AtRestEncryption envelope, NOT the Base32 plaintext.
    assert.notStrictEqual(profile.totp.secret, extra.secret);
    assert.ok(!profile.totp.secret.includes(extra.secret));
  });

  it('[MTOTP2] verify accepts a current code, then the replay guard rejects it', async function () {
    const svc = newService();
    const profile = new Profile();
    const extra = await svc.enroll('bob', profile, {});
    const keyBytes = base32Decode(extra.secret);
    const code = totpCode(keyBytes, { digits: 6, periodSeconds: 30 });
    await svc.verify('bob', profile, { headers: {}, body: { code } });
    assert.ok(profile.totp.lastUsedStep >= 0);
    // Replaying the same code (same step) must now be refused.
    await assert.rejects(
      () => svc.verify('bob', profile, { headers: {}, body: { code } }),
      /invalid/i
    );
  });

  it('[MTOTP3] verify rejects a wrong code', async function () {
    const svc = newService();
    const profile = new Profile();
    const extra = await svc.enroll('carol', profile, {});
    const keyBytes = base32Decode(extra.secret);
    const good = totpCode(keyBytes, { digits: 6, periodSeconds: 30 });
    const wrong = good === '000000' ? '111111' : '000000';
    await assert.rejects(
      () => svc.verify('carol', profile, { headers: {}, body: { code: wrong } }),
      /invalid/i
    );
  });

  it('[AREV3] a secret is enrolled in the current envelope version; one stored in the first version still verifies', async function () {
    const secretsKey = crypto.randomBytes(32).toString('base64');
    const svc = new TotpService({ secretsKey, digits: 6, periodSeconds: 30, driftSteps: 1 });
    const profile = new Profile();
    const extra = await svc.enroll('dave', profile, {});
    assert.strictEqual(Buffer.from(profile.totp.secret, 'base64')[0], 2);

    // the same secret in an envelope of the first version (no authenticated data)
    const { resolveTotpKey } = require('../../src/mfa/totpKeys.ts');
    const key = await resolveTotpKey({ secretsKey });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(extra.secret, 'utf8')), cipher.final()]);
    profile.totp.secret = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]).toString('base64');
    const code = totpCode(base32Decode(extra.secret), { digits: 6, periodSeconds: 30 });
    await svc.verify('dave', profile, { headers: {}, body: { code } });
    assert.ok(profile.totp.lastUsedStep >= 0);
  });

  it('[MTOTP4] challenge is a no-op that signals the method', async function () {
    const svc = newService();
    const profile = new Profile();
    await svc.enroll('dave', profile, {});
    const res = await svc.challenge('dave', profile, { headers: {}, body: {} });
    assert.deepStrictEqual(res, { method: 'totp' });
  });
});
