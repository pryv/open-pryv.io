/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OACO] the OAuth surface (`/oauth2/*`, `/.well-known/*`) answers CORS with
 * its own policy, on the real api-server: any origin, no credentials,
 * `POST, GET, OPTIONS`, `Content-Type, Authorization, DPoP`, preflight 204.
 * The API's own CORS (origin echoed, credentials allowed, preflight 200)
 * stays on every other route, the root-level ones included.
 */

/* global initTests, initCore, coreRequest */

const assert = require('node:assert/strict');

const ORIGIN = 'https://app.example';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const STATE_KEY = 'test-oauth-state-key-' + 'a1B2c3D4e5'.repeat(2);

describe('[OACO] OAuth CORS on the api-server', function () {
  this.timeout(30000);
  let restoreConfig;

  before(async function () {
    await initTests();
    await initCore();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({ oauth: { consentUrl: CONSENT_URL, stateKey: STATE_KEY } });
  });

  after(function () {
    restoreConfig?.();
  });

  function preflight (path, headers = 'content-type, dpop') {
    return coreRequest.options(path)
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', headers);
  }

  function describeRes (res) {
    return `${res.status} ${JSON.stringify(res.headers)} ${res.text?.slice(0, 200)}`;
  }

  /** The OAuth policy, and nothing of the API's CORS. */
  function assertOAuthPolicy (res, { preflight: isPreflight }) {
    assert.equal(res.headers['access-control-allow-origin'], '*', describeRes(res));
    assert.equal(res.headers['access-control-allow-credentials'], undefined, describeRes(res));
    assert.equal(res.headers['access-control-expose-headers'], undefined, describeRes(res));
    if (isPreflight) {
      assert.equal(res.status, 204, describeRes(res));
      assert.equal(res.headers['access-control-allow-methods'], 'POST, GET, OPTIONS');
      assert.equal(res.headers['access-control-allow-headers'], 'Content-Type, Authorization, DPoP');
      assert.equal(res.headers['access-control-max-age'], '3600');
    }
  }

  it('[OACO1] the token preflight is answered by the OAuth policy', async function () {
    assertOAuthPolicy(await preflight('/oauth2/token'), { preflight: true });
  });

  it('[OACO2] a token error answer carries the OAuth policy, no credentials header', async function () {
    const res = await coreRequest.post('/oauth2/token').set('Origin', ORIGIN).type('form').send({ grant_type: 'nope' });
    assert.equal(res.status, 400, describeRes(res));
    assert.match(res.headers['content-type'], /^application\/json/);
    assertOAuthPolicy(res, { preflight: false });
    assert.ok(res.headers['api-version'] != null, 'API-Version stays');
  });

  it('[OACO3] the consent screen\'s offer, accept and refuse: preflight and answer under the OAuth policy', async function () {
    for (const step of ['offer', 'accept', 'refuse']) {
      assertOAuthPolicy(await preflight('/oauth2/authorize/' + step, 'content-type'), { preflight: true });
    }
    const res = await coreRequest.post('/oauth2/authorize/refuse').set('Origin', ORIGIN).send({ state: 'not-a-signed-state' });
    assert.ok(res.status >= 400 && res.status < 500, describeRes(res));
    assertOAuthPolicy(res, { preflight: false });
  });

  it('[OACO4] the discovery document and the key set: any origin, no credentials, the discovery cache kept', async function () {
    const discovery = await coreRequest.get('/.well-known/oauth-authorization-server').set('Origin', ORIGIN);
    assert.equal(discovery.status, 200, describeRes(discovery));
    assertOAuthPolicy(discovery, { preflight: false });
    assert.equal(discovery.headers['cache-control'], 'public, max-age=300');
    const jwks = await coreRequest.get('/oauth2/jwks').set('Origin', ORIGIN);
    assertOAuthPolicy(jwks, { preflight: false });
    assertOAuthPolicy(await preflight('/.well-known/oauth-authorization-server'), { preflight: true });
  });

  it('[OACO5] the revocation preflight is answered by the OAuth policy', async function () {
    const discovery = await coreRequest.get('/.well-known/oauth-authorization-server');
    assert.match(discovery.body.revocation_endpoint ?? '', /\/oauth2\/revoke$/, 'revocation mounted');
    assertOAuthPolicy(await preflight('/oauth2/revoke'), { preflight: true });
  });

  it('[OACO7] a body the parsers refuse, and the bare prefixes, answer under the OAuth policy too', async function () {
    const malformed = await coreRequest.post('/oauth2/authorize/offer').set('Origin', ORIGIN)
      .set('Content-Type', 'application/json').send('{');
    assert.equal(malformed.status, 400, describeRes(malformed));
    assertOAuthPolicy(malformed, { preflight: false });
    for (const path of ['/oauth2', '/.well-known']) {
      const bare = await coreRequest.get(path).set('Origin', ORIGIN);
      assertOAuthPolicy(bare, { preflight: false });
    }
  });

  it('[OACO6] the other routes keep the API\'s CORS: origin echoed, credentials allowed, preflight 200', async function () {
    for (const path of ['/users', '/auth/sso/x/callback', '/reg/cores']) {
      const res = await preflight(path, 'content-type, authorization');
      assert.equal(res.status, 200, path + ': ' + describeRes(res));
      assert.equal(res.headers['access-control-allow-origin'], ORIGIN, path);
      assert.equal(res.headers['access-control-allow-credentials'], 'true', path);
      assert.equal(res.headers['access-control-allow-methods'], 'POST', path);
      assert.equal(res.headers['access-control-allow-headers'], 'content-type, authorization', path);
      assert.equal(res.headers['access-control-expose-headers'], 'API-Version', path);
    }
  });
});
