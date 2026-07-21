/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — unit tests for the key and signature primitives.
 *
 * These cover the parts that must be right regardless of transport: key
 * generation entropy, the composite `<eventId>.<random>` parse (which must
 * survive hostile input), hash-only storage, the expiry predicate, and
 * constant-time comparison of both signature types.
 *
 * The module is required lazily inside `before` so that, while the
 * implementation does not exist yet, this suite reports as a failing test
 * rather than crashing the component's mocha load.
 */

/* global assert */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const crypto = require('node:crypto');

describe('[SHSK] shared-secret key & signature primitives', function () {
  let key;

  before(function () {
    key = require('../src/key.ts');
  });

  describe('[SHSK-GEN] generation', function () {
    it('[SHS37] mints a composite key carrying at least 192 bits of entropy', function () {
      const eventId = 'ck0000000000000000000000';
      const minted = key.mint(eventId);
      assert.strictEqual(minted.key.slice(0, eventId.length + 1), eventId + '.');
      const randomPart = minted.key.slice(eventId.length + 1);
      // base64url of 24 bytes = 32 chars, no padding.
      assert.ok(randomPart.length >= 32, 'random part too short: ' + randomPart);
      assert.match(randomPart, /^[A-Za-z0-9_-]+$/);
    });

    it('[SHS38] never repeats a random half', function () {
      const seen = new Set();
      for (let i = 0; i < 500; i++) {
        seen.add(key.mint('ck0000000000000000000000').key);
      }
      assert.strictEqual(seen.size, 500);
    });

    it('[SHS39] returns the storable hash, and only the hash, alongside the key', function () {
      const minted = key.mint('ck0000000000000000000000');
      const randomPart = minted.key.slice('ck0000000000000000000000'.length + 1);
      const expected = crypto.createHash('sha256').update(randomPart).digest('hex');
      assert.strictEqual(minted.keyHash, expected);
      assert.ok(!minted.keyHash.includes(randomPart),
        'the hash must not embed the clear random half');
    });
  });

  describe('[SHSK-PARSE] parsing hostile input', function () {
    it('[SHS40] parses a well-formed key into its id and random half', function () {
      const parsed = key.parse('ck0000000000000000000000.AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
      assert.strictEqual(parsed.eventId, 'ck0000000000000000000000');
      assert.strictEqual(parsed.randomPart, 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
    });

    it('[SHS41] returns null — never throws — on malformed input', function () {
      const hostile = [
        '', '.', 'no-separator', 'a.', '.b', null, undefined, 42, {},
        'a'.repeat(10000),
        'id.with.too.many.dots',
        '../../etc/passwd.AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
        "id'; DROP TABLE events;--.AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
        'id.AAAA BBBB'
      ];
      for (const input of hostile) {
        assert.strictEqual(key.parse(input), null,
          'expected null for ' + JSON.stringify(input));
      }
    });
  });

  describe('[SHSK-EXP] expiry predicate', function () {
    it('[SHS42] expires exactly when now > time + duration', function () {
      const time = 1_000_000;
      const duration = 300;
      assert.strictEqual(key.isExpired({ time, duration }, time + 299), false);
      assert.strictEqual(key.isExpired({ time, duration }, time + 300), false,
        'the boundary instant is still valid');
      assert.strictEqual(key.isExpired({ time, duration }, time + 301), true);
    });

    it('[SHS43] treats a missing or null duration as already expired, never as eternal', function () {
      const time = 1_000_000;
      for (const duration of [null, undefined, 0, -1]) {
        assert.strictEqual(key.isExpired({ time, duration }, time + 1), true,
          'duration=' + duration + ' must not yield an immortal secret');
      }
    });
  });

  describe('[SHSK-SIG] signature verification', function () {
    it('[SHS44] "secret" type accepts the exact value and rejects anything else', function () {
      const sig = { type: 'secret', value: 'passphrase' };
      assert.strictEqual(key.verifySignature(sig, { type: 'secret', payload: 'passphrase' }, 'k'), true);
      for (const payload of ['Passphrase', 'passphrase ', '', null, undefined, 'x']) {
        assert.strictEqual(key.verifySignature(sig, { type: 'secret', payload }, 'k'), false,
          'must reject payload ' + JSON.stringify(payload));
      }
    });

    it('[SHS45] "hmac-sha256" accepts a payload computed with the same verifier secret', function () {
      const theKey = 'ck0000000000000000000000.AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';
      const payload = crypto.createHmac('sha256', 'V').update(theKey).digest('hex');
      const sig = { type: 'hmac-sha256', value: payload };
      assert.strictEqual(
        key.verifySignature(sig, { type: 'hmac-sha256', payload }, theKey), true);
      const wrong = crypto.createHmac('sha256', 'other').update(theKey).digest('hex');
      assert.strictEqual(
        key.verifySignature(sig, { type: 'hmac-sha256', payload: wrong }, theKey), false);
    });

    it('[SHS46] a payload of the wrong type never validates', function () {
      const sig = { type: 'secret', value: 'passphrase' };
      for (const given of [null, undefined, {}, { type: 'hmac-sha256', payload: 'passphrase' }]) {
        assert.strictEqual(key.verifySignature(sig, given, 'k'), false,
          'must reject ' + JSON.stringify(given));
      }
    });

    it('[SHS47] no signature configured means no payload is required', function () {
      assert.strictEqual(key.verifySignature(null, undefined, 'k'), true);
      assert.strictEqual(key.verifySignature(undefined, undefined, 'k'), true);
    });

    it('[SHS48] comparisons are length-safe (no throw on absurd payloads)', function () {
      const sig = { type: 'secret', value: 'passphrase' };
      assert.strictEqual(
        key.verifySignature(sig, { type: 'secret', payload: 'x'.repeat(100000) }, 'k'), false);
    });
  });
});
