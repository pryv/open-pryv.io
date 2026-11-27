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

  it('[TKPA4] the openers refuse a version-1 envelope, even one sealed under the right key', () => {
    const { deriveKey, encrypt } = require('../../src/acme/AtRestEncryption.ts');
    const h = tp.hashAccessToken('user-a', 'token-1');
    const v1 = encrypt('token-1', deriveKey('some admin key', 'access-token-enc-v1'), '', 1);
    assert.throws(() => tp.openAccessToken('user-a', h, v1), /does not open/);
    const sh = tp.hashSessionId('sid');
    const sv1 = encrypt('sid', deriveKey('some admin key', 'session-id-enc-v1'), '', 1);
    assert.throws(() => tp.openSessionId(sh, sv1), /does not open/);
    // the same keys open their version-2 envelopes
    assert.equal(tp.openAccessToken('user-a', h, tp.sealAccessToken('user-a', h, 'token-1')), 'token-1');
  });

  it('[TKPA5] a set auth.accessTokensKey that is a placeholder refuses the boot; empty or random passes', () => {
    const { checkOptionalSecrets } = require('../../../../config/plugins/config-validation.js');
    const problemsFor = (accessTokensKey) => {
      const all = { auth: { adminAccessKey: 'admin-key-'.repeat(4), accessTokensKey } };
      const get = (key) => key.split(':').reduce((node, seg) => (node == null ? undefined : node[seg]), all);
      const p = [];
      checkOptionalSecrets({ get }, p);
      return p.filter((x) => x.payload?.path === 'auth:accessTokensKey');
    };
    for (const v of ['REPLACE_ME', '$' + '{ACCESS_TOKENS_KEY}', 'changeme', 42]) {
      assert.lengthOf(problemsFor(v), 1, JSON.stringify(v));
    }
    for (const v of ['', undefined, crypto.randomBytes(32).toString('base64')]) {
      assert.lengthOf(problemsFor(v), 0, JSON.stringify(v));
    }
  });

  describe('[TKBT] the start: tokensAtRestAtBoot', () => {
    const { tokensAtRestAtBoot } = require('storages/interfaces/_shared/tokenProtection.ts');
    function run (autoRun, { probe, protect }) {
      const out = { log: [], warn: [], protected: 0 };
      const tokensAtRest = {
        probeTokensAtRest: async () => probe,
        protectTokensAtRest: async () => { out.protected++; return protect; }
      };
      const p = tokensAtRestAtBoot({ tokensAtRest, autoRun, log: (m) => out.log.push(m), warn: (m) => out.warn.push(m) });
      return p.then(() => out);
    }

    it('[TKBT1] autoRunOnStart false: rows waiting for the conversion refuse the start, naming migrate up', async () => {
      let err = null;
      try { await run(false, { probe: { columnsReady: true, clearRows: true } }); } catch (e) { err = e; }
      assert.isNotNull(err);
      assert.match(err.message, /Refusing to start/);
      assert.match(err.message, /bin\/migrate\.js up/);
    });

    it('[TKBT2] autoRunOnStart false: the migration pending only warns; nothing in clear is silent; nothing converted', async () => {
      const pending = await run(false, { probe: { columnsReady: false, clearRows: true } });
      assert.lengthOf(pending.warn, 1);
      assert.match(pending.warn[0], /migrate\.js up/);
      const clean = await run(false, { probe: { columnsReady: true, clearRows: false } });
      assert.deepEqual([clean.warn, clean.log, clean.protected], [[], [], 0]);
      assert.equal(pending.protected, 0);
    });

    it('[TKBT3] autoRunOnStart true: converts, logs the counts, warns with the remedy when rows were left in clear', async () => {
      const res = await run(true, { protect: { accesses: 3, accessesSkipped: 2, sessions: 0, sessionsExpired: 0 } });
      assert.equal(res.protected, 1);
      assert.lengthOf(res.log, 1);
      assert.include(res.log[0], 'accesses: 3');
      assert.notInclude(res.log[0], 'accessesSkipped');
      assert.lengthOf(res.warn, 1);
      assert.include(res.warn[0], '2 access row(s) left in clear');
      assert.match(res.warn[0], /delete one of the two accesses/);
      assert.include(res.warn[0], 'access-tokens.js status');
      const quiet = await run(true, { protect: { accesses: 0, accessesSkipped: 0, sessions: 0, sessionsExpired: 0 } });
      assert.deepEqual([quiet.log, quiet.warn], [[], []]);
    });
  });
});
