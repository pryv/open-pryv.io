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
 * Verifies signed-state, validates scope downgrade, resolves user,
 * mints the access via the injected createAccess callback, persists
 * the code with the full access details, returns redirect URL.
 */

const assert = require('node:assert/strict');
const { CODE_TTL_SECONDS } = require('../src/routes/accept.ts');
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
    'oauth:accessTokenTTL': 3600,
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

const resolveAlice = async ({ username, userToken }) =>
  (username === 'alice' && userToken === 'alice-token')
    ? { userId: 'u-alice', username: 'alice', _ctx: 'fake-ctx' }
    : null;

const createAccessFake = async ({ session, clientId, grantedPermissions }) => ({
  accessId: 'acc-' + session.userId + '-' + clientId,
  accessToken: 'tok-' + session.userId + '-' + clientId,
  apiEndpoint: 'https://' + session.username + '.pryv.me/',
  dataGrantAccessId: 'dg-' + session.userId,
  permissions: grantedPermissions,
});

// Full-lexicon offer: stream permissions + a feature permission.
const OFFER_PERMISSIONS = [
  { streamId: 'health', level: 'read' },
  { streamId: 'diary', level: 'contribute' },
  { feature: 'selfRevoke', setting: 'forbidden' },
];

const SAMPLE_PAYLOAD = {
  clientId: 'myapp',
  redirectUri: 'https://app.example/cb',
  state: 'csrf-1',
  codeChallenge: 'cc-base64',
  codeChallengeMethod: 'S256',
  scope: ['cmc:study-A'],
  offer: {
    offerName: 'study-A',
    capabilityUrl: 'https://CapTok@myapp.example.com/',
    capabilityId: 'cap-42',
    offerEventId: 'ev-offer-1',
    permissions: OFFER_PERMISSIONS,
  },
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

function validBody (overrides = {}) {
  return {
    state: signState(ADMIN_KEY, SAMPLE_PAYLOAD),
    username: 'alice',
    userToken: 'alice-token',
    grantedPermissions: [
      { streamId: 'health', level: 'read' },
      { feature: 'selfRevoke', setting: 'forbidden' },
    ],
    ...overrides,
  };
}

function mkHandler (overrides = {}) {
  return require('../src/routes/accept.ts').handleAccept({
    config: fakeConfig(),
    platform: fakePlatform(),
    resolveUser: resolveAlice,
    createAccess: createAccessFake,
    ...overrides,
  });
}

describe('[OAUTH-ACCEPT] /oauth2/authorize/accept handler', () => {
  describe('[OAUTH-ACCEPT-OK] happy path', () => {
    it('[OAC-OK1] valid state + valid user + matching scope → 200 + redirectTo with code+state+iss', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      await handler({ body: validBody() }, res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.redirectTo.startsWith('https://app.example/cb?code='));
      assert.match(res.body.redirectTo, /&state=csrf-1/);
      assert.match(res.body.redirectTo, /&iss=https%3A%2F%2Freg\.pryv\.me/);
    });
    it('[OAC-OK2] code row carries full access details (id + token + apiEndpoint) + userId + username + scope', async () => {
      const platform = fakePlatform();
      const handler = require('../src/routes/accept.ts').handleAccept({
        config: fakeConfig(), platform, resolveUser: resolveAlice, createAccess: createAccessFake,
      });
      const res = fakeRes();
      await handler({ body: validBody() }, res);
      const code = res.body.redirectTo.match(/code=([^&]+)/)[1];
      const row = await getCode(platform, CORE_ID, code);
      assert.equal(row.userId, 'u-alice');
      assert.equal(row.username, 'alice');
      assert.equal(row.clientId, 'myapp');
      assert.deepEqual(row.scope, ['cmc:study-A']);
      assert.equal(row.codeChallenge, 'cc-base64');
      assert.equal(row.accessId, 'acc-u-alice-myapp');
      assert.equal(row.accessToken, 'tok-u-alice-myapp');
      assert.equal(row.apiEndpoint, 'https://alice.pryv.me/');
      assert.equal(row.dataGrantAccessId, 'dg-u-alice');
      assert.deepEqual(row.permissions, [
        { streamId: 'health', level: 'read' },
        { feature: 'selfRevoke', setting: 'forbidden' },
      ]);
      assert.ok(row.expiresAt > Date.now());
      assert.ok(row.expiresAt <= Date.now() + CODE_TTL_SECONDS * 1000 + 50);
    });
    it('[OAC-OK3] empty grantedPermissions → 400 invalid_scope (refuse instead of empty grant)', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      await handler({ body: validBody({ grantedPermissions: [] }) }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_scope');
    });
    it('[OAC-OK4] session handle from resolveUser is passed verbatim to createAccess', async () => {
      let seenSession;
      const createSpy = async ({ session, ...rest }) => {
        seenSession = session;
        return createAccessFake({ session, ...rest });
      };
      const handler = require('../src/routes/accept.ts').handleAccept({
        config: fakeConfig(), platform: fakePlatform(), resolveUser: resolveAlice, createAccess: createSpy,
      });
      const res = fakeRes();
      await handler({ body: validBody() }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(seenSession.userId, 'u-alice');
      assert.equal(seenSession._ctx, 'fake-ctx');
    });
  });

  describe('[OAUTH-ACCEPT-STATE] signed-state failures', () => {
    it('[OAC-S1] missing state → 400 invalid_request', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      await handler({ body: { username: 'alice', userToken: 'alice-token', grantedPermissions: [] } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_request');
    });
    it('[OAC-S4] state without a consent offer (stale/foreign) → 400 invalid_request', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      const { offer: _, ...payloadNoOffer } = SAMPLE_PAYLOAD;
      await handler({ body: validBody({ state: signState(ADMIN_KEY, payloadNoOffer) }) }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_request');
      assert.match(res.body.error_description, /no consent offer/);
    });
    it('[OAC-S2] tampered state → 400 invalid_request', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      const good = signState(ADMIN_KEY, SAMPLE_PAYLOAD);
      const [body, mac] = good.split('.');
      const tampered = body.slice(0, -1) + (body.at(-1) === 'A' ? 'B' : 'A') + '.' + mac;
      await handler({ body: validBody({ state: tampered }) }, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error_description, /bad_signature/);
    });
    it('[OAC-S3] expired state → 400 (signed state past its ttl)', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      const old = signState(ADMIN_KEY, SAMPLE_PAYLOAD, Math.floor(Date.now() / 1000) - 10_000);
      await handler({ body: validBody({ state: old }) }, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error_description, /expired/);
    });
  });

  describe('[OAUTH-ACCEPT-USER] user-resolution failures', () => {
    it('[OAC-U1] missing username → 400', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      const { username: _, ...b } = validBody();
      await handler({ body: b }, res);
      assert.equal(res.statusCode, 400);
    });
    it('[OAC-U2] missing userToken → 400', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      const { userToken: _, ...b } = validBody();
      await handler({ body: b }, res);
      assert.equal(res.statusCode, 400);
    });
    it('[OAC-U3] userToken/username pair does not resolve → 401', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      await handler({ body: validBody({ userToken: 'unknown' }) }, res);
      assert.equal(res.statusCode, 401);
    });
  });

  describe('[OAUTH-ACCEPT-SCOPE] consent-downgrade enforcement (granted ⊆ offered, full lexicon)', () => {
    it('[OAC-SC1] widened level → 400 invalid_scope with the offending entry', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      await handler({ body: validBody({ grantedPermissions: [{ streamId: 'health', level: 'manage' }] }) }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_scope');
      assert.match(res.body.error_description, /health/);
    });
    it('[OAC-SC2] grantedPermissions must be an array', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      await handler({ body: validBody({ grantedPermissions: 'health' }) }, res);
      assert.equal(res.statusCode, 400);
    });
    it('[OAC-SC3] foreign stream or un-offered feature permission → 400 invalid_scope', async () => {
      const handler = mkHandler();
      for (const granted of [
        [{ streamId: 'other', level: 'read' }],
        [{ feature: 'selfAudit', setting: 'forbidden' }],
      ]) {
        const res = fakeRes();
        await handler({ body: validBody({ grantedPermissions: granted }) }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, 'invalid_scope');
      }
    });
    it('[OAC-SC4] malformed permission entry → 400 invalid_scope', async () => {
      const handler = mkHandler();
      const res = fakeRes();
      await handler({ body: validBody({ grantedPermissions: [{ streamId: 'health', level: 'root' }] }) }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'invalid_scope');
      assert.match(res.body.error_description, /invalid/);
    });
  });

  describe('[OAUTH-ACCEPT-CREATE] createAccess failure path', () => {
    it('[OAC-CR1] createAccess throws → 500 server_error', async () => {
      const handler = require('../src/routes/accept.ts').handleAccept({
        config: fakeConfig(),
        platform: fakePlatform(),
        resolveUser: resolveAlice,
        createAccess: async () => { throw new Error('forbidden: parent access lacks permission'); },
      });
      const res = fakeRes();
      await handler({ body: validBody() }, res);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, 'server_error');
      assert.match(res.body.error_description, /forbidden/);
    });
  });
});
