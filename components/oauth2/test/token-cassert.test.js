/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-TKN-PKJ] POST /oauth2/token — private_key_jwt client
 * authentication (RFC 7521/7523) on the authorization_code and
 * client_credentials grants. Real P-256 key pairs + real ES256
 * assertions signed with node:crypto webcrypto — no mocked crypto.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { webcrypto } = require('node:crypto');
const { handleToken } = require('../src/routes/token.ts');
const { setCode } = require('../src/storage.ts');
const { mintSecret } = require('../src/clientSecret.ts');
const { CLIENT_ASSERTION_TYPE } = require('../src/clientAssertion.ts');

const { subtle } = webcrypto;

const ISSUER = 'https://reg.pryv.me';
const TOKEN_ENDPOINT = ISSUER + '/oauth2/token';
const CORE_ID = 'core-a';
const CLIENT_ID = 'myapp';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'core:id': CORE_ID,
    'oauth:accessTokenTTL': 3600,
    'oauth:refreshTokenTTL': 30 * 24 * 3600,
    'oauth:refreshTokenAbsoluteTTL': 90 * 24 * 3600,
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
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ? JSON.parse(b) : null; },
  };
}

async function makeKeyPair () {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { pair, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

async function makeAssertion (key, over = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = {
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: TOKEN_ENDPOINT,
    jti: 'jti-' + crypto.randomUUID(),
    exp: nowSec + 120,
    iat: nowSec,
    ...over,
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, Buffer.from(`${h}.${p}`, 'utf8'));
  return `${h}.${p}.${b64url(sig)}`;
}

async function registerClient (platform, meta) {
  await platform.setPlatformKv('oauth-client/' + CLIENT_ID, JSON.stringify({
    clientId: CLIENT_ID,
    redirectUris: ['https://app.example/cb'],
    scope: ['pryv:read', 'pryv:write'],
    grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
    accountUsername: CLIENT_ID,
    ...meta,
  }));
}

const VERIFIER = 'verifier-1234567890-abcdefg-hijklmnop';
function challenge (v) {
  return crypto.createHash('sha256').update(v).digest('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function seedCode (platform, code) {
  await setCode(platform, code, {
    clientId: CLIENT_ID,
    redirectUri: 'https://app.example/cb',
    codeChallenge: challenge(VERIFIER),
    codeChallengeMethod: 'S256',
    userId: 'u-alice',
    username: 'alice',
    scope: ['pryv:read'],
    expiresAt: Date.now() + 60_000,
    accessId: 'acc-u-alice',
    accessToken: 'tok-u-alice-myapp',
    apiEndpoint: 'https://alice.pryv.me/',
  });
}
function codeBody (code, assertion, extra = {}) {
  return {
    grant_type: 'authorization_code',
    code,
    code_verifier: VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: 'https://app.example/cb',
    ...(assertion != null ? { client_assertion: assertion, client_assertion_type: CLIENT_ASSERTION_TYPE } : {}),
    ...extra,
  };
}

const MINT_CLIENT = async ({ username, clientId }) => ({
  accessId: 'acc-cc', accessToken: 'cc-tok-' + clientId, apiEndpoint: 'https://' + username + '.pryv.me/',
});
const RESOLVE_ACCOUNT = async (username) => (username === CLIENT_ID ? 'u-' + username : null);

describe('[OAUTH-TKN-PKJ] /oauth2/token — private_key_jwt client auth', () => {
  let key;
  before(async () => { key = await makeKeyPair(); });

  // A failed authorization_code exchange (after the code is consumed) self-revokes
  // the pre-minted access via an HTTP DELETE. Stub fetch so those revokes do not
  // reach the network (the revoke failure is swallowed either way).
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; globalThis.fetch = async () => ({ status: 200 }); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  describe('[OAUTH-TKN-PKJ-AC] authorization_code grant', () => {
    it('[OTPK1] valid assertion authenticates a jwks-registered client → 200', async () => {
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      await seedCode(platform, 'PKJ-1');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: codeBody('PKJ-1', await makeAssertion(key)) }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.token_type, 'Bearer');
    });

    it('[OTPK2] an assertion signed by an unregistered key → 401 invalid_client', async () => {
      const other = await makeKeyPair();
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      await seedCode(platform, 'PKJ-2');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: codeBody('PKJ-2', await makeAssertion(other)) }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });

    it('[OTPK3] jti single-use: replaying the same assertion jti → 401 invalid_client', async () => {
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      await seedCode(platform, 'PKJ-3a');
      await seedCode(platform, 'PKJ-3b');
      const handler = handleToken({ config: fakeConfig(), platform });
      const assertion = await makeAssertion(key, { jti: 'replay-once' });
      const r1 = fakeRes();
      await handler({ body: codeBody('PKJ-3a', assertion) }, r1);
      assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
      // Same assertion (same jti) again on a fresh code → refused.
      const r2 = fakeRes();
      await handler({ body: codeBody('PKJ-3b', assertion) }, r2);
      assert.equal(r2.statusCode, 401);
      assert.equal(r2.body.error, 'invalid_client');
    });

    it('[OTPK4] a bad assertion fails even when a valid secret is also presented (precedence)', async () => {
      const other = await makeKeyPair();
      const { plaintext, hash } = await mintSecret();
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] }, clientSecretHash: hash });
      await seedCode(platform, 'PKJ-4a');
      await seedCode(platform, 'PKJ-4b');
      const handler = handleToken({ config: fakeConfig(), platform });
      // Bad assertion (wrong key) + valid secret → assertion takes precedence → 401.
      const r1 = fakeRes();
      await handler({ body: codeBody('PKJ-4a', await makeAssertion(other), { client_secret: plaintext }) }, r1);
      assert.equal(r1.statusCode, 401);
      assert.equal(r1.body.error, 'invalid_client');
      // Same client authenticates fine with the secret alone (no assertion).
      const r2 = fakeRes();
      await handler({ body: codeBody('PKJ-4b', null, { client_secret: plaintext }) }, r2);
      assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
    });

    it('[OTPK5] wrong client_assertion_type → 401 invalid_client', async () => {
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      await seedCode(platform, 'PKJ-5');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: codeBody('PKJ-5', await makeAssertion(key), { client_assertion_type: 'wrong-type' }) }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });

    it('[OTPK6] an assertion with an aud for a different server → 401 invalid_client', async () => {
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      await seedCode(platform, 'PKJ-6');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: codeBody('PKJ-6', await makeAssertion(key, { aud: 'https://evil.example/oauth2/token' })) }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });
  });

  describe('[OAUTH-TKN-PKJ-CC] client_credentials grant', () => {
    function ccDeps (platform) {
      return { config: fakeConfig(), platform, mintClientAccess: MINT_CLIENT, resolveAccountUserId: RESOLVE_ACCOUNT };
    }
    it('[OTPK7] valid assertion → 200 with access_token, NO refresh_token', async () => {
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      const handler = handleToken(ccDeps(platform));
      const res = fakeRes();
      await handler({ body: { grant_type: 'client_credentials', client_id: CLIENT_ID, client_assertion: await makeAssertion(key), client_assertion_type: CLIENT_ASSERTION_TYPE } }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.token_type, 'Bearer');
      assert.equal(res.body.refresh_token, undefined);
    });

    it('[OTPK8] wrong-key assertion → 401 invalid_client', async () => {
      const other = await makeKeyPair();
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      const handler = handleToken(ccDeps(platform));
      const res = fakeRes();
      await handler({ body: { grant_type: 'client_credentials', client_id: CLIENT_ID, client_assertion: await makeAssertion(other), client_assertion_type: CLIENT_ASSERTION_TYPE } }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });

    it('[OTPK9] a jwks-only client presenting NO credential → 401 invalid_client', async () => {
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      const handler = handleToken(ccDeps(platform));
      const res = fakeRes();
      await handler({ body: { grant_type: 'client_credentials', client_id: CLIENT_ID } }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });

    it('[OTPK10] jti single-use across client_credentials calls', async () => {
      const platform = fakePlatform();
      await registerClient(platform, { jwks: { keys: [key.publicJwk] } });
      const handler = handleToken(ccDeps(platform));
      const assertion = await makeAssertion(key, { jti: 'cc-once' });
      const r1 = fakeRes();
      await handler({ body: { grant_type: 'client_credentials', client_id: CLIENT_ID, client_assertion: assertion, client_assertion_type: CLIENT_ASSERTION_TYPE } }, r1);
      assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
      const r2 = fakeRes();
      await handler({ body: { grant_type: 'client_credentials', client_id: CLIENT_ID, client_assertion: assertion, client_assertion_type: CLIENT_ASSERTION_TYPE } }, r2);
      assert.equal(r2.statusCode, 401);
      assert.equal(r2.body.error, 'invalid_client');
    });
  });
});
