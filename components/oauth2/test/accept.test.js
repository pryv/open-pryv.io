/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-ACCEPT] OAuth2 — POST /oauth2/authorize/accept handler.
 *
 * Verifies signed-state in, validates scope downgrade, resolves user,
 * mints code, persists, returns redirect URL.
 */

const assert = require('node:assert/strict');
const { handleAccept, CODE_TTL_SECONDS } = require('../src/routes/accept.ts');
const { signState } = require('../src/signedState.ts');
const { getCode } = require('../src/storage.ts');

const ADMIN_KEY = 'admin-key-tests';
const ISSUER = 'https://reg.pryv.me';
const CORE_ID = 'core-a';

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'auth:adminAccessKey': ADMIN_KEY,
    'core:id': CORE_ID,
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

const resolveAlice = async (t) => t === 'alice-token' ? { userId: 'u-alice', username: 'alice' } : null;

const SAMPLE_PAYLOAD = {
  clientId: 'myapp',
  redirectUri: 'https://app.example/cb',
  state: 'csrf-1',
  codeChallenge: 'cc-base64',
  codeChallengeMethod: 'S256',
  scope: ['pryv:read', 'pryv:write'],
};

function fakeRes () {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ? JSON.parse(b) : null; },
  };
}

describe('[OAUTH-ACCEPT] /oauth2/authorize/accept handler', () => {
  describe('[OAUTH-ACCEPT-OK] happy path', () => {
    it('[OAC-OK1] valid state + valid user + matching scope → 200 + redirectTo with code+state+iss', async () => {
      const platform = fakePlatform();
      const handler = handleAccept({ config: fakeConfig(), platform, resolveUser: resolveAlice });
      const res = fakeRes();
      await handler({
        body: {
          state: signState(ADMIN_KEY, SAMPLE_PAYLOAD),
          userToken: 'alice-token',
          grantedScope: ['pryv:read'],
        }
      }, res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.redirectTo.startsWith('https://app.example/cb?code='));
      assert.match(res.body.redirectTo, /&state=csrf-1/);
      assert.match(res.body.redirectTo, /&iss=https%3A%2F%2Freg\.pryv\.me/);
    });
    it('[OAC-OK2] code is persisted with the granted scope + userId + clientId', async () => {
      const platform = fakePlatform();
      const handler = handleAccept({ config: fakeConfig(), platform, resolveUser: resolveAlice });
      const res = fakeRes();
      await handler({
        body: {
          state: signState(ADMIN_KEY, SAMPLE_PAYLOAD),
          userToken: 'alice-token',
          grantedScope: ['pryv:read'],
        }
      }, res);
      const code = res.body.redirectTo.match(/code=([^&]+)/)[1];
      const row = await getCode(platform, CORE_ID, code);
      assert.equal(row.userId, 'u-alice');
      assert.equal(row.clientId, 'myapp');
      assert.deepEqual(row.scope, ['pryv:read']);
      assert.equal(row.codeChallenge, 'cc-base64');
      assert.ok(row.expiresAt > Date.now());
      assert.ok(row.expiresAt <= Date.now() + CODE_TTL_SECONDS * 1000 + 50);
    });
    it('[OAC-OK3] empty grantedScope is accepted (user opted out of everything)', async () => {
      const platform = fakePlatform();
      const handler = handleAccept({ config: fakeConfig(), platform, resolveUser: resolveAlice });
      const res = fakeRes();
      await handler({
        body: {
          state: signState(ADMIN_KEY, SAMPLE_PAYLOAD),
          userToken: 'alice-token',
          grantedScope: [],
        }
      }, res);
      assert.equal(res.statusCode, 200);
      const code = res.body.redirectTo.match(/code=([^&]+)/)[1];
      const row = await getCode(platform, CORE_ID, code);
      assert.deepEqual(row.scope, []);
    });
  });

  describe('[OAUTH-ACCEPT-STATE] signed-state failures', () => {
    it('[OAC-S1] missing state → 400 invalid_request', async () => {
      const handler = handleAccept({ config: fakeConfig(), platform: fakePlatform(), resolveUser: resolveAlice });
      const res = fakeRes();
      await handler({ body: { userToken: 'alice-token', grantedScope: [] } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_request');
    });
    it('[OAC-S2] tampered state → 400 invalid_request', async () => {
      const handler = handleAccept({ config: fakeConfig(), platform: fakePlatform(), resolveUser: resolveAlice });
      const res = fakeRes();
      const good = signState(ADMIN_KEY, SAMPLE_PAYLOAD);
      const [body, mac] = good.split('.');
      const tampered = body.slice(0, -1) + (body.at(-1) === 'A' ? 'B' : 'A') + '.' + mac;
      await handler({ body: { state: tampered, userToken: 'alice-token', grantedScope: [] } }, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error_description, /bad_signature/);
    });
    it('[OAC-S3] expired state → 400 (signed state past its ttl)', async () => {
      const handler = handleAccept({ config: fakeConfig(), platform: fakePlatform(), resolveUser: resolveAlice });
      const res = fakeRes();
      const old = signState(ADMIN_KEY, SAMPLE_PAYLOAD, Math.floor(Date.now() / 1000) - 10_000);
      await handler({ body: { state: old, userToken: 'alice-token', grantedScope: [] } }, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error_description, /expired/);
    });
  });

  describe('[OAUTH-ACCEPT-USER] user-resolution failures', () => {
    it('[OAC-U1] missing userToken → 400', async () => {
      const handler = handleAccept({ config: fakeConfig(), platform: fakePlatform(), resolveUser: resolveAlice });
      const res = fakeRes();
      await handler({ body: { state: signState(ADMIN_KEY, SAMPLE_PAYLOAD), grantedScope: [] } }, res);
      assert.equal(res.statusCode, 400);
    });
    it('[OAC-U2] userToken does not resolve → 401', async () => {
      const handler = handleAccept({ config: fakeConfig(), platform: fakePlatform(), resolveUser: resolveAlice });
      const res = fakeRes();
      await handler({ body: { state: signState(ADMIN_KEY, SAMPLE_PAYLOAD), userToken: 'unknown', grantedScope: [] } }, res);
      assert.equal(res.statusCode, 401);
    });
  });

  describe('[OAUTH-ACCEPT-SCOPE] scope-downgrade enforcement', () => {
    it('[OAC-SC1] grantedScope ⊄ requestedScope → 400 invalid_scope', async () => {
      const handler = handleAccept({ config: fakeConfig(), platform: fakePlatform(), resolveUser: resolveAlice });
      const res = fakeRes();
      await handler({
        body: {
          state: signState(ADMIN_KEY, SAMPLE_PAYLOAD),
          userToken: 'alice-token',
          grantedScope: ['pryv:manage'], // not in requested
        }
      }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_scope');
    });
    it('[OAC-SC2] grantedScope must be an array', async () => {
      const handler = handleAccept({ config: fakeConfig(), platform: fakePlatform(), resolveUser: resolveAlice });
      const res = fakeRes();
      await handler({
        body: {
          state: signState(ADMIN_KEY, SAMPLE_PAYLOAD),
          userToken: 'alice-token',
          grantedScope: 'pryv:read',
        }
      }, res);
      assert.equal(res.statusCode, 400);
    });
  });
});
