/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-TKN-AC] POST /oauth2/token — grant_type=authorization_code.
 *
 * Exchange flow, PKCE verification, code reuse, client/redirect
 * mismatch, response shape + cache headers.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { handleToken } = require('../src/routes/token.ts');
const { setCode } = require('../src/storage.ts');

const ISSUER = 'https://reg.pryv.me';
const CORE_ID = 'core-a';

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
    async getAccessState (k) {
      const e = state.get(k);
      if (e == null) return null;
      if (Date.now() > e.expiresAt) { state.delete(k); return null; }
      return e;
    },
    async deleteAccessState (k) { state.delete(k); },
  };
}

function pkceVerifier () { return 'verifier-1234567890-abcdefg-hijklmnop'; }
function pkceChallenge (verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function seedCode (platform, code, overrides = {}) {
  const verifier = pkceVerifier();
  await setCode(platform, CORE_ID, code, {
    clientId: 'myapp',
    redirectUri: 'https://app.example/cb',
    codeChallenge: pkceChallenge(verifier),
    codeChallengeMethod: 'S256',
    userId: 'u-alice',
    username: 'alice',
    scope: ['pryv:read'],
    expiresAt: Date.now() + 60_000,
    accessId: 'acc-u-alice',
    accessToken: 'tok-u-alice-myapp',
    apiEndpoint: 'https://alice.pryv.me/',
    ...overrides,
  });
  return verifier;
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

describe('[OAUTH-TKN-AC] /oauth2/token — authorization_code grant', () => {
  describe('[OAUTH-TKN-AC-OK] happy path', () => {
    it('[OTA-OK1] valid exchange returns access_token + refresh_token + expires_in + scope + apiEndpoint', async () => {
      const platform = fakePlatform();
      const verifier = await seedCode(platform, 'CODE-OK1');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({
        body: {
          grant_type: 'authorization_code',
          code: 'CODE-OK1',
          code_verifier: verifier,
          client_id: 'myapp',
          redirect_uri: 'https://app.example/cb',
        }
      }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.token_type, 'Bearer');
      assert.equal(res.body.access_token, 'tok-u-alice-myapp');
      assert.equal(res.body.scope, 'pryv:read');
      assert.equal(res.body.expires_in, 3600);
      assert.equal(res.body.apiEndpoint, 'https://alice.pryv.me/');
      assert.ok(typeof res.body.refresh_token === 'string' && res.body.refresh_token.length > 5);
    });
    it('[OTA-OK2] response carries Cache-Control: no-store + Pragma: no-cache', async () => {
      const platform = fakePlatform();
      const verifier = await seedCode(platform, 'CODE-OK2');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({
        body: {
          grant_type: 'authorization_code',
          code: 'CODE-OK2',
          code_verifier: verifier,
          client_id: 'myapp',
          redirect_uri: 'https://app.example/cb',
        }
      }, res);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers.pragma, 'no-cache');
    });
  });

  describe('[OAUTH-TKN-AC-REUSE] code reuse / invalid code', () => {
    it('[OTA-R1] reusing a code after success → invalid_grant', async () => {
      const platform = fakePlatform();
      const verifier = await seedCode(platform, 'CODE-R1');
      const handler = handleToken({ config: fakeConfig(), platform });
      const params = {
        grant_type: 'authorization_code',
        code: 'CODE-R1',
        code_verifier: verifier,
        client_id: 'myapp',
        redirect_uri: 'https://app.example/cb',
      };
      const r1 = fakeRes(); await handler({ body: params }, r1);
      assert.equal(r1.statusCode, 200);
      const r2 = fakeRes(); await handler({ body: params }, r2);
      assert.equal(r2.statusCode, 400);
      assert.equal(r2.body.error, 'invalid_grant');
    });
    it('[OTA-R2] unknown code → invalid_grant (same shape as reuse)', async () => {
      const platform = fakePlatform();
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({
        body: {
          grant_type: 'authorization_code',
          code: 'NEVER-ISSUED',
          code_verifier: pkceVerifier(),
          client_id: 'myapp',
          redirect_uri: 'https://app.example/cb',
        }
      }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_grant');
    });
  });

  describe('[OAUTH-TKN-AC-PKCE] PKCE verification', () => {
    it('[OTA-P1] wrong verifier → invalid_grant; code consumed (single-use even on PKCE fail)', async () => {
      const platform = fakePlatform();
      await seedCode(platform, 'CODE-P1');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({
        body: {
          grant_type: 'authorization_code',
          code: 'CODE-P1',
          code_verifier: 'wrong-verifier-1234567890',
          client_id: 'myapp',
          redirect_uri: 'https://app.example/cb',
        }
      }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_grant');
      // Re-attempt with the right verifier → still invalid_grant (code now consumed).
      const verifier = pkceVerifier();
      const res2 = fakeRes();
      await handler({
        body: {
          grant_type: 'authorization_code',
          code: 'CODE-P1',
          code_verifier: verifier,
          client_id: 'myapp',
          redirect_uri: 'https://app.example/cb',
        }
      }, res2);
      assert.equal(res2.statusCode, 400);
    });
  });

  describe('[OAUTH-TKN-AC-MISMATCH] client/redirect mismatch', () => {
    it('[OTA-M1] client_id mismatch → invalid_grant', async () => {
      const platform = fakePlatform();
      const verifier = await seedCode(platform, 'CODE-M1');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({
        body: {
          grant_type: 'authorization_code',
          code: 'CODE-M1',
          code_verifier: verifier,
          client_id: 'attacker',
          redirect_uri: 'https://app.example/cb',
        }
      }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_grant');
    });
    it('[OTA-M2] redirect_uri mismatch → invalid_grant', async () => {
      const platform = fakePlatform();
      const verifier = await seedCode(platform, 'CODE-M2');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({
        body: {
          grant_type: 'authorization_code',
          code: 'CODE-M2',
          code_verifier: verifier,
          client_id: 'myapp',
          redirect_uri: 'https://attacker/cb',
        }
      }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_grant');
    });
  });

  describe('[OAUTH-TKN-AC-GRANT] grant-type dispatch', () => {
    it('[OTA-G1] missing grant_type → invalid_request', async () => {
      const platform = fakePlatform();
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: {} }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_request');
    });
    it('[OTA-G2] unknown grant_type → unsupported_grant_type', async () => {
      const platform = fakePlatform();
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: { grant_type: 'password' } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'unsupported_grant_type');
    });
  });

  describe('[OAUTH-TKN-AC-CONF] confidential-client authentication', () => {
    const { mintSecret } = require('../src/clientSecret.ts');
    async function registerClient (platform, clientId, meta) {
      await platform.setPlatformKv('oauth-client/' + clientId, JSON.stringify({ clientId, ...meta }));
    }
    function basicAuth (id, secret) {
      return 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
    }
    function exchange (verifier, extra = {}) {
      return {
        grant_type: 'authorization_code',
        code: extra.code,
        code_verifier: verifier,
        client_id: 'myapp',
        redirect_uri: 'https://app.example/cb',
        ...(extra.client_secret != null ? { client_secret: extra.client_secret } : {}),
      };
    }
    it('[OTA-CF1] confidential client without secret → 401 invalid_client', async () => {
      const platform = fakePlatform();
      const { hash } = await mintSecret();
      await registerClient(platform, 'myapp', { clientSecretHash: hash });
      const verifier = await seedCode(platform, 'CODE-CF1');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: exchange(verifier, { code: 'CODE-CF1' }) }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });
    it('[OTA-CF2] confidential client with correct secret (body) → 200', async () => {
      const platform = fakePlatform();
      const { plaintext, hash } = await mintSecret();
      await registerClient(platform, 'myapp', { clientSecretHash: hash });
      const verifier = await seedCode(platform, 'CODE-CF2');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: exchange(verifier, { code: 'CODE-CF2', client_secret: plaintext }) }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    });
    it('[OTA-CF3] confidential client with correct secret (Basic) → 200', async () => {
      const platform = fakePlatform();
      const { plaintext, hash } = await mintSecret();
      await registerClient(platform, 'myapp', { clientSecretHash: hash });
      const verifier = await seedCode(platform, 'CODE-CF3');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({
        body: exchange(verifier, { code: 'CODE-CF3' }),
        headers: { authorization: basicAuth('myapp', plaintext) },
      }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    });
    it('[OTA-CF4] confidential client with wrong secret → 401 invalid_client', async () => {
      const platform = fakePlatform();
      const { hash } = await mintSecret();
      await registerClient(platform, 'myapp', { clientSecretHash: hash });
      const verifier = await seedCode(platform, 'CODE-CF4');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: exchange(verifier, { code: 'CODE-CF4', client_secret: 'wrong-secret' }) }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });
    it('[OTA-CF5] public client (no secret on file) needs no secret → 200', async () => {
      const platform = fakePlatform();
      await registerClient(platform, 'myapp', {}); // registered, no clientSecretHash
      const verifier = await seedCode(platform, 'CODE-CF5');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: exchange(verifier, { code: 'CODE-CF5' }) }, res);
      assert.equal(res.statusCode, 200);
    });
    it('[OTA-CF6] unregistered client (no cache row) treated as public → 200', async () => {
      const platform = fakePlatform();
      const verifier = await seedCode(platform, 'CODE-CF6');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: exchange(verifier, { code: 'CODE-CF6' }) }, res);
      assert.equal(res.statusCode, 200);
    });
  });

  describe('[OAUTH-TKN-AC-PARAM] grant-input validation', () => {
    it('[OTA-PV1] missing code → invalid_request', async () => {
      const platform = fakePlatform();
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: { grant_type: 'authorization_code', code_verifier: 'v', client_id: 'c', redirect_uri: 'u' } }, res);
      assert.equal(res.body.error, 'invalid_request');
    });
    it('[OTA-PV2] missing code_verifier → invalid_request (PKCE mandatory)', async () => {
      const platform = fakePlatform();
      await seedCode(platform, 'CODE-PV2');
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: { grant_type: 'authorization_code', code: 'CODE-PV2', client_id: 'myapp', redirect_uri: 'https://app.example/cb' } }, res);
      assert.equal(res.body.error, 'invalid_request');
    });
  });
});
