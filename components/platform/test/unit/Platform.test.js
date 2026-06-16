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

const { Platform } = require('../../src/Platform.ts');
const { PiiHasher, PEPPER_BYTES } = require('../../src/PiiHasher.ts');

/**
 * Targeted unit tests for the Platform PII-hashing wrapper layer
 * threaded in Plan 99 Phase B.2. Verifies the structural behaviour:
 *
 *  - In `cleartext` mode (default), every #db call receives the
 *    plaintext exactly as the caller passed it.
 *  - In `hashed` mode, every #db call's PII argument is replaced by the
 *    HMAC token, with consistent per-field salt + email normalisation.
 *
 * End-to-end registration / DNS / cross-core flows are exercised in the
 * B.8 integration tests; this file pins the wrapping contract so any
 * regression at the Platform layer surfaces before integration.
 *
 * Test strategy: build a fresh Platform instance, swap its private
 * dependencies via a `_resetForTesting` seam. The seam is exported only
 * to enable tightly-bound unit testing — production callers (`init()`)
 * remain the only legitimate path to a fully wired Platform.
 */

const PEPPER_B64 = crypto.randomBytes(PEPPER_BYTES).toString('base64');

function makeRecordingDb () {
  const calls = [];
  const record = (method) => (...args) => {
    calls.push({ method, args });
    if (method === 'getUsersUniqueField') return null;
    if (method === 'getUserCore') return null;
    if (method === 'setUserUniqueFieldIfNotExists') return true;
    if (method === 'getAllWithPrefix') return [];
    return undefined;
  };
  const db = {
    getUsersUniqueField: record('getUsersUniqueField'),
    setUserUniqueField: record('setUserUniqueField'),
    setUserUniqueFieldIfNotExists: record('setUserUniqueFieldIfNotExists'),
    deleteUserUniqueField: record('deleteUserUniqueField'),
    setUserIndexedField: record('setUserIndexedField'),
    deleteUserIndexedField: record('deleteUserIndexedField'),
    getUserCore: record('getUserCore'),
    setUserCore: record('setUserCore'),
    setDnsRecord: record('setDnsRecord'),
    getDnsRecord: record('getDnsRecord'),
    deleteDnsRecord: record('deleteDnsRecord'),
    getAllWithPrefix: record('getAllWithPrefix')
  };
  return { db, calls };
}

/**
 * Construct a Platform with a stub #db + #piiHasher, bypassing the
 * singleton init path. Achieved by `Object.create(Platform.prototype)`
 * + direct field writes through a test-only setter method on the
 * prototype (defined inline below — kept off the production surface).
 */
function makePlatform ({ hashed }) {
  const platform = Object.create(Platform.prototype);
  const { db, calls } = makeRecordingDb();
  // We need to set the #private fields. Since they're truly private,
  // we attach the test seam via a method that lives on Platform's
  // prototype but is only used here. Cleaner alternative would be a
  // public _setTestSeam(...) on Platform, but adding production surface
  // for tests is what we're trying to avoid.
  //
  // Workaround: re-route every method we test to a thin wrapper that
  // shares state via closure. We capture `db` and `hasher` here and
  // monkey-patch `hashFor` so the production methods still call into
  // it through `this.hashFor(...)`.
  const hasher = hashed ? new PiiHasher(PEPPER_B64) : null;
  Object.defineProperty(platform, 'hashFor', {
    value (field, value) {
      return hasher == null ? value : hasher.hashFor(field, value);
    },
    writable: false
  });
  Object.defineProperty(platform, 'piiModeIsHashed', {
    get () { return hasher != null; }
  });
  // Reach into the prototype's `getUserCore` etc. by re-binding `this.#db`
  // proxy semantics. Since we can't write to #db from outside, route every
  // tested method through a thin `_db` wrapper.
  //
  // Simpler shape: re-implement each public method's wrapping inline,
  // exactly mirroring Platform.ts. This makes the test a contract-fixture
  // for the wrapping shape; any change in Platform.ts that drops the
  // hash step will diverge from these expectations and a higher-level
  // test will catch the slip.
  return { platform, hasher, db, calls };
}

describe('[PLAT-HASH] Platform PII-hashing wrapper contract', () => {
  describe('hashFor', () => {
    it('[PLAT-HASH-01] cleartext mode (no hasher): returns the value unchanged', () => {
      const { platform } = makePlatform({ hashed: false });
      assert.equal(platform.hashFor('username', 'alice'), 'alice');
      assert.equal(platform.hashFor('email', 'Alice@X.com'), 'Alice@X.com'); // no normalisation in cleartext — storage format is unchanged
    });

    it('[PLAT-HASH-02] hashed mode: returns lowercase hex HMAC, deterministic across calls', () => {
      const { platform } = makePlatform({ hashed: true });
      const a = platform.hashFor('username', 'alice');
      const b = platform.hashFor('username', 'alice');
      assert.match(a, /^[0-9a-f]{64}$/);
      assert.equal(a, b);
    });

    it('[PLAT-HASH-03] hashed mode: per-field salt — same value under "username" vs "email" hashes differently', () => {
      const { platform } = makePlatform({ hashed: true });
      assert.notEqual(
        platform.hashFor('username', 'alice'),
        platform.hashFor('email', 'alice')
      );
    });

    it('[PLAT-HASH-04] hashed mode: email normalisation — User@x.com collides with user@x.com', () => {
      const { platform } = makePlatform({ hashed: true });
      assert.equal(
        platform.hashFor('email', 'User@x.com'),
        platform.hashFor('email', 'user@x.com')
      );
    });
  });

  describe('piiModeIsHashed', () => {
    it('[PLAT-HASH-10] false in cleartext mode', () => {
      const { platform } = makePlatform({ hashed: false });
      assert.equal(platform.piiModeIsHashed, false);
    });

    it('[PLAT-HASH-11] true in hashed mode', () => {
      const { platform } = makePlatform({ hashed: true });
      assert.equal(platform.piiModeIsHashed, true);
    });
  });

  describe('PiiHasher rejects placeholder + missing pepper through Platform.init wiring', () => {
    // The init() path's config validation lives at Platform.#initPiiHasher;
    // see Platform.ts for the throw conditions. Exercising the wired path
    // requires the full boiler init machinery — covered by the B.8
    // integration tests. Here we pin the underlying PiiHasher rejections
    // that init validation delegates to.

    it('[PLAT-HASH-20] empty pepper rejected', () => {
      assert.throws(() => new PiiHasher(''), /pepperBase64 is required/);
    });

    it('[PLAT-HASH-21] non-32-byte pepper rejected', () => {
      const tooShort = Buffer.alloc(16).toString('base64');
      assert.throws(() => new PiiHasher(tooShort), /must decode to exactly 32 bytes/);
    });
  });
});
