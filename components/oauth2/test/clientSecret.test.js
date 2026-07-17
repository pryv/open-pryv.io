/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-CS] OAuth2 — client_secret helpers (mint + verify).
 */

const assert = require('node:assert/strict');
const { mintSecret, verifySecret } = require('../src/clientSecret.ts');

describe('[OAUTH-CS] client_secret helpers', () => {
  it('[OCS1] mintSecret returns plaintext + hash; round-trip verifies', async () => {
    const { plaintext, hash } = await mintSecret();
    assert.equal(typeof plaintext, 'string');
    assert.equal(typeof hash, 'string');
    assert.ok(plaintext.length >= 32, 'plaintext should be at least 32 base64url chars (~256 bits)');
    assert.match(plaintext, /^[A-Za-z0-9_-]+$/, 'plaintext should be base64url-safe');
    assert.equal(await verifySecret(plaintext, hash), true);
  });

  it('[OCS2] verifySecret rejects a wrong plaintext', async () => {
    const { plaintext, hash } = await mintSecret();
    assert.equal(await verifySecret(plaintext + 'x', hash), false);
  });

  it('[OCS3] verifySecret returns false (never throws) on empty inputs', async () => {
    const { hash } = await mintSecret();
    assert.equal(await verifySecret('', hash), false);
    assert.equal(await verifySecret('any', ''), false);
    assert.equal(await verifySecret(null, hash), false);
    assert.equal(await verifySecret('any', null), false);
  });

  it('[OCS4] verifySecret returns false on a malformed hash (bcrypt throws internally → swallowed)', async () => {
    assert.equal(await verifySecret('anything', 'not-a-real-bcrypt-hash'), false);
  });

  it('[OCS5] two mints produce different plaintexts (random)', async () => {
    const a = await mintSecret();
    const b = await mintSecret();
    assert.notEqual(a.plaintext, b.plaintext);
    assert.notEqual(a.hash, b.hash);
  });
});
