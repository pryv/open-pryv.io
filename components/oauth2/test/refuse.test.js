/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-REFUSE] OAuth2 — POST /oauth2/authorize/refuse handler.
 *
 * Verifies signed-state in, no access creation, returns the refuse
 * redirect URL `redirect_uri?error=access_denied&state=...&iss=...`.
 */

const assert = require('node:assert/strict');
const { handleRefuse } = require('../src/routes/refuse.ts');
const { signState } = require('../src/signedState.ts');

const ADMIN_KEY = 'admin-key-tests';
const ISSUER = 'https://reg.pryv.me';

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'auth:adminAccessKey': ADMIN_KEY,
    ...overrides,
  };
  return { get: (k) => m[k] };
}

const SAMPLE_PAYLOAD = {
  clientId: 'myapp',
  redirectUri: 'https://app.example/cb',
  state: 'csrf-1',
  codeChallenge: 'cc',
  codeChallengeMethod: 'S256',
  scope: ['pryv:read'],
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

describe('[OAUTH-REFUSE] /oauth2/authorize/refuse handler', () => {
  it('[ORF-OK1] valid state → 200 + redirectTo with error=access_denied + state + iss', async () => {
    const handler = handleRefuse({ config: fakeConfig() });
    const res = fakeRes();
    await handler({ body: { state: signState(ADMIN_KEY, SAMPLE_PAYLOAD) } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.redirectTo.startsWith('https://app.example/cb?error=access_denied'));
    assert.match(res.body.redirectTo, /&state=csrf-1/);
    assert.match(res.body.redirectTo, /&iss=https%3A%2F%2Freg\.pryv\.me/);
  });

  it('[ORF-OK2] preserves an existing query string on redirect_uri (uses & separator)', async () => {
    const handler = handleRefuse({ config: fakeConfig() });
    const res = fakeRes();
    await handler({
      body: {
        state: signState(ADMIN_KEY, { ...SAMPLE_PAYLOAD, redirectUri: 'https://app.example/cb?x=1' }),
      }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.redirectTo.startsWith('https://app.example/cb?x=1&error=access_denied'));
  });

  it('[ORF-S1] missing state → 400 invalid_request', async () => {
    const handler = handleRefuse({ config: fakeConfig() });
    const res = fakeRes();
    await handler({ body: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_request');
  });

  it('[ORF-S2] tampered state → 400 invalid_request bad_signature', async () => {
    const handler = handleRefuse({ config: fakeConfig() });
    const res = fakeRes();
    const good = signState(ADMIN_KEY, SAMPLE_PAYLOAD);
    const [body, mac] = good.split('.');
    const tampered = body.slice(0, -1) + (body.at(-1) === 'A' ? 'B' : 'A') + '.' + mac;
    await handler({ body: { state: tampered } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error_description, /bad_signature/);
  });

  it('[ORF-S3] expired state → 400 invalid_request expired', async () => {
    const handler = handleRefuse({ config: fakeConfig() });
    const res = fakeRes();
    const old = signState(ADMIN_KEY, SAMPLE_PAYLOAD, Math.floor(Date.now() / 1000) - 10_000);
    await handler({ body: { state: old } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error_description, /expired/);
  });

  it('[ORF-C1] missing service:api → 500 server_error', async () => {
    const handler = handleRefuse({ config: fakeConfig({ 'service:api': null }) });
    const res = fakeRes();
    await handler({ body: { state: signState(ADMIN_KEY, SAMPLE_PAYLOAD) } }, res);
    assert.equal(res.statusCode, 500);
  });

  it('[ORF-C2] missing auth:adminAccessKey → 500 server_error', async () => {
    const handler = handleRefuse({ config: fakeConfig({ 'auth:adminAccessKey': null }) });
    const res = fakeRes();
    await handler({ body: { state: signState(ADMIN_KEY, SAMPLE_PAYLOAD) } }, res);
    assert.equal(res.statusCode, 500);
  });
});
