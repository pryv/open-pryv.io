/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OACS] the OAuth surface's CORS policy: any origin, no credentials, its own
 * preflight answer, mounted once over the whole surface (`/oauth2/*`,
 * `/.well-known/*`), which the API's CORS middleware leaves alone.
 */

const assert = require('node:assert/strict');
const { corsMiddleware, isOAuthSurface, OAUTH_CORS_PATHS } = require('../src/cors.ts');
const { registerRoutes } = require('../src/routes.ts');

function fakeRes () {
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end () { this.ended = true; },
  };
}

describe('[OACS] OAuth CORS policy', () => {
  it('[OACS1] isOAuthSurface: the /oauth2/ and /.well-known/ paths only, the bare prefixes included', () => {
    for (const path of ['/oauth2/token', '/oauth2/authorize/offer', '/oauth2/jwks', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/oauth2', '/.well-known']) {
      assert.equal(isOAuthSurface(path), true, path);
    }
    for (const path of ['/oauth2x', '/users', '/auth/sso/x/callback', '/alice/events', '/reg/cores', '/alice/oauth2/token', '/.well-knownx']) {
      assert.equal(isOAuthSurface(path), false, path);
    }
    assert.deepEqual([...OAUTH_CORS_PATHS], ['/oauth2/', '/.well-known/']);
  });

  it('[OACS2] corsMiddleware answers a preflight 204 with the policy and no credentials header; other methods go on', () => {
    const preflight = fakeRes();
    let nextCalled = false;
    corsMiddleware({ method: 'OPTIONS', headers: { origin: 'https://app.example' } }, preflight, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.ended, true);
    assert.deepEqual(preflight.headers, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, DPoP',
      'access-control-max-age': '3600',
      vary: 'Origin',
    });
    const post = fakeRes();
    corsMiddleware({ method: 'POST', headers: {} }, post, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(post.ended, false);
    assert.equal(post.headers['access-control-allow-origin'], '*');
    assert.equal(post.headers['access-control-allow-credentials'], undefined);
  });

  it('[OACS3] registerRoutes mounts the policy once per surface prefix, before the routes', () => {
    const order = [];
    const add = (method) => (path, ...handlers) => { order.push([method, path, handlers]); };
    const app = { get: add('GET'), post: add('POST'), use: add('USE') };
    const config = { 'service:api': 'https://reg.pryv.me', 'oauth:stateKey': 'state-key-for-tests-0123456789abcdef', 'core:id': 'core-a' };
    registerRoutes(app, {
      config: { get: (k) => config[k] },
      platform: {},
      resolveUser: async () => null,
      createAccess: async () => { throw new Error('not expected'); },
      resolveUsername: async () => null,
    });
    const uses = order.filter(([method]) => method === 'USE');
    assert.deepEqual(uses.map(([, path, handlers]) => [path, handlers]), [['/oauth2', [corsMiddleware]], ['/.well-known', [corsMiddleware]]]);
    assert.equal(order.findIndex(([method]) => method !== 'USE'), uses.length, 'mounted before every route');
    // The routes themselves carry no CORS handler of their own.
    for (const [method, path, handlers] of order.filter(([m]) => m !== 'USE')) {
      assert.ok(!handlers.includes(corsMiddleware), method + ' ' + path);
    }
  });
});
