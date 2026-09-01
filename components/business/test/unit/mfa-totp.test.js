/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Unit tests for the in-process TOTP/HOTP primitive.
 *
 * The [TOTP*] cases pin the implementation to the published RFC golden vectors
 * (loaded from a fixture that must never be edited to match code): RFC 4226
 * Appendix D (HOTP), RFC 6238 Appendix B (TOTP SHA-1), RFC 4648 (Base32). The
 * remaining cases exercise the drift window, the replay guard, constant-time
 * length handling, and codec round-trips.
 */

const assert = require('node:assert/strict');

const { base32Encode, base32Decode, hotp, totpCode, totpVerify, stepFor } = require('../../src/mfa/totp.ts');
const vectors = require('../fixtures/totp-vectors.json');

describe('[TOTP] in-process TOTP/HOTP primitive', function () {
  describe('[TOTPH] HOTP RFC 4226 Appendix D golden vectors', function () {
    const key = Buffer.from(vectors.hotp.secretAscii, 'ascii');
    for (const v of vectors.hotp.vectors) {
      it(`[TOTPH${v.counter}] counter ${v.counter} -> ${v.code}`, function () {
        assert.strictEqual(hotp(key, v.counter, vectors.hotp.digits), v.code);
      });
    }
  });

  describe('[TOTPT] TOTP RFC 6238 Appendix B golden vectors (SHA-1)', function () {
    const t = vectors.totp;
    const key = Buffer.from(t.secretAscii, 'ascii');
    for (const v of t.vectors) {
      it(`[TOTPT${v.time}] t=${v.time} -> ${v.code}`, function () {
        assert.strictEqual(
          totpCode(key, { time: v.time, t0: t.t0, periodSeconds: t.periodSeconds, digits: t.digits, algorithm: t.algorithm }),
          v.code
        );
      });
    }
  });

  describe('[TOTPB] Base32 RFC 4648 codec', function () {
    for (const v of vectors.base32.vectors) {
      const unpadded = v.padded.replace(/=+$/, '');
      it(`[TOTPB] encode(${JSON.stringify(v.plain)}) -> ${JSON.stringify(unpadded)} (unpadded)`, function () {
        assert.strictEqual(base32Encode(Buffer.from(v.plain, 'ascii')), unpadded);
      });
      it(`[TOTPB] decode round-trips ${JSON.stringify(v.plain)} (padded and unpadded)`, function () {
        assert.strictEqual(base32Decode(v.padded).toString('ascii'), v.plain);
        assert.strictEqual(base32Decode(unpadded).toString('ascii'), v.plain);
      });
    }
    it('[TOTPBcase] decode tolerates lower case and whitespace', function () {
      assert.strictEqual(base32Decode('mz xw 6y tb').toString('ascii'), 'fooba');
    });
    it('[TOTPBbad] decode rejects invalid characters', function () {
      assert.throws(() => base32Decode('MZXW6YT1'), /invalid character/);
    });
  });

  describe('[TOTPV] totpVerify drift, replay, length', function () {
    const key = crypto20();
    const T = 1700000000; // fixed instant, epoch seconds
    const period = 30;
    const step = stepFor(T, 0, period);

    it('[TOTPVok] a fresh current code is accepted and returns its step', function () {
      const code = totpCode(key, { time: T, periodSeconds: period, digits: 6 });
      assert.strictEqual(totpVerify(key, code, { now: T, periodSeconds: period, digits: 6, driftSteps: 1 }), step);
    });

    it('[TOTPVprev] a code from the previous step is accepted within drift 1', function () {
      const prev = totpCode(key, { time: T - period, periodSeconds: period, digits: 6 });
      assert.strictEqual(totpVerify(key, prev, { now: T, periodSeconds: period, digits: 6, driftSteps: 1 }), step - 1);
    });

    it('[TOTPVfar] a code two steps back is rejected at drift 1', function () {
      const far = totpCode(key, { time: T - 2 * period, periodSeconds: period, digits: 6 });
      assert.strictEqual(totpVerify(key, far, { now: T, periodSeconds: period, digits: 6, driftSteps: 1 }), null);
    });

    it('[TOTPVwrong] a wrong code is rejected', function () {
      const code = totpCode(key, { time: T, periodSeconds: period, digits: 6 });
      const wrong = code === '000000' ? '111111' : '000000';
      assert.strictEqual(totpVerify(key, wrong, { now: T, periodSeconds: period, digits: 6, driftSteps: 1 }), null);
    });

    it('[TOTPVreplay] a code at or before notAfterOrAtStep is rejected (replay guard)', function () {
      const code = totpCode(key, { time: T, periodSeconds: period, digits: 6 });
      // guard set to the current step: the just-used step and everything before
      // it must be refused; only step+1 remains in the window.
      assert.strictEqual(totpVerify(key, code, { now: T, periodSeconds: period, digits: 6, driftSteps: 1, notAfterOrAtStep: step }), null);
    });

    it('[TOTPVlen] a code of the wrong length is rejected without matching', function () {
      assert.strictEqual(totpVerify(key, '1234', { now: T, periodSeconds: period, digits: 6 }), null);
      assert.strictEqual(totpVerify(key, '12345678', { now: T, periodSeconds: period, digits: 6 }), null);
    });

    it('[TOTPVnondigit] a non-digit code is rejected', function () {
      assert.strictEqual(totpVerify(key, 'abcdef', { now: T, periodSeconds: period, digits: 6 }), null);
    });
  });
});

function crypto20 () {
  return require('node:crypto').randomBytes(20);
}
