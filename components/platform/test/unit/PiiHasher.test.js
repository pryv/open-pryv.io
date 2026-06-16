/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PiiHasher, PEPPER_BYTES } = require('../../src/PiiHasher.ts');

const PEPPER = crypto.randomBytes(PEPPER_BYTES).toString('base64');
const PEPPER_2 = crypto.randomBytes(PEPPER_BYTES).toString('base64');

describe('[PIIH] PiiHasher', function () {
  describe('constructor', function () {
    it('[PIIH-01] accepts a 32-byte base64 pepper', function () {
      const h = new PiiHasher(PEPPER);
      assert.ok(h instanceof PiiHasher);
    });

    it('[PIIH-02] rejects an empty string', function () {
      assert.throws(() => new PiiHasher(''), /pepperBase64 is required/);
    });

    it('[PIIH-03] rejects non-string input', function () {
      assert.throws(() => new PiiHasher(null), /pepperBase64 is required/);
      assert.throws(() => new PiiHasher(undefined), /pepperBase64 is required/);
    });

    it('[PIIH-04] rejects a pepper that does not decode to exactly 32 bytes', function () {
      const tooShort = Buffer.alloc(16).toString('base64');
      assert.throws(() => new PiiHasher(tooShort), /must decode to exactly 32 bytes, got 16/);
      const tooLong = Buffer.alloc(64).toString('base64');
      assert.throws(() => new PiiHasher(tooLong), /must decode to exactly 32 bytes, got 64/);
    });
  });

  describe('hashFor', function () {
    const h = new PiiHasher(PEPPER);

    it('[PIIH-10] returns a lowercase hex string', function () {
      const out = h.hashFor('email', 'alice@x.com');
      assert.match(out, /^[0-9a-f]{64}$/);
    });

    it('[PIIH-11] is deterministic — same input → same output (the property that makes equality lookups work)', function () {
      const a = h.hashFor('email', 'alice@x.com');
      const b = h.hashFor('email', 'alice@x.com');
      assert.equal(a, b);
    });

    it('[PIIH-12] same value under different fields hashes differently — no cross-field collisions', function () {
      const a = h.hashFor('email', 'alice');
      const b = h.hashFor('username', 'alice');
      assert.notEqual(a, b);
    });

    it('[PIIH-13] same field + same value under different peppers hashes differently — pepper rotation works', function () {
      const h1 = new PiiHasher(PEPPER);
      const h2 = new PiiHasher(PEPPER_2);
      assert.notEqual(h1.hashFor('email', 'alice@x.com'), h2.hashFor('email', 'alice@x.com'));
    });

    it('[PIIH-14] email normalisation: case-insensitive — User@x.com collides with user@x.com', function () {
      const a = h.hashFor('email', 'User@x.com');
      const b = h.hashFor('email', 'user@x.com');
      assert.equal(a, b);
    });

    it('[PIIH-15] email normalisation: trims whitespace', function () {
      const a = h.hashFor('email', '  user@x.com  ');
      const b = h.hashFor('email', 'user@x.com');
      assert.equal(a, b);
    });

    it('[PIIH-16] username normalisation: case-SENSITIVE — Alice and alice are distinct', function () {
      // The legacy registration flow has always treated usernames case-
      // sensitively at the storage layer (account creation rejects collisions
      // on the raw string). Hashed mode preserves that behaviour.
      const a = h.hashFor('username', 'Alice');
      const b = h.hashFor('username', 'alice');
      assert.notEqual(a, b);
    });

    it('[PIIH-17] username normalisation: trims whitespace', function () {
      // Trimming is universal — leading/trailing whitespace is never part of
      // an identifier in practice and avoids accidental collisions in either
      // mode.
      const a = h.hashFor('username', '  alice  ');
      const b = h.hashFor('username', 'alice');
      assert.equal(a, b);
    });

    it('[PIIH-18] rejects an empty field name', function () {
      assert.throws(() => h.hashFor('', 'alice'), /field is required/);
    });

    it('[PIIH-19] rejects non-string plaintext', function () {
      assert.throws(() => h.hashFor('email', 123), /plaintext must be a string/);
      assert.throws(() => h.hashFor('email', null), /plaintext must be a string/);
    });
  });

  describe('normalize (static)', function () {
    it('[PIIH-20] email is lowercased + trimmed', function () {
      assert.equal(PiiHasher.normalize('email', '  USER@x.COM '), 'user@x.com');
    });

    it('[PIIH-21] username is trimmed but case-preserved', function () {
      assert.equal(PiiHasher.normalize('username', '  Alice '), 'Alice');
    });

    it('[PIIH-22] arbitrary custom field is trimmed but case-preserved', function () {
      assert.equal(PiiHasher.normalize('custom-field-x', '  Value  '), 'Value');
    });
  });
});
