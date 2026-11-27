/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('chai').assert;
const crypto = require('node:crypto');

const {
  createTokenProtection, resolveTokenProtection, candidateProtectionsFromKeyText
} = require('../../src/accesses/tokenProtection.ts');

const configOf = (values) => ({ get: (key) => values[key] });

/**
 * [TKPA] the protection object that keeps access tokens and session ids out
 * of the database in clear: keyed hash for lookups, sealed copy for display.
 */
describe('[TKPA] accesses/tokenProtection', () => {
  const tp = createTokenProtection('some admin key');

  it('[TKPA1] same user and token give the same hash; another user or token another one; the hash carries the kid', () => {
    const h = tp.hashAccessToken('user-a', 'token-1');
    assert.equal(tp.hashAccessToken('user-a', 'token-1'), h);
    assert.notEqual(tp.hashAccessToken('user-b', 'token-1'), h);
    assert.notEqual(tp.hashAccessToken('user-a', 'token-2'), h);
    assert.match(tp.kid, /^[0-9a-f]{8}$/);
    assert.isTrue(h.startsWith(tp.kid + '.'));
    assert.isTrue(tp.ownsHash(h));
    assert.notInclude(h, 'token-1');
    // full 256-bit HMAC output, base64url
    assert.match(h.slice(9), /^[A-Za-z0-9_-]{43}$/);
    // user id and token are separated: ('ab','c') and ('a','bc') differ
    assert.notEqual(tp.hashAccessToken('ab', 'c'), tp.hashAccessToken('a', 'bc'));
    // sessions hash with their own key
    assert.notEqual(tp.hashSessionId('token-1'), tp.hashAccessToken('', 'token-1'));
    assert.isTrue(tp.hashSessionId('token-1').startsWith(tp.kid + '.'));
    const other = createTokenProtection('another admin key');
    assert.notEqual(other.kid, tp.kid);
    assert.isFalse(other.ownsHash(h));
  });

  it('[TKPA2] seal then open returns the token; another user, hash or key does not open', () => {
    const h = tp.hashAccessToken('user-a', 'token-1');
    const enc = tp.sealAccessToken('user-a', h, 'token-1');
    assert.notInclude(enc, 'token-1');
    assert.equal(tp.openAccessToken('user-a', h, enc), 'token-1');
    // fresh IV per seal
    assert.notEqual(tp.sealAccessToken('user-a', h, 'token-1'), enc);
    assert.throws(() => tp.openAccessToken('user-b', h, enc), /does not open/);
    assert.throws(() => tp.openAccessToken('user-a', tp.hashAccessToken('user-a', 'x'), enc), /does not open/);
    const other = createTokenProtection('another admin key');
    assert.throws(() => other.openAccessToken('user-a', h, enc), /does not open/);
    try { other.openAccessToken('user-a', h, enc); } catch (e) { assert.equal(e.name, 'TokenUnreadableError'); }
    const sh = tp.hashSessionId('sid');
    const senc = tp.sealSessionId(sh, 'sid');
    assert.equal(tp.openSessionId(sh, senc), 'sid');
    assert.throws(() => tp.openSessionId(tp.hashSessionId('sid2'), senc), /does not open/);
    // an access envelope is not a session envelope
    assert.throws(() => tp.openSessionId(h, enc), /does not open/);
  });

  it('[TKPA3] the dedicated key wins over auth.adminAccessKey; a wrong-length key or no key throws', () => {
    const dedicated = crypto.randomBytes(32).toString('base64');
    const fromDedicated = resolveTokenProtection(configOf({ 'auth:accessTokensKey': dedicated, 'auth:adminAccessKey': 'k' }));
    const fromAdmin = resolveTokenProtection(configOf({ 'auth:accessTokensKey': '', 'auth:adminAccessKey': 'k' }));
    assert.notEqual(fromDedicated.kid, fromAdmin.kid);
    assert.equal(fromDedicated.kid, createTokenProtection(Buffer.from(dedicated, 'base64')).kid);
    assert.equal(fromAdmin.kid, createTokenProtection('k').kid);
    assert.throws(() => resolveTokenProtection(configOf({ 'auth:accessTokensKey': crypto.randomBytes(16).toString('base64') })), /32 bytes/);
    assert.throws(() => resolveTokenProtection(configOf({})), /no key/);
    assert.throws(() => resolveTokenProtection(configOf({ 'auth:adminAccessKey': '' })), /no key/);
    // a previous key file stands for either form; the caller keeps the matching kid
    const kids = candidateProtectionsFromKeyText(dedicated + '\n').map((x) => x.kid);
    assert.include(kids, fromDedicated.kid);
    assert.deepEqual(candidateProtectionsFromKeyText('k\n').map((x) => x.kid), [fromAdmin.kid]);
  });
});
