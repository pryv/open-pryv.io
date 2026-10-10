/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-ROUTES-GUARD] OAuth2 — route mount error guard.
 *
 * The handlers are async; Express 4 discards the promise a handler returns,
 * so a rejection would never reach an error handler. Every handler mounted by
 * `registerRoutes` must answer an error response instead of rejecting.
 */

const assert = require('node:assert/strict');
const { registerRoutes } = require('../src/routes.ts');
const { signState } = require('../src/signedState.ts');

const ADMIN_KEY = 'admin-key-tests';
const ISSUER = 'https://reg.pryv.me';

function fakeConfig () {
  const m = {
    'service:api': ISSUER,
    'auth:adminAccessKey': ADMIN_KEY,
    'core:id': 'core-a',
    'oauth:accessTokenTTL': 3600,
  };
  return { get: (k) => m[k] };
}

function fakeApp () {
  const routes = {};
  const add = (method) => (path, ...handlers) => { routes[method + ' ' + path] = handlers[handlers.length - 1]; };
  return { routes, get: add('GET'), post: add('POST'), options: add('OPTIONS') };
}

function fakeRes () {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    headersSent: false,
    writableEnded: false,
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ? JSON.parse(b) : null; this.headersSent = true; this.writableEnded = true; },
  };
}

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
    permissions: [{ streamId: 'health', level: 'read' }],
    allowUserChoice: false,
  },
};

function mount (overrides = {}) {
  const app = fakeApp();
  registerRoutes(app, {
    config: fakeConfig(),
    platform: {},
    resolveUser: async () => null,
    createAccess: async () => { throw new Error('not expected'); },
    resolveUsername: async () => null,
    ...overrides,
  });
  return app.routes;
}

describe('[OAUTH-ROUTES-GUARD] route mount error guard', () => {
  it('[ORG-1] a rejection inside the accept handler answers 500 server_error and the handler resolves', async () => {
    const routes = mount({ resolveUser: async () => { throw new Error('storage down at 10.0.0.1'); } });
    const res = fakeRes();
    let nextCalled = false;
    await routes['POST /oauth2/authorize/accept']({
      body: {
        state: signState(ADMIN_KEY, SAMPLE_PAYLOAD),
        username: 'alice',
        userToken: 'alice-token',
        grantedPermissions: [{ streamId: 'health', level: 'read' }],
      },
    }, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'server_error');
    assert.ok(!JSON.stringify(res.body).includes('10.0.0.1'), 'internal error text must not reach the client');
    assert.equal(nextCalled, false);
  });

  it('[ORG-2] a malformed signature on the mounted refuse route answers 400 and the handler resolves', async () => {
    const routes = mount();
    const res = fakeRes();
    const [body] = signState(ADMIN_KEY, SAMPLE_PAYLOAD).split('.');
    await routes['POST /oauth2/authorize/refuse']({ body: { state: body + '.' + 'é' + 'a'.repeat(42) } }, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error_description, /bad_signature/);
  });

  it('[ORG-3] a rejection after the response was sent leaves the response as sent', async () => {
    const { guardRoute } = require('../src/routes.ts');
    const res = fakeRes();
    const guarded = guardRoute(async (_req, r) => {
      r.statusCode = 200;
      r.end(JSON.stringify({ ok: true }));
      throw new Error('late failure');
    });
    await guarded({}, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });
});
