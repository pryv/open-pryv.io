/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-AUTH] OAuth2 — GET /oauth2/authorize handler.
 *
 * Exercises the validate-then-redirect flow against a fake
 * PlatformDB-backed clientRegistry. Cross-core forwarding is deferred
 * to a follow-up commit and not tested here.
 */

const assert = require('node:assert/strict');
const { handleAuthorize } = require('../src/routes/authorize.ts');
const { verifyState } = require('../src/signedState.ts');

const ADMIN_KEY = 'admin-key-for-tests';
const ISSUER = 'https://reg.pryv.me';
const CONSENT_URL = 'https://auth.pryv.me/oauth2-authorize';

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'auth:adminAccessKey': ADMIN_KEY,
    'oauth:consentUrl': CONSENT_URL,
    ...overrides,
  };
  return { get: (k) => m[k] };
}

function fakePlatform (clients = {}) {
  const store = new Map();
  for (const [id, meta] of Object.entries(clients)) {
    store.set('oauth-client/' + id, JSON.stringify({
      clientId: id,
      grantTypes: ['authorization_code'],
      ...meta,
    }));
  }
  return {
    async setPlatformKv (k, v) { store.set(k, v); },
    async getPlatformKv (k) { return store.has(k) ? store.get(k) : null; },
    async deletePlatformKv (k) { store.delete(k); },
    async listPlatformKvKeys (p) { return Array.from(store.keys()).filter((k) => k.startsWith(p)); },
  };
}

function fakeRes () {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ?? ''; this.ended = true; },
  };
  return res;
}

function fakeReq (query = {}) {
  return { method: 'GET', query };
}

const VALID_CLIENT = {
  redirectUris: ['https://app.example/cb'],
  scope: ['pryv:read', 'pryv:write'],
};

const VALID_QUERY = {
  client_id: 'myapp',
  redirect_uri: 'https://app.example/cb',
  response_type: 'code',
  state: 'csrf-abc',
  code_challenge: 'cc-base64url-string',
  code_challenge_method: 'S256',
  scope: 'pryv:read',
};

describe('[OAUTH-AUTH] /oauth2/authorize handler', () => {
  describe('[OAUTH-AUTH-OK] happy path', () => {
    it('[OA-OK1] valid request 302s to consent URL with signed state', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq(VALID_QUERY), res);
      assert.equal(res.statusCode, 302);
      const loc = res.headers.location;
      assert.ok(loc.startsWith(CONSENT_URL + '?state='));
      assert.match(loc, /&pryvApi=https%3A%2F%2Freg\.pryv\.me/);
      const stateParam = decodeURIComponent(loc.split('state=')[1].split('&')[0]);
      const v = verifyState(ADMIN_KEY, stateParam);
      assert.equal(v.ok, true);
      assert.equal(v.payload.clientId, 'myapp');
      assert.equal(v.payload.redirectUri, 'https://app.example/cb');
      assert.equal(v.payload.state, 'csrf-abc');
      assert.deepEqual(v.payload.scope, ['pryv:read']);
    });
    it('[OA-OK2] login_hint flows into signed state as userIdHint', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq({ ...VALID_QUERY, login_hint: 'alice' }), res);
      const v = verifyState(ADMIN_KEY, decodeURIComponent(res.headers.location.split('state=')[1].split('&')[0]));
      assert.equal(v.payload.userIdHint, 'alice');
    });
    it('[OA-OK3] response is cache-control: no-store', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq(VALID_QUERY), res);
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  });

  describe('[OAUTH-AUTH-REDIR] invalid-redirect-URI defense (HTML 400, no redirect)', () => {
    it('[OA-R1] unknown client_id → HTML 400, NEVER redirected', async () => {
      const platform = fakePlatform({});
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq(VALID_QUERY), res);
      assert.equal(res.statusCode, 400);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.equal(res.headers.location, undefined);
    });
    it('[OA-R2] redirect_uri mismatch → HTML 400, NEVER bounced to attacker', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq({ ...VALID_QUERY, redirect_uri: 'https://attacker.example/cb' }), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.headers.location, undefined);
    });
    it('[OA-R3] missing client_id → HTML 400', async () => {
      const platform = fakePlatform({});
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      const { client_id: _, ...q } = VALID_QUERY;
      await handler(fakeReq(q), res);
      assert.equal(res.statusCode, 400);
    });
    it('[OA-R4] missing redirect_uri → HTML 400', async () => {
      const platform = fakePlatform({});
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      const { redirect_uri: _, ...q } = VALID_QUERY;
      await handler(fakeReq(q), res);
      assert.equal(res.statusCode, 400);
    });
    it('[OA-R5] HTML output escapes the client_id (no XSS)', async () => {
      const platform = fakePlatform({});
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq({ ...VALID_QUERY, client_id: '<script>x</script>' }), res);
      assert.equal(res.statusCode, 400);
      assert.ok(!res.body.includes('<script>'));
      assert.ok(res.body.includes('&lt;script&gt;'));
    });
  });

  describe('[OAUTH-AUTH-ERR] OAuth-enum error redirects (back to verified redirect_uri)', () => {
    it('[OA-E1] response_type != code → unsupported_response_type', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq({ ...VALID_QUERY, response_type: 'token' }), res);
      assert.equal(res.statusCode, 302);
      assert.match(res.headers.location, /^https:\/\/app\.example\/cb\?error=unsupported_response_type/);
      assert.match(res.headers.location, /&state=csrf-abc/);
      assert.match(res.headers.location, /&iss=https%3A%2F%2Freg\.pryv\.me/);
    });
    it('[OA-E2] missing code_challenge → invalid_request', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      const { code_challenge: _, ...q } = VALID_QUERY;
      await handler(fakeReq(q), res);
      assert.match(res.headers.location, /error=invalid_request/);
    });
    it('[OA-E3] code_challenge_method != S256 → invalid_request', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq({ ...VALID_QUERY, code_challenge_method: 'plain' }), res);
      assert.match(res.headers.location, /error=invalid_request/);
    });
    it('[OA-E4] missing state → invalid_request', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      const { state: _, ...q } = VALID_QUERY;
      await handler(fakeReq(q), res);
      assert.match(res.headers.location, /error=invalid_request/);
    });
    it('[OA-E5] malformed scope → invalid_scope', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq({ ...VALID_QUERY, scope: 'noprefixhere' }), res);
      assert.match(res.headers.location, /error=invalid_scope/);
    });
    it('[OA-E6] scope not registered to client → invalid_scope', async () => {
      const platform = fakePlatform({ myapp: { redirectUris: ['https://app.example/cb'], scope: ['pryv:read'] } });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq({ ...VALID_QUERY, scope: 'pryv:write' }), res);
      assert.match(res.headers.location, /error=invalid_scope/);
    });
    it('[OA-E7] unknown scope namespace → invalid_scope', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const res = fakeRes();
      await handler(fakeReq({ ...VALID_QUERY, scope: 'smart:patient.read' }), res);
      assert.match(res.headers.location, /error=invalid_scope/);
    });
  });

  describe('[OAUTH-AUTH-CFG] config errors → 500', () => {
    it('[OA-C1] missing service:api → 500 server_error', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig({ 'service:api': null }), platform });
      const res = fakeRes();
      await handler(fakeReq(VALID_QUERY), res);
      assert.equal(res.statusCode, 500);
    });
    it('[OA-C2] missing oauth:consentUrl → 500 server_error', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig({ 'oauth:consentUrl': null }), platform });
      const res = fakeRes();
      await handler(fakeReq(VALID_QUERY), res);
      assert.equal(res.statusCode, 500);
    });
    it('[OA-C3] missing auth:adminAccessKey → 500', async () => {
      const platform = fakePlatform({ myapp: VALID_CLIENT });
      const handler = handleAuthorize({ config: fakeConfig({ 'auth:adminAccessKey': null }), platform });
      const res = fakeRes();
      await handler(fakeReq(VALID_QUERY), res);
      assert.equal(res.statusCode, 500);
    });
  });
});
