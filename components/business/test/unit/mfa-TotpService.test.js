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
 * verify, the replay guard, and wrong-code / drift rejection. The
 * key-missing-fail-closed path and the adminAccessKey-derived path are covered
 * at the API/integration level ([MA13]) where config is controlled.
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

  it('[MTOTP4] challenge is a no-op that signals the method', async function () {
    const svc = newService();
    const profile = new Profile();
    await svc.enroll('dave', profile, {});
    const res = await svc.challenge('dave', profile, { headers: {}, body: {} });
    assert.deepStrictEqual(res, { method: 'totp' });
  });
});
