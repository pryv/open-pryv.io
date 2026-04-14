/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 34 Phase 2b — passphrase-based bundle encryption.
 */

const assert = require('node:assert/strict');
const BundleEncryption = require('../../src/bootstrap/BundleEncryption');

const SAMPLE_BUNDLE = {
  version: 1,
  issuedAt: '2026-04-14T10:00:00Z',
  cluster: { domain: 'mc.example.com', joinToken: 'x'.repeat(32) },
  secret: 'super-secret-value'
};

describe('[BUNDLEENC] Bundle encryption', function () {
  // scrypt is CPU-bound; loosen the default 2s timeout.
  this.timeout(15_000);

  describe('encrypt() / decrypt() round-trip', () => {
    it('round-trips a small object', () => {
      const armored = BundleEncryption.encrypt({ hello: 'world' }, 'pass');
      const back = BundleEncryption.decrypt(armored, 'pass');
      assert.deepEqual(back, { hello: 'world' });
    });

    it('round-trips the sample bundle', () => {
      const armored = BundleEncryption.encrypt(SAMPLE_BUNDLE, 'correct-horse');
      const back = BundleEncryption.decrypt(armored, 'correct-horse');
      assert.deepEqual(back, SAMPLE_BUNDLE);
    });

    it('produces ASCII-armored output', () => {
      const armored = BundleEncryption.encrypt(SAMPLE_BUNDLE, 'p');
      assert(armored.includes('-----BEGIN PRYV BOOTSTRAP BUNDLE-----'));
      assert(armored.includes('-----END PRYV BOOTSTRAP BUNDLE-----'));
      // Body should be base64 (A-Za-z0-9+/=) with line breaks, nothing else
      const body = armored
        .replace('-----BEGIN PRYV BOOTSTRAP BUNDLE-----', '')
        .replace('-----END PRYV BOOTSTRAP BUNDLE-----', '')
        .trim();
      assert(/^[A-Za-z0-9+/=\n\r]+$/.test(body), `unexpected armor body: ${body.slice(0, 80)}…`);
    });

    it('different calls with the same passphrase produce different ciphertexts', () => {
      const a = BundleEncryption.encrypt(SAMPLE_BUNDLE, 'p');
      const b = BundleEncryption.encrypt(SAMPLE_BUNDLE, 'p');
      assert.notEqual(a, b, 'random salt+iv should make outputs distinct');
    });
  });

  describe('decrypt() negative cases', () => {
    it('rejects the wrong passphrase', () => {
      const armored = BundleEncryption.encrypt(SAMPLE_BUNDLE, 'right');
      assert.throws(
        () => BundleEncryption.decrypt(armored, 'wrong'),
        /authentication failed/
      );
    });

    it('rejects a tampered ciphertext (last base64 char flipped)', () => {
      const armored = BundleEncryption.encrypt(SAMPLE_BUNDLE, 'p');
      // Flip a char in the body to corrupt the ciphertext/tag
      const lines = armored.split('\n');
      const bodyLineIdx = lines.findIndex(l => l && !l.startsWith('---'));
      const line = lines[bodyLineIdx];
      const flipped = line.slice(0, -2) + (line.slice(-2, -1) === 'A' ? 'B' : 'A') + line.slice(-1);
      lines[bodyLineIdx] = flipped;
      const tampered = lines.join('\n');
      assert.throws(
        () => BundleEncryption.decrypt(tampered, 'p'),
        /authentication failed|not valid JSON|too small|invalid/i
      );
    });

    it('rejects missing armor markers', () => {
      assert.throws(
        () => BundleEncryption.decrypt('just some base64\n', 'p'),
        /not an armored bundle/
      );
    });

    it('rejects an empty passphrase', () => {
      const armored = BundleEncryption.encrypt(SAMPLE_BUNDLE, 'p');
      assert.throws(
        () => BundleEncryption.decrypt(armored, ''),
        /passphrase is required/
      );
    });

    it('rejects an unsupported envelope version', () => {
      // Construct a valid-length envelope whose version byte is 99
      const fake = Buffer.alloc(1 + 16 + 12 + 16 + 4, 0);
      fake[0] = 99;
      const armored = [
        '-----BEGIN PRYV BOOTSTRAP BUNDLE-----',
        fake.toString('base64'),
        '-----END PRYV BOOTSTRAP BUNDLE-----'
      ].join('\n');
      assert.throws(
        () => BundleEncryption.decrypt(armored, 'p'),
        /unsupported envelope version 99/
      );
    });
  });

  describe('encrypt() negative cases', () => {
    it('rejects a missing passphrase', () => {
      assert.throws(
        () => BundleEncryption.encrypt({ a: 1 }, ''),
        /passphrase is required/
      );
    });

    it('rejects a non-object bundle', () => {
      assert.throws(
        () => BundleEncryption.encrypt(null, 'p'),
        /bundle must be an object/
      );
    });
  });

  describe('generatePassphrase()', () => {
    it('returns a grouped, non-trivial string', () => {
      const p = BundleEncryption.generatePassphrase();
      assert(p.length >= 22, `passphrase too short: ${p}`);
      assert(p.includes('-'), 'expected dashes between groups');
      assert(/^[A-Za-z0-9_-]+$/.test(p), `unexpected chars: ${p}`);
    });

    it('returns different values on each call', () => {
      const a = BundleEncryption.generatePassphrase();
      const b = BundleEncryption.generatePassphrase();
      assert.notEqual(a, b);
    });

    it('produces a passphrase that actually works for round-trip', () => {
      const p = BundleEncryption.generatePassphrase();
      const armored = BundleEncryption.encrypt(SAMPLE_BUNDLE, p);
      const back = BundleEncryption.decrypt(armored, p);
      assert.deepEqual(back, SAMPLE_BUNDLE);
    });
  });
});
