/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-TKN-CC] POST /oauth2/token — grant_type=client_credentials.
 *
 * HTTP Basic + body auth-method precedence, secret verification,
 * scope narrowing, account-username resolution, no refresh_token in
 * response (RFC 6749 §4.4.3).
 */

const assert = require('node:assert/strict');
const { handleToken } = require('../src/routes/token.ts');
const { mintSecret } = require('../src/clientSecret.ts');

const ISSUER = 'https://reg.pryv.me';

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'core:id': 'core-a',
    'oauth:accessTokenTTL': 3600,
    ...overrides,
  };
  return { get: (k) => m[k] };
}

function fakePlatform (clients = {}) {
  const kv = new Map();
  for (const [id, meta] of Object.entries(clients)) {
    kv.set('oauth-client/' + id, JSON.stringify({
      clientId: id,
      redirectUris: ['x'],
      scope: ['pryv:read', 'pryv:write'],
      grantTypes: ['client_credentials'],
      accountUsername: id,
      ...meta,
    }));
  }
  return {
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return Array.from(kv.keys()).filter((k) => k.startsWith(p)); },
    // Not used by client_credentials but TokenDeps expects an access-state path too.
    async setAccessState (k, v, exp) {},
    async getAccessState (k) { return null; },
    async deleteAccessState (k) {},
    async consumeAccessState (k) { return null; },
  };
}

const MINT_CLIENT_FAKE = async ({ userId, username, clientId }) => ({
  accessId: 'acc-' + userId + '-' + Date.now(),
  accessToken: 'cc-tok-' + clientId,
  apiEndpoint: 'https://' + username + '.pryv.me/',
});

const RESOLVE_ACCOUNT_FAKE = async (username) =>
  (username === 'myapp' || username === 'otherapp') ? 'u-' + username : null;

function fakeRes () {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ? JSON.parse(b) : null; },
  };
}

async function makeClient (overrides = {}) {
  const { plaintext, hash } = await mintSecret();
  return { secret: plaintext, meta: { clientSecretHash: hash, ...overrides } };
}

function basicAuth (clientId, clientSecret) {
  return 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
}

describe('[OAUTH-TKN-CC] /oauth2/token — client_credentials grant', () => {
  describe('[OAUTH-TKN-CC-OK] happy path', () => {
    it('[OTC-OK1] HTTP Basic auth → 200 with access_token + scope + apiEndpoint; NO refresh_token', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: c.meta });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.token_type, 'Bearer');
      assert.equal(typeof res.body.access_token, 'string');
      assert.equal(res.body.refresh_token, undefined, 'RFC 6749 §4.4.3 — no refresh_token for client_credentials');
      assert.equal(res.body.scope, 'pryv:read pryv:write');
      assert.equal(typeof res.body.apiEndpoint, 'string');
    });

    it('[OTC-OK2] client_secret_post (body) auth → 200', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: c.meta });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials', client_id: 'myapp', client_secret: c.secret },
        headers: {},
      }, res);
      assert.equal(res.statusCode, 200);
    });

    it('[OTC-OK3] Basic auth wins when both Basic and body are present (RFC 6749 §2.3.1 precedence)', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: c.meta });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      // Body has bad creds; Basic has good — server should accept (Basic wins).
      await handler({
        body: { grant_type: 'client_credentials', client_id: 'attacker', client_secret: 'wrong' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.statusCode, 200);
    });

    it('[OTC-OK4] scope narrowing — request a subset of registered scope', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: c.meta });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials', scope: 'pryv:read' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.scope, 'pryv:read');
    });

    it('[OTC-OK5] response carries Cache-Control: no-store + Pragma: no-cache', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: c.meta });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers.pragma, 'no-cache');
    });
  });

  describe('[OAUTH-TKN-CC-AUTH] auth failures', () => {
    it('[OTC-A1] missing client_id → 401 invalid_client', async () => {
      const handler = handleToken({
        config: fakeConfig(),
        platform: fakePlatform(),
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({ body: { grant_type: 'client_credentials', client_secret: 'x' }, headers: {} }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });

    it('[OTC-A2] missing client_secret → 401 invalid_client', async () => {
      const handler = handleToken({
        config: fakeConfig(),
        platform: fakePlatform(),
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({ body: { grant_type: 'client_credentials', client_id: 'x' }, headers: {} }, res);
      assert.equal(res.statusCode, 401);
    });

    it('[OTC-A3] unknown client → 401 invalid_client', async () => {
      const handler = handleToken({
        config: fakeConfig(),
        platform: fakePlatform(),
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('never-registered', 'x') },
      }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });

    it('[OTC-A4] wrong secret → 401 invalid_client', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: c.meta });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('myapp', 'wrong-secret') },
      }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error, 'invalid_client');
    });

    it('[OTC-A5] client without clientSecretHash → 401 invalid_client (operator hasn\'t minted a secret)', async () => {
      const platform = fakePlatform({ myapp: { grantTypes: ['client_credentials'], accountUsername: 'myapp' } });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('myapp', 'anything') },
      }, res);
      assert.equal(res.statusCode, 401);
      assert.match(res.body.error_description, /rotate-secret/);
    });

    it('[OTC-A6] malformed Basic header → falls through to body; if neither present → 401', async () => {
      const handler = handleToken({
        config: fakeConfig(),
        platform: fakePlatform(),
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: 'Basic !!!not-base64!!!' },
      }, res);
      assert.equal(res.statusCode, 401);
    });
  });

  describe('[OAUTH-TKN-CC-GRANT] grant-eligibility', () => {
    it('[OTC-G1] client not registered for client_credentials grant → 400 unauthorized_client', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: { ...c.meta, grantTypes: ['authorization_code'] } });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'unauthorized_client');
    });

    it('[OTC-G2] client missing accountUsername → 500 server_error', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: { ...c.meta, accountUsername: '' } });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.statusCode, 500);
    });
  });

  describe('[OAUTH-TKN-CC-SCOPE] scope validation', () => {
    it('[OTC-S1] requested scope outside registered set → 400 invalid_scope', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: { ...c.meta, scope: ['pryv:read'] } });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials', scope: 'pryv:write' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_scope');
    });

    it('[OTC-S2] malformed scope → 400 invalid_scope', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: c.meta });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials', scope: 'noprefix' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.body.error, 'invalid_scope');
    });
  });

  describe('[OAUTH-TKN-CC-RESOLVE] account-username resolution', () => {
    it('[OTC-R1] accountUsername does not resolve to a user → 500 server_error', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: { ...c.meta, accountUsername: 'ghost' } });
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: MINT_CLIENT_FAKE,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.statusCode, 500);
    });
  });

  describe('[OAUTH-TKN-CC-MINT] mint failure', () => {
    it('[OTC-MF1] mintClientAccess throws → 500 with generic description (no internal leak)', async () => {
      const c = await makeClient();
      const platform = fakePlatform({ myapp: c.meta });
      const failingMint = async () => { throw new Error('secret-internal-detail-xyz'); };
      const handler = handleToken({
        config: fakeConfig(),
        platform,
        mintClientAccess: failingMint,
        resolveAccountUserId: RESOLVE_ACCOUNT_FAKE,
      });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials' },
        headers: { authorization: basicAuth('myapp', c.secret) },
      }, res);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, 'server_error');
      assert.ok(!String(res.body.error_description || '').includes('secret-internal-detail-xyz'),
        'internal error text must not leak into error_description');
    });
  });

  describe('[OAUTH-TKN-CC-DISPATCH] dispatcher', () => {
    it('[OTC-D1] client_credentials without callbacks wired → 501 unsupported_grant_type', async () => {
      const handler = handleToken({ config: fakeConfig(), platform: fakePlatform() });
      const res = fakeRes();
      await handler({
        body: { grant_type: 'client_credentials', client_id: 'x', client_secret: 'y' },
        headers: {},
      }, res);
      assert.equal(res.statusCode, 501);
      assert.equal(res.body.error, 'unsupported_grant_type');
    });
  });
});
