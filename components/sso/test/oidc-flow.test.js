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
import { listeningAgent } from 'test-helpers/src/listeningAgent.ts';
import { startFakeIdp } from './fake-idp.js';
const require = createRequire(import.meta.url);

const { registerRoutes } = require('../src/index.ts');

const ADMIN_KEY = 'operator-admin-key-for-sso-tests';
const CALLBACK_BASE = 'https://core.example.com';
const LANDING = 'https://auth.example.com/sso-signin';

describe('[SSOC] SSO OIDC client flow', function () {
  this.timeout(20000);

  let idp, app, request, lastIdentity, onIdentityImpl;

  /** What the completion seam returns; a test may swap it (see [SSOC18]). */
  const defaultOnIdentity = async () => ({ location: LANDING + '?ok=1' });

  before(async () => {
    idp = await startFakeIdp();
    lastIdentity = null;
    onIdentityImpl = defaultOnIdentity;

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
      onIdentity: async (claims) => { lastIdentity = claims; return onIdentityImpl(claims); },
      logger: { warn: () => {} }
    });
    // Not a bare app: see listeningAgent.ts on why supertest(app) flakes on macOS.
    request = await listeningAgent(app);
  });

  after(async () => { if (idp != null) await idp.close(); });

  beforeEach(() => {
    lastIdentity = null;
    onIdentityImpl = defaultOnIdentity;
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
  async function startFlow (provider, query = '') {
    const res1 = await request.get(`/auth/sso/${provider}/start${query}`);
    assert.equal(res1.status, 302, 'start should 302 to the IdP');
    const authorizeUrl = res1.headers.location;
    const setCookie = res1.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.length === 1, 'start should set the state cookie');
    const cookie = setCookie[0].split(';')[0];

    const idpRes = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(idpRes.status, 302, 'fake IdP authorize should 302 back to the callback');
    const cbUrl = new URL(idpRes.headers.get('location'));
    return { cookie, callbackPath: cbUrl.pathname + cbUrl.search, authorizeUrl };
  }

  /** Decode the signed cookie's payload without verifying (test inspection). */
  function cookiePayload (cookie) {
    const body = cookie.slice(cookie.indexOf('=') + 1).split('.')[0];
    const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - body.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  }

  /** The single `ssoReturn` value carried on a redirect location's fragment. */
  function fragmentReturn (location) {
    const hashAt = location.indexOf('#');
    if (hashAt < 0) return null;
    return new URLSearchParams(location.slice(hashAt + 1)).get('ssoReturn');
  }

  it('[SSOC1] happy path: valid id_token → onIdentity receives the claims → 302 to landing', async () => {
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.startsWith(LANDING), 'redirects to the landing page');
    assert.ok(!res.headers.location.includes('ssoError'), 'no error marker on success');
    assert.notEqual(lastIdentity, null);
    assert.equal(lastIdentity.provider, 'test');
    assert.equal(lastIdentity.sub, 'idp-subject-123');
    assert.equal(lastIdentity.email, 'user@example.com');
    assert.equal(lastIdentity.emailVerified, true);
  });

  it('[SSOC1B] GET /auth/sso/providers lists the operator allow-list (id + label only)', async () => {
    const res = await request.get('/auth/sso/providers');
    assert.equal(res.status, 200);
    const ids = res.body.providers.map((p) => p.id).sort();
    assert.deepEqual(ids, ['other', 'test']);
    const test = res.body.providers.find((p) => p.id === 'test');
    assert.equal(test.label, 'Test');
    // Never leaks issuer / client credentials.
    assert.equal(test.issuer, undefined);
    assert.equal(test.clientId, undefined);
    assert.equal(test.clientSecret, undefined);
  });

  it('[SSOC2] unknown provider → 404 at /start', async () => {
    const res = await request.get('/auth/sso/nope/start');
    assert.equal(res.status, 404);
  });

  it('[SSOC3] email_verified:false flows through to onIdentity as false (linking decides later)', async () => {
    idp.control.emailVerified = false;
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.notEqual(lastIdentity, null);
    assert.equal(lastIdentity.emailVerified, false);
  });

  it('[SSOC4] wrong aud → uniform failure, onIdentity NOT called', async () => {
    idp.control.audOverride = 'some-other-client';
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('#ssoError=sso-failed'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC5] wrong iss → uniform failure', async () => {
    idp.control.issOverride = 'https://evil.example.com';
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC6] expired id_token → uniform failure', async () => {
    idp.control.expOverride = Math.floor(Date.now() / 1000) - 60;
    const { cookie, callbackPath } = await startFlow('test');
    const res = await request.get(callbackPath).set('Cookie', cookie);
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
    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC9] callback with no state cookie → uniform failure (replay defence)', async () => {
    const { callbackPath } = await startFlow('test');
    const res = await request.get(callbackPath); // no Cookie header
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC10] tampered state cookie → uniform failure', async () => {
    const { cookie, callbackPath } = await startFlow('test');
    const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const res = await request.get(callbackPath).set('Cookie', tampered);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  it('[SSOC11] provider mismatch: cookie minted for "other", replayed on "test" callback → failure', async () => {
    const started = await startFlow('other');
    // Rewrite the callback path to the "test" provider while keeping other's cookie.
    const testCallback = started.callbackPath.replace('/auth/sso/other/callback', '/auth/sso/test/callback');
    const res = await request.get(testCallback).set('Cookie', started.cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(lastIdentity, null);
  });

  // --- ssoReturn: the app's opaque return context across the IdP round-trip ---

  const RETURN_VALUE = 'returnURL=https%3A%2F%2Fapp.example%2Fcb&state=abc&requestingAppId=my-app&h=n1';

  it('[SSOC12] ssoReturn on start comes back unchanged on the callback fragment', async () => {
    const { cookie, callbackPath } = await startFlow(
      'test', `?ssoReturn=${encodeURIComponent(RETURN_VALUE)}`);
    // It rode the cookie, not the IdP.
    assert.equal(cookiePayload(cookie).returnState, RETURN_VALUE);

    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.equal(fragmentReturn(res.headers.location), RETURN_VALUE,
      'the decoded value must equal what /start received, byte for byte');
    // The identity seam is untouched by this feature.
    assert.notEqual(lastIdentity, null);
    assert.equal(lastIdentity.sub, 'idp-subject-123');
  });

  it('[SSOC13] a start without ssoReturn carries no returnState and echoes nothing', async () => {
    const { cookie, callbackPath } = await startFlow('test');
    assert.equal(Object.prototype.hasOwnProperty.call(cookiePayload(cookie), 'returnState'), false);

    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.equal(fragmentReturn(res.headers.location), null);
    assert.ok(!res.headers.location.includes('ssoReturn'));
  });

  it('[SSOC14] an oversize ssoReturn is refused with 400, no cookie and no redirect', async () => {
    const res = await request.get(`/auth/sso/test/start?ssoReturn=${'x'.repeat(2049)}`);
    assert.equal(res.status, 400);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers.location, undefined);
  });

  it('[SSOC15] an out-of-alphabet ssoReturn is refused with 400', async () => {
    for (const bad of ['has a space', 'has#hash', 'semi;colon', 'quote"inside', 'nl%0Aline\n']) {
      const res = await request.get(`/auth/sso/test/start?ssoReturn=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(res.headers['set-cookie'], undefined);
    }
  });

  it('[SSOC16] a duplicated ssoReturn parameter is refused with 400 (array, not a string)', async () => {
    const res = await request.get('/auth/sso/test/start?ssoReturn=a&ssoReturn=b');
    assert.equal(res.status, 400);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('[SSOC17] the IdP authorization URL carries neither ssoReturn nor its value', async () => {
    const { authorizeUrl } = await startFlow(
      'test', `?ssoReturn=${encodeURIComponent(RETURN_VALUE)}`);
    assert.ok(!authorizeUrl.includes('ssoReturn'), 'the IdP must not see the parameter');
    assert.ok(!authorizeUrl.includes('app.example'), 'nor the app return target');
    assert.ok(!authorizeUrl.includes('requestingAppId'));
  });

  it('[SSOC18] a refusal from the identity seam still carries ssoReturn', async () => {
    onIdentityImpl = async () => ({ location: LANDING + '#ssoError=no-account' });
    const { cookie, callbackPath } = await startFlow(
      'test', `?ssoReturn=${encodeURIComponent(RETURN_VALUE)}`);
    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('#ssoError=no-account'));
    // Appended with `&` because the refusal location already has a fragment.
    assert.equal(fragmentReturn(res.headers.location), RETURN_VALUE);
  });

  it('[SSOC19] an unverified cookie never reflects a return state', async () => {
    // Tampered signature: the return state rode a cookie we cannot trust.
    const started = await startFlow('test', `?ssoReturn=${encodeURIComponent(RETURN_VALUE)}`);
    const tampered = started.cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const res = await request.get(started.callbackPath).set('Cookie', tampered);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('#ssoError=sso-failed'));
    assert.equal(fragmentReturn(res.headers.location), null);

    // Provider mismatch: verified signature, wrong binding — same rule.
    const other = await startFlow('other', `?ssoReturn=${encodeURIComponent(RETURN_VALUE)}`);
    const crossed = other.callbackPath.replace('/auth/sso/other/callback', '/auth/sso/test/callback');
    const res2 = await request.get(crossed).set('Cookie', other.cookie);
    assert.equal(res2.status, 302);
    assert.ok(res2.headers.location.includes('ssoError'));
    assert.equal(fragmentReturn(res2.headers.location), null);
  });

  it('[SSOC21] a failure AFTER the cookie verified still carries ssoReturn back', async () => {
    // The token exchange throws (wrong aud), which lands in the catch. The
    // cookie had already verified, so the app still gets its context back and
    // can return the user where they were instead of stranding them.
    const { cookie, callbackPath } = await startFlow(
      'test', `?ssoReturn=${encodeURIComponent(RETURN_VALUE)}`);
    idp.control.audOverride = 'some-other-client';
    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('#ssoError=sso-failed'));
    assert.equal(fragmentReturn(res.headers.location), RETURN_VALUE);
    assert.equal(lastIdentity, null);
  });

  it('[SSOC22] an EXPIRED cookie carrying a return state echoes nothing', async () => {
    // Expiry is a pre-verification failure like a bad signature: the value is
    // not reflected, even though it is intact and was ours.
    const { signStateCookie, STATE_COOKIE_NAME } = require('../src/stateCookie.ts');
    const { callbackPath } = await startFlow('test', `?ssoReturn=${encodeURIComponent(RETURN_VALUE)}`);
    const staleValue = signStateCookie(
      ADMIN_KEY,
      { provider: 'test', state: 'st', nonce: 'nc', pkceVerifier: 'pk', returnState: RETURN_VALUE },
      Math.floor(Date.now() / 1000) - 700);
    const res = await request.get(callbackPath).set('Cookie', `${STATE_COOKIE_NAME}=${staleValue}`);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('ssoError'));
    assert.equal(fragmentReturn(res.headers.location), null);
    assert.equal(lastIdentity, null);
  });

  it('[SSOC23] an EMPTY ssoReturn is accepted and carries nothing', async () => {
    const { cookie, callbackPath } = await startFlow('test', '?ssoReturn=');
    assert.equal(Object.prototype.hasOwnProperty.call(cookiePayload(cookie), 'returnState'), false,
      'an empty value must not reach the cookie payload');
    const res = await request.get(callbackPath).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.ok(!res.headers.location.includes('ssoReturn'));
  });

  it('[SSOC20] a maximum-size ssoReturn keeps the cookie under the 4096-byte limit and still round-trips', async () => {
    const maxValue = 'x'.repeat(2048);
    const res1 = await request.get(`/auth/sso/test/start?ssoReturn=${maxValue}`);
    assert.equal(res1.status, 302);
    const setCookie = res1.headers['set-cookie'][0];
    const nameAndValue = setCookie.split(';')[0];
    assert.ok(Buffer.byteLength(nameAndValue) < 4096,
      `state cookie is ${Buffer.byteLength(nameAndValue)} bytes, over the per-cookie limit`);

    const cookie = nameAndValue;
    const idpRes = await fetch(res1.headers.location, { redirect: 'manual' });
    const cbUrl = new URL(idpRes.headers.get('location'));
    const res2 = await request.get(cbUrl.pathname + cbUrl.search).set('Cookie', cookie);
    assert.equal(res2.status, 302);
    assert.equal(fragmentReturn(res2.headers.location), maxValue);
  });
});
