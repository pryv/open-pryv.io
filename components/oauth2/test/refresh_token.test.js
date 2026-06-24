/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-TKN-RT] POST /oauth2/token — grant_type=refresh_token.
 *
 * Rotation always on, client_id mismatch rejected, absolute cap
 * enforced, single-use refresh tokens, mintRefreshedAccess injected
 * (no user-context-auth available at refresh time).
 */

const assert = require('node:assert/strict');
const { handleToken } = require('../src/routes/token.ts');
const { setRefresh, getRefresh } = require('../src/storage.ts');

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
  const state = new Map();
  return {
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async getAccessState (k) {
      const e = state.get(k);
      if (e == null) return null;
      if (Date.now() > e.expiresAt) { state.delete(k); return null; }
      return e;
    },
    async deleteAccessState (k) { state.delete(k); },
    _state: state,
  };
}

const MINT_REFRESHED_FAKE = async ({ userId, clientId, username }) => ({
  accessId: 'acc-' + userId + '-' + Date.now(),
  accessToken: 'new-tok-' + clientId,
  apiEndpoint: 'https://' + username + '.pryv.me/',
});

async function seedRefresh (platform, token, overrides = {}) {
  const now = Date.now();
  await setRefresh(platform, CORE_ID, token, {
    clientId: 'myapp',
    userId: 'u-alice',
    username: 'alice',
    scope: ['pryv:read'],
    issuedAt: now,
    lastUsedAt: now,
    expiresAt: now + 30 * 24 * 3600 * 1000,
    absoluteExpiresAt: now + 90 * 24 * 3600 * 1000,
    ...overrides,
  });
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

describe('[OAUTH-TKN-RT] /oauth2/token — refresh_token grant', () => {
  describe('[OAUTH-TKN-RT-OK] happy path', () => {
    it('[OTR-OK1] valid refresh → 200 with new access_token + new refresh_token + apiEndpoint + scope', async () => {
      const platform = fakePlatform();
      await seedRefresh(platform, 'RT-OK1');
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'RT-OK1', client_id: 'myapp' } }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.token_type, 'Bearer');
      assert.equal(res.body.scope, 'pryv:read');
      assert.equal(typeof res.body.access_token, 'string');
      assert.notEqual(res.body.refresh_token, 'RT-OK1', 'new refresh token must differ');
      assert.equal(typeof res.body.apiEndpoint, 'string');
    });
    it('[OTR-OK2] response carries Cache-Control: no-store + Pragma: no-cache', async () => {
      const platform = fakePlatform();
      await seedRefresh(platform, 'RT-OK2');
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'RT-OK2', client_id: 'myapp' } }, res);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers.pragma, 'no-cache');
    });
    it('[OTR-OK3] absolute cap preserved across rotations', async () => {
      const platform = fakePlatform();
      const absolute = Date.now() + 90 * 24 * 3600 * 1000;
      await seedRefresh(platform, 'RT-OK3', { absoluteExpiresAt: absolute });
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'RT-OK3', client_id: 'myapp' } }, res);
      assert.equal(res.statusCode, 200);
      // The new refresh row must carry the SAME absolute cap as the original.
      const newRefresh = await getRefresh(platform, CORE_ID, res.body.refresh_token);
      assert.equal(newRefresh.absoluteExpiresAt, absolute);
    });
    it('[OTR-OK4] sliding TTL is capped by absoluteExpiresAt when absolute is sooner', async () => {
      const platform = fakePlatform();
      // Absolute cap in 1 hour; sliding TTL is 30 days. New refresh must
      // expire at the absolute cap, not 30 days from now.
      const absolute = Date.now() + 3600 * 1000;
      await seedRefresh(platform, 'RT-OK4', { absoluteExpiresAt: absolute });
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'RT-OK4', client_id: 'myapp' } }, res);
      assert.equal(res.statusCode, 200);
      const newRefresh = await getRefresh(platform, CORE_ID, res.body.refresh_token);
      assert.equal(newRefresh.expiresAt, absolute);
    });
  });

  describe('[OAUTH-TKN-RT-REUSE] single-use enforcement', () => {
    it('[OTR-R1] reusing a refresh token after rotation → invalid_grant', async () => {
      const platform = fakePlatform();
      await seedRefresh(platform, 'RT-R1');
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const params = { grant_type: 'refresh_token', refresh_token: 'RT-R1', client_id: 'myapp' };
      const r1 = fakeRes(); await handler({ body: params }, r1);
      assert.equal(r1.statusCode, 200);
      const r2 = fakeRes(); await handler({ body: params }, r2);
      assert.equal(r2.statusCode, 400);
      assert.equal(r2.body.error, 'invalid_grant');
    });
    it('[OTR-R2] unknown refresh token → invalid_grant (same shape as reuse)', async () => {
      const platform = fakePlatform();
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'NEVER-ISSUED', client_id: 'myapp' } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_grant');
    });
  });

  describe('[OAUTH-TKN-RT-MISMATCH] client mismatch', () => {
    it('[OTR-M1] client_id mismatch → invalid_grant; token IS consumed', async () => {
      const platform = fakePlatform();
      await seedRefresh(platform, 'RT-M1');
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'RT-M1', client_id: 'attacker' } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_grant');
      // Even on client mismatch the row is deleted (single-use, defense
      // in depth) — a second attempt with the right client also fails.
      const res2 = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'RT-M1', client_id: 'myapp' } }, res2);
      assert.equal(res2.statusCode, 400);
    });
  });

  describe('[OAUTH-TKN-RT-CAP] absolute-cap enforcement', () => {
    it('[OTR-C1] absolute cap already past → 400 invalid_grant', async () => {
      const platform = fakePlatform();
      // Sliding TTL still valid, but absolute cap already past.
      await seedRefresh(platform, 'RT-C1', {
        expiresAt: Date.now() + 3600 * 1000,
        absoluteExpiresAt: Date.now() - 1000,
      });
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'RT-C1', client_id: 'myapp' } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_grant');
    });
  });

  describe('[OAUTH-TKN-RT-PARAM] grant-input validation', () => {
    it('[OTR-PV1] missing refresh_token → invalid_request', async () => {
      const platform = fakePlatform();
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', client_id: 'myapp' } }, res);
      assert.equal(res.body.error, 'invalid_request');
    });
    it('[OTR-PV2] missing client_id → invalid_request', async () => {
      const platform = fakePlatform();
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: MINT_REFRESHED_FAKE });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'X' } }, res);
      assert.equal(res.body.error, 'invalid_request');
    });
  });

  describe('[OAUTH-TKN-RT-DISPATCH] dispatcher', () => {
    it('[OTR-D1] refresh_token grant without mintRefreshedAccess wired → 501 unsupported_grant_type', async () => {
      const platform = fakePlatform();
      const handler = handleToken({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'y' } }, res);
      assert.equal(res.statusCode, 501);
      assert.equal(res.body.error, 'unsupported_grant_type');
    });
  });

  describe('[OAUTH-TKN-RT-MINT] mintRefreshedAccess failure', () => {
    it('[OTR-MA1] mintRefreshedAccess throws → 500 server_error', async () => {
      const platform = fakePlatform();
      await seedRefresh(platform, 'RT-MA1');
      const failingMint = async () => { throw new Error('storage unavailable'); };
      const handler = handleToken({ config: fakeConfig(), platform, mintRefreshedAccess: failingMint });
      const res = fakeRes();
      await handler({ body: { grant_type: 'refresh_token', refresh_token: 'RT-MA1', client_id: 'myapp' } }, res);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, 'server_error');
    });
  });
});
