/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [SSOC] SSO OIDC client flow — start → (fake IdP) → callback.
 *
 * Drives the real handlers against the in-process fake IdP (test/fake-idp.js),
 * so openid-client's id_token verification, PKCE exchange, state + nonce checks
 * all run for real. Covers the happy path plus the refusal matrix (wrong aud /
 * iss, expired token, missing nonce) and the cookie guards (missing, tampered,
 * provider mismatch). See providers.ts on why the JWS signature is not checked.
 */

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { startFakeIdp } from './fake-idp.js';
const require = createRequire(import.meta.url);

const { registerRoutes } = require('../src/index.ts');

const ADMIN_KEY = 'operator-admin-key-for-sso-tests';
const CALLBACK_BASE = 'https://core.example.com';
const LANDING = 'https://auth.example.com/sso-signin';

describe('[SSOC] SSO OIDC client flow', function () {
  this.timeout(20000);

  let idp, app, lastIdentity;

  before(async () => {
    idp = await startFakeIdp();
    lastIdentity = null;

    const providers = {
      test: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, label: 'Test' },
      other: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, label: 'Other' }
    };
    const config = {
      get: (key) => {
        if (key === 'sso:enabled') return true;
        if (key === 'sso:providers') return providers;
        return undefined;
      }
    };

    app = express();
    registerRoutes(app, {
      config,
      adminKey: ADMIN_KEY,
      callbackBaseURL: CALLBACK_BASE,
      landingPageURL: LANDING,
      onIdentity: async (claims) => { lastIdentity = claims; return { location: LANDING + '?ok=1' }; },
      logger: { warn: () => {} }
    });
  });

  after(async () => { if (idp != null) await idp.close(); });

  beforeEach(() => {
    lastIdentity = null;
    // Reset IdP knobs to the default valid identity.
    Object.assign(idp.control, {
      sub: 'idp-subject-123',
      email: 'user@example.com',
      emailVerified: true,
      audOverride: null,
      issOverride: null,
      expOverride: null,
      omitNonce: false,
      signingKey: 'primary'
    });
  });

  // Drive /start, then the fake IdP /authorize, returning the state cookie and
  // the callback path (with code + state) to replay against our app.
  async function startFlow (provider) {
    const res1 = await request(app).get(`/auth/sso/${provider}/start`);
    assert.equal(res1.status, 302, 'start should 302 to the IdP');
    const authorizeUrl = res1.headers.location;
    const setCookie = res1.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.length === 1, 'start should set the state cookie');
    const cookie = setCookie[0].split(';')[0];

    const idpRes = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(idpRes.status, 302, 'fake IdP authorize should 302 back to the callback');
    const cbUrl = new URL(idpRes.headers.get('location'));
    return { cookie, callbackPath: cbUrl.pathname + cbUrl.search };
  }

  it('[SSOC1] happy path: valid id_token → onIdentity receives the claims → 302 to landing', async () => {
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request(app).get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.startsWith(LANDING), 'redirects to the landing page');
    assert.ok(!res.headers.location.includes('ssoError'), 'no error marker on success');
    assert.notEqual(lastIdentity, null);
    assert.equal(lastIdentity.provider, 'test');
    assert.equal(lastIdentity.sub, 'idp-subject-123');
    assert.equal(lastIdentity.email, 'user@example.com');
    assert.equal(lastIdentity.emailVerified, true);
  });

  it('[SSOC2] unknown provider → 404 at /start', async () => {
    const res = await request(app).get('/auth/sso/nope/start');
    assert.equal(res.status, 404);
  });

  it('[SSOC3] email_verified:false flows through to onIdentity as false (linking decides later)', async () => {
    idp.control.emailVerified = false;
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request(app).get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.notEqual(lastIdentity, null);
    assert.equal(lastIdentity.emailVerified, false);
  });

  it('[SSOC4] wrong aud → uniform failure, onIdentity NOT called', async () => {
    idp.control.audOverride = 'some-other-client';
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request(app).get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError=sign-in-failed'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC5] wrong iss → uniform failure', async () => {
    idp.control.issOverride = 'https://evil.example.com';
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request(app).get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC6] expired id_token → uniform failure', async () => {
    idp.control.expOverride = Math.floor(Date.now() / 1000) - 60;
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request(app).get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  // NOTE: no wrong-signing-key case here — the code flow validates the id_token
  // via iss/aud/exp/nonce over the direct TLS + client-secret channel and does
  // NOT check the JWS signature (OIDC Core §3.1.3.7); see providers.ts. If
  // signature validation is later enabled (enableNonRepudiationChecks), add a
  // secondary-key case (fake-idp.js already supports `signingKey:'secondary'`).

  it('[SSOC8] missing nonce in id_token → uniform failure', async () => {
    idp.control.omitNonce = true;
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request(app).get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC9] callback with no state cookie → uniform failure (replay defence)', async () => {
    const { callbackPath } = await startFlow('test');
    const res = await request(app).get(callbackPath); // no Cookie header
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC10] tampered state cookie → uniform failure', async () => {
    const { cookie, callbackPath } = await startFlow('test');
    const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const res = await request(app).get(callbackPath).set('Cookie', tampered);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC11] provider mismatch: cookie minted for "other", replayed on "test" callback → failure', async () => {
    const started = await startFlow('other');
    // Rewrite the callback path to the "test" provider while keeping other's cookie.
    const testCallback = started.callbackPath.replace('/auth/sso/other/callback', '/auth/sso/test/callback');
    const res = await request(app).get(testCallback).set('Cookie', started.cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });
});
