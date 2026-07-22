/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-TKN-DP] POST /oauth2/token — DPoP (RFC 9449) key binding.
 *
 * Proof handling at the dispatcher (verify-before-any-grant, jti
 * single-use), authorization_code binding via bindAccessDpop, refresh
 * rotation continuity (same key, no mid-chain upgrade/downgrade), and
 * the client_credentials refusal.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { webcrypto } = require('node:crypto');
const { handleToken } = require('../src/routes/token.ts');
const { setCode, setRefresh, getRefresh, revokeDpopKey, listDpopKeysSeen } = require('../src/storage.ts');
const { computeJkt } = require('../src/dpop.ts');

const { subtle } = webcrypto;
const ISSUER = 'https://reg.pryv.me';
const CORE_ID = 'core-a';
const TOKEN_HOST = 'api.example.com';
const TOKEN_HTU = `http://${TOKEN_HOST}/oauth2/token`;

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'core:id': CORE_ID,
    'oauth:accessTokenTTL': 3600,
    'oauth:refreshTokenTTL': 30 * 24 * 3600,
    'oauth:refreshTokenAbsoluteTTL': 90 * 24 * 3600,
    'oauth:dpop:clockSkewSeconds': 120,
    ...overrides,
  };
  return { get: (k) => m[k] };
}

function fakePlatform () {
  const kv = new Map();
  const state = new Map();
  return {
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return Array.from(kv.keys()).filter((k) => k.startsWith(p)); },
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async setAccessStateIfAbsent (k, v, exp) {
      const e = state.get(k);
      if (e != null && Date.now() <= e.expiresAt) return false;
      state.set(k, { value: v, expiresAt: exp });
      return true;
    },
    async getAccessState (k) {
      const e = state.get(k);
      if (e == null) return null;
      if (Date.now() > e.expiresAt) { state.delete(k); return null; }
      return e;
    },
    async deleteAccessState (k) { state.delete(k); },
    async consumeAccessState (k) {
      const e = state.get(k); state.delete(k);
      if (e == null) return null;
      if (Date.now() > e.expiresAt) return null;
      return e;
    },
  };
}

function fakeRes () {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader (k, v) { this.headers[k] = v; },
    end (payload) { this.body = JSON.parse(payload); },
  };
  return res;
}

async function makeKeyPair () {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { pair, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

async function makeProof (key, overrides = {}) {
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk };
  const payload = {
    jti: 'jti-' + crypto.randomUUID(),
    htm: 'POST',
    htu: TOKEN_HTU,
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, Buffer.from(`${h}.${p}`, 'utf8'));
  return `${h}.${p}.${b64url(sig)}`;
}

function tokenReq (body, dpopProof) {
  return {
    body,
    originalUrl: '/oauth2/token',
    url: '/oauth2/token',
    headers: { host: TOKEN_HOST, ...(dpopProof != null ? { dpop: dpopProof } : {}) },
  };
}

const VERIFIER = 'verifier-1234567890-abcdefg-hijklmnop';
function challenge (verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function seedCode (platform, code) {
  await setCode(platform, code, {
    clientId: 'myapp',
    redirectUri: 'https://app.example/cb',
    codeChallenge: challenge(VERIFIER),
    codeChallengeMethod: 'S256',
    userId: 'u-alice',
    username: 'alice',
    scope: ['pryv:read'],
    expiresAt: Date.now() + 60_000,
    accessId: 'acc-u-alice',
    accessToken: 'tok-u-alice-myapp',
    apiEndpoint: 'https://tok@alice.pryv.me/',
  });
}

async function seedRefresh (platform, token, extra = {}) {
  const now = Date.now();
  await setRefresh(platform, CORE_ID, token, {
    clientId: 'myapp',
    userId: 'u-alice',
    username: 'alice',
    scope: ['pryv:read'],
    issuedAt: now,
    lastUsedAt: now,
    expiresAt: now + 3600_000,
    absoluteExpiresAt: now + 7200_000,
    dataGrantAccessId: 'dg-1',
    permissions: [{ streamId: 'health', level: 'read' }],
    ...extra,
  });
}

const MINT_OK = async () => ({ accessId: 'acc-new', accessToken: 'tok-new', apiEndpoint: 'https://new@alice.pryv.me/' });

function codeBody (code) {
  return { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'myapp', redirect_uri: 'https://app.example/cb' };
}

describe('[OAUTH-TKN-DP] /oauth2/token — DPoP key binding', () => {
  let key;
  before(async () => { key = await makeKeyPair(); });

  it('[DPT01] authorization_code + valid proof: binds the access, stamps the refresh row, token_type DPoP', async () => {
    const platform = fakePlatform();
    await seedCode(platform, 'C-DP1');
    const bound = [];
    const handler = handleToken({
      config: fakeConfig(),
      platform,
      bindAccessDpop: async (p) => { bound.push(p); },
    });
    const res = fakeRes();
    await handler(tokenReq(codeBody('C-DP1'), await makeProof(key)), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.token_type, 'DPoP');
    const jkt = computeJkt(key.publicJwk);
    assert.deepEqual(bound, [{ userId: 'u-alice', username: 'alice', accessId: 'acc-u-alice', jkt }]);
    const row = await getRefresh(platform, CORE_ID, res.body.refresh_token);
    assert.equal(row.jkt, jkt);
  });

  it('[DPT02] an invalid proof fails BEFORE the grant: 400 invalid_dpop_proof, code not consumed', async () => {
    const platform = fakePlatform();
    await seedCode(platform, 'C-DP2');
    const handler = handleToken({ config: fakeConfig(), platform, bindAccessDpop: async () => {} });
    const res = fakeRes();
    const proof = await makeProof(key);
    const tampered = proof.slice(0, -4) + 'AAAA';
    await handler(tokenReq(codeBody('C-DP2'), tampered), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_dpop_proof');
    // The code survives — a Bearer exchange still works.
    const res2 = fakeRes();
    await handler(tokenReq(codeBody('C-DP2')), res2);
    assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
    assert.equal(res2.body.token_type, 'Bearer');
  });

  it('[DPT03] jti single-use: replaying the same proof is refused, nothing consumed', async () => {
    const platform = fakePlatform();
    await seedCode(platform, 'C-DP3');
    const handler = handleToken({ config: fakeConfig(), platform, bindAccessDpop: async () => {} });
    const proof = await makeProof(key);
    const res1 = fakeRes();
    await handler(tokenReq({ grant_type: 'authorization_code', code: 'C-MISSING', code_verifier: VERIFIER, client_id: 'myapp', redirect_uri: 'https://app.example/cb' }, proof), res1);
    // First use burned the jti (the grant itself failed on the missing code).
    const res2 = fakeRes();
    await handler(tokenReq(codeBody('C-DP3'), proof), res2);
    assert.equal(res2.statusCode, 400);
    assert.equal(res2.body.error, 'invalid_dpop_proof');
    // The seeded code is untouched by the replayed-proof refusal.
    const res3 = fakeRes();
    await handler(tokenReq(codeBody('C-DP3')), res3);
    assert.equal(res3.statusCode, 200, JSON.stringify(res3.body));
  });

  it('[DPT04] DPoP requested but binding not wired: 500 server_error, code not consumed', async () => {
    const platform = fakePlatform();
    await seedCode(platform, 'C-DP4');
    const handler = handleToken({ config: fakeConfig(), platform });
    const res = fakeRes();
    await handler(tokenReq(codeBody('C-DP4'), await makeProof(key)), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'server_error');
    const res2 = fakeRes();
    await handler(tokenReq(codeBody('C-DP4')), res2);
    assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
  });

  it('[DPT05] bound refresh + proof by the same key: rotates, keeps the binding, mint sees jkt', async () => {
    const platform = fakePlatform();
    const jkt = computeJkt(key.publicJwk);
    await seedRefresh(platform, 'RT-DP5', { jkt });
    const minted = [];
    const handler = handleToken({
      config: fakeConfig(),
      platform,
      mintRefreshedAccess: async (p) => { minted.push(p); return MINT_OK(); },
    });
    const res = fakeRes();
    await handler(tokenReq({ grant_type: 'refresh_token', refresh_token: 'RT-DP5', client_id: 'myapp' }, await makeProof(key)), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.token_type, 'DPoP');
    assert.equal(minted[0].jkt, jkt);
    const newRow = await getRefresh(platform, CORE_ID, res.body.refresh_token);
    assert.equal(newRow.jkt, jkt);
  });

  it('[DPT06] bound refresh WITHOUT a proof: refused (and the rotation is burned — safe direction)', async () => {
    const platform = fakePlatform();
    await seedRefresh(platform, 'RT-DP6', { jkt: computeJkt(key.publicJwk) });
    const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_OK });
    const res = fakeRes();
    await handler(tokenReq({ grant_type: 'refresh_token', refresh_token: 'RT-DP6', client_id: 'myapp' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_dpop_proof');
    assert.equal(await getRefresh(platform, CORE_ID, 'RT-DP6'), null);
  });

  it('[DPT07] bound refresh with a proof by a DIFFERENT key: refused, uniform body', async () => {
    const platform = fakePlatform();
    await seedRefresh(platform, 'RT-DP7', { jkt: computeJkt(key.publicJwk) });
    const otherKey = await makeKeyPair();
    const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_OK });
    const res = fakeRes();
    await handler(tokenReq({ grant_type: 'refresh_token', refresh_token: 'RT-DP7', client_id: 'myapp' }, await makeProof(otherKey)), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_dpop_proof');
    assert.equal(res.body.error_description, 'DPoP proof verification failed');
  });

  it('[DPT08] an UNBOUND chain cannot acquire a binding mid-life', async () => {
    const platform = fakePlatform();
    await seedRefresh(platform, 'RT-DP8');
    const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_OK });
    const res = fakeRes();
    await handler(tokenReq({ grant_type: 'refresh_token', refresh_token: 'RT-DP8', client_id: 'myapp' }, await makeProof(key)), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_dpop_proof');
  });

  it('[DPT09] client_credentials with a proof is refused explicitly', async () => {
    const platform = fakePlatform();
    const handler = handleToken({
      config: fakeConfig(),
      platform,
      mintClientAccess: MINT_OK,
      resolveAccountUserId: async () => 'u-app',
    });
    const res = fakeRes();
    await handler(tokenReq({ grant_type: 'client_credentials', client_id: 'myapp' }, await makeProof(key)), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_request');
    assert.match(res.body.error_description, /client_credentials/);
  });

  it('[DPT10] a proof signed for another endpoint (htu mismatch) is refused', async () => {
    const platform = fakePlatform();
    await seedCode(platform, 'C-DP10');
    const handler = handleToken({ config: fakeConfig(), platform, bindAccessDpop: async () => {} });
    const res = fakeRes();
    await handler(tokenReq(codeBody('C-DP10'), await makeProof(key, { htu: 'https://other.example/oauth2/token' })), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_dpop_proof');
  });

  it('[DPT11] a failing bindAccessDpop refuses issuance with 500 (no half-bound chain)', async () => {
    const platform = fakePlatform();
    await seedCode(platform, 'C-DP11');
    const handler = handleToken({
      config: fakeConfig(),
      platform,
      bindAccessDpop: async () => { throw new Error('storage down'); },
    });
    const res = fakeRes();
    await handler(tokenReq(codeBody('C-DP11'), await makeProof(key)), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'server_error');
  });

  it('[RJKT21a] authorization_code with a proof for an operator-REVOKED key: refused, code not consumed, no bind', async () => {
    const platform = fakePlatform();
    await seedCode(platform, 'C-RJ21');
    await revokeDpopKey(platform, computeJkt(key.publicJwk));
    const bound = [];
    const handler = handleToken({ config: fakeConfig(), platform, bindAccessDpop: async (p) => { bound.push(p); } });
    const res = fakeRes();
    await handler(tokenReq(codeBody('C-RJ21'), await makeProof(key)), res);
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'invalid_dpop_proof');
    assert.equal(bound.length, 0, 'a revoked key must not bind an access');
    // The code was NOT consumed — a plain Bearer exchange still works.
    const res2 = fakeRes();
    await handler(tokenReq(codeBody('C-RJ21')), res2);
    assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
    assert.equal(res2.body.token_type, 'Bearer');
  });

  it('[RJKT21b] refresh rotation onto a REVOKED key: refused, refresh row not consumed (chain not silently killed by the check)', async () => {
    const platform = fakePlatform();
    await seedRefresh(platform, 'RT-RJ21', { jkt: computeJkt(key.publicJwk) });
    await revokeDpopKey(platform, computeJkt(key.publicJwk));
    const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_OK });
    const res = fakeRes();
    await handler(tokenReq({ grant_type: 'refresh_token', refresh_token: 'RT-RJ21', client_id: 'myapp' }, await makeProof(key)), res);
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'invalid_dpop_proof');
    // The revoke check runs BEFORE the grant, so the refresh row is untouched
    // (the resource-server enforcement is what kills any live tokens).
    assert.ok(await getRefresh(platform, CORE_ID, 'RT-RJ21') != null, 'refresh row must survive the pre-grant revoke refusal');
  });

  // Let the fire-and-forget inventory write (recordDpopKeySeen, not awaited by
  // the handler) settle before asserting.
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('[KINV10a] a successful bound issuance records the (clientId, jkt) in the key inventory', async () => {
    const platform = fakePlatform();
    await seedCode(platform, 'C-KV10');
    const handler = handleToken({ config: fakeConfig(), platform, bindAccessDpop: async () => {} });
    const res = fakeRes();
    await handler(tokenReq(codeBody('C-KV10'), await makeProof(key)), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    await settle();
    const seen = await listDpopKeysSeen(platform);
    assert.equal(seen.length, 1);
    assert.deepEqual({ clientId: seen[0].clientId, jkt: seen[0].jkt }, { clientId: 'myapp', jkt: computeJkt(key.publicJwk) });
  });

  it('[KINV10b] a FAILED grant (valid proof, missing code) records nothing', async () => {
    const platform = fakePlatform();
    const handler = handleToken({ config: fakeConfig(), platform, bindAccessDpop: async () => {} });
    const res = fakeRes();
    // Valid proof (dpopJkt is set) but the code is absent → outcome not ok.
    await handler(tokenReq(codeBody('C-MISSING-KV'), await makeProof(key)), res);
    assert.notEqual(res.statusCode, 200);
    await settle();
    assert.equal((await listDpopKeysSeen(platform)).length, 0, 'no inventory row on a failed issuance');
  });

  it('[KINV10c] issuance still succeeds when the advisory inventory write throws (fire-and-forget)', async () => {
    const base = fakePlatform();
    // A platform whose setPlatformKv fails ONLY for the seen keyspace.
    const platform = {
      ...base,
      async setPlatformKv (k, v) {
        if (k.startsWith('dpop-jkt-seen/')) throw new Error('inventory store down');
        return base.setPlatformKv(k, v);
      },
    };
    await seedCode(platform, 'C-KV10c');
    const handler = handleToken({ config: fakeConfig(), platform, bindAccessDpop: async () => {} });
    const res = fakeRes();
    await handler(tokenReq(codeBody('C-KV10c'), await makeProof(key)), res);
    assert.equal(res.statusCode, 200, 'a failing inventory write must not break issuance: ' + JSON.stringify(res.body));
    await settle();
  });
});
