/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCUR] OAuth2: `POST /oauth2/clients/validation`, the current level of the
 * apps an account granted. Answers only for the clients the account's
 * accesses were minted for (unknown and not-held ids are left out alike),
 * with `served: false` when the client is refused now; refuses a request
 * without a personal token, a non-personal token and more than 50 ids.
 * The handler runs against an in-memory platform store.
 */

const assert = require('node:assert/strict');
const cv = require('../src/clientValidation.ts');
const { handleClientsValidation, MAX_CLIENT_IDS } = require('../src/routes/clientsValidation.ts');
const { registerRoutes } = require('../src/routes.ts');
const { setClient } = require('../src/storage.ts');

const OWNER = 'u-owner';
const USER = { userId: 'u-1', username: 'alice', personal: true };

function fakeConfig (overrides = {}) {
  const m = { 'service:api': 'https://core.example.com', 'core:id': 'core-a', ...overrides };
  return { get: (k) => m[k] };
}

function fakePlatform () {
  const kv = new Map();
  return {
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
  };
}

function fakeRes () {
  return {
    statusCode: 200,
    headers: {},
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ? JSON.parse(b) : null; },
  };
}

const BASE = {
  kind: 'registry',
  redirectUris: ['https://app.example.com/cb'],
  scope: ['read/a'],
  grantTypes: ['authorization_code'],
  tokenEndpointAuthMethod: 'none',
  clientName: 'App',
};

describe('[OCUR] OAuth2 current validation level of the apps an account granted', function () {
  let platform, config, held, resolved;

  beforeEach(async function () {
    cv._resetForTests();
    platform = fakePlatform();
    config = fakeConfig({ 'oauth:clientRegistration': { mode: 'delegated', levels: { publisherValidated: { consent: 'refuse' } } } });
    await setClient(platform, { ...BASE, clientId: 'op-app' });
    await setClient(platform, { ...BASE, clientId: 'dev-app', origin: 'developer', owner: { userId: OWNER } });
    await setClient(platform, { ...BASE, clientId: 'not-held' });
    await setClient(platform, { ...BASE, clientId: 'paused', status: 'suspended' });
    held = ['op-app', 'dev-app', 'paused', 'gone'];
    resolved = USER;
  });

  afterEach(function () { cv._resetForTests(); });

  function deps () {
    return {
      config,
      platform,
      resolveUser: async ({ username, userToken }) => (username === 'alice' && userToken === 'tok' ? resolved : null),
      listHeldClientIds: async (session) => {
        assert.equal(session.userId, 'u-1');
        return held;
      },
    };
  }

  async function call (body, headers = {}) {
    const res = fakeRes();
    await handleClientsValidation(deps())({ body, headers }, res);
    return res;
  }

  it('[OCUR1] answers each held client with its current level and served flag; unknown and not-held ids are left out alike', async () => {
    const res = await call({ username: 'alice', userToken: 'tok', clientIds: ['op-app', 'dev-app', 'not-held', 'gone', 'nowhere', 'paused', 'op-app'] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, {
      clients: {
        'op-app': { level: 'appValidated', served: true },
        'dev-app': { level: 'nonValidated', served: true },
        paused: { level: 'appValidated', served: false },
      },
    });
  });

  it('[OCUR2] a level change since consent shows at the next read: publisher validated under a refused level is not served', async () => {
    await cv.setPublisher(platform, OWNER, { status: 'validated', displayName: 'Acme' });
    const res = await call({ username: 'alice', clientIds: ['dev-app'] }, { authorization: 'tok' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.clients['dev-app'], { level: 'publisherValidated', publisher: { name: 'Acme', validated: true }, served: false });
  });

  it('[OCUR3] a developer client while the mode is curated is not served', async () => {
    config = fakeConfig();
    const res = await call({ username: 'alice', userToken: 'tok', clientIds: ['dev-app'] });
    assert.deepEqual(res.body.clients['dev-app'], { level: 'nonValidated', served: false });
  });

  it('[OCUR4] refuses a request without username or token, an unknown token and a non-personal token', async () => {
    let res = await call({ clientIds: ['op-app'] });
    assert.equal(res.statusCode, 401);
    res = await call({ username: 'alice', clientIds: ['op-app'] });
    assert.equal(res.statusCode, 401);
    res = await call({ username: 'alice', userToken: 'wrong', clientIds: ['op-app'] });
    assert.deepEqual([res.statusCode, res.body.error], [401, 'invalid_request']);
    resolved = { ...USER, personal: false };
    res = await call({ username: 'alice', userToken: 'tok', clientIds: ['op-app'] });
    assert.deepEqual([res.statusCode, res.body.error], [403, 'access_denied']);
    resolved = { refused: true, description: 'only the account owner can grant OAuth access' };
    res = await call({ username: 'alice', userToken: 'tok', clientIds: ['op-app'] });
    assert.deepEqual([res.statusCode, res.body.error_description], [403, 'a personal token of the account is required']);
  });

  it('[OCUR5] refuses more than 50 ids, a non-array and a non-string id; an empty list answers no client', async () => {
    const many = Array.from({ length: MAX_CLIENT_IDS + 1 }, (_, i) => 'c' + i);
    assert.equal(MAX_CLIENT_IDS, 50);
    let res = await call({ username: 'alice', userToken: 'tok', clientIds: many });
    assert.deepEqual([res.statusCode, res.body.error], [400, 'invalid_request']);
    res = await call({ username: 'alice', userToken: 'tok', clientIds: 'op-app' });
    assert.equal(res.statusCode, 400);
    res = await call({ username: 'alice', userToken: 'tok', clientIds: ['op-app', 3] });
    assert.equal(res.statusCode, 400);
    res = await call({ username: 'alice', userToken: 'tok', clientIds: [] });
    assert.deepEqual([res.statusCode, res.body], [200, { clients: {} }]);
  });

  it('[OCUR6] an account served by another core answers 421 wrong_core with its URL', async () => {
    resolved = { wrongCore: true, coreUrl: 'https://core-b.example.com/' };
    const res = await call({ username: 'alice', userToken: 'tok', clientIds: ['op-app'] });
    assert.deepEqual([res.statusCode, res.body.error, res.body.coreUrl], [421, 'wrong_core', 'https://core-b.example.com/']);
  });

  it('[OCUR7] mounted only when the host wires listHeldClientIds', function () {
    const mounted = [];
    const app = { get () {}, use () {}, post (path) { mounted.push(path); } };
    const base = {
      config: fakeConfig({ 'oauth:stateKey': 'state-key-for-tests-0123456789abcdef', 'oauth:consentUrl': 'https://consent.example.com/' }),
      platform: fakePlatform(),
      resolveUser: async () => null,
      createAccess: async () => ({}),
      resolveUsername: async () => null,
    };
    registerRoutes(app, base);
    assert.ok(!mounted.includes('/oauth2/clients/validation'));
    mounted.length = 0;
    registerRoutes(app, { ...base, listHeldClientIds: async () => [] });
    assert.ok(mounted.includes('/oauth2/clients/validation'));
  });
});
