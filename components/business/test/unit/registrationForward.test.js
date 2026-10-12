/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { signRegistrationForward, verifyRegistrationForward } = require('../../src/auth/registrationForward.ts');

describe('[RGFW] signed registration forward', function () {
  const body = JSON.stringify({ username: 'alice', hosting: 'h1' });

  it('[RGFW1] verifies for the same key and body, within 60 s', function () {
    const header = signRegistrationForward('k-0123456789', 'core-a', '203.0.113.9', body, 1_000_000);
    assert.deepStrictEqual(verifyRegistrationForward(header, 'k-0123456789', body, 1_030_000), { from: 'core-a', client: '203.0.113.9' });
    assert.strictEqual(verifyRegistrationForward(header, 'k-0123456789', body, 1_061_000), null, 'too old');
    assert.strictEqual(verifyRegistrationForward(header, 'other-key', body, 1_000_000), null, 'other key');
    assert.strictEqual(verifyRegistrationForward(header, 'k-0123456789', body.replace('h1', 'h2'), 1_000_000), null, 'other body');
  });

  it('[RGFW2] with no key configured nothing verifies (no "undefined" key)', function () {
    const forged = signRegistrationForward('undefined', 'core-a', '198.51.100.1', body, 1_000_000);
    for (const key of [undefined, null, '', 42]) {
      assert.strictEqual(verifyRegistrationForward(forged, key, body, 1_000_000), null, String(key));
    }
  });
});
