/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('chai').assert;
const { createHash, createHmac } = require('node:crypto');
const { getConfigSync } = require('@pryv/boiler');

const { storeKeyHash, STORE_KEY_HASH_PURPOSE } = require('../../src/auth/storeKeyHash.ts');
const { deriveKey } = require('../../src/acme/AtRestEncryption.ts');
const { ipKey } = require('../../src/auth/passwordResetThrottle.ts');
const { challengeKey } = require('../../src/emails/challenge.ts');
const { addressBucket } = require('middleware/src/clientIp.ts');

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/**
 * [SKHA] store keys built from a client address or an email are keyed hashes:
 * a listing of the platform database cannot be reversed by enumerating
 * addresses or running a mailing list through sha256.
 */
describe('[SKHA] auth/storeKeyHash', () => {
  it('[SKHA1] is an HMAC under a key derived from auth.adminAccessKey, not a plain sha256', () => {
    const secret = getConfigSync().get('auth:adminAccessKey');
    assert.isString(secret);
    assert.isAbove(secret.length, 0);
    const key = deriveKey(secret, STORE_KEY_HASH_PURPOSE);
    const value = '203.0.113.7';
    assert.strictEqual(storeKeyHash(value), createHmac('sha256', key).update(value).digest('hex'));
    assert.notStrictEqual(storeKeyHash(value), sha256(value));
    assert.strictEqual(storeKeyHash(value), storeKeyHash(value), 'deterministic, so every core finds the same row');
  });

  it('[SKHA2] the password-reset address budget is keyed, IPv6 still grouped by /64', () => {
    const ip = '203.0.113.7';
    assert.strictEqual(ipKey(ip), 'password-reset-ip/' + storeKeyHash(addressBucket(ip)));
    assert.notStrictEqual(ipKey(ip), 'password-reset-ip/' + sha256(addressBucket(ip)));
    assert.strictEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:2::ffff'));
  });

  it('[SKHA3] the email challenge rows are keyed on the normalised address', () => {
    assert.strictEqual(challengeKey('Bob@Example.com'), 'email-challenge/' + storeKeyHash('bob@example.com'));
    assert.notStrictEqual(challengeKey('Bob@Example.com'), 'email-challenge/' + sha256('bob@example.com'));
  });

  it('[SKHA4] the /reg/access creation budget reference is keyed', () => {
    const { ipRefOf } = require('api-server/src/routes/reg/accessState.ts');
    const ip = '198.51.100.20';
    assert.strictEqual(ipRefOf(ip), storeKeyHash(addressBucket(ip)).slice(0, 32));
    assert.notStrictEqual(ipRefOf(ip), sha256(addressBucket(ip)).slice(0, 32));
    assert.isNull(ipRefOf(''));
  });
});
