/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { startFakeIdp } from '../../sso/test/fake-idp.js';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * [SSOE] Third-party sign-in end-to-end: real mint + real handoff.
 *
 * The sign-in ROUTES need dynamic config (a fake IdP on an ephemeral port),
 * which the once-booted shared core cannot carry at boot; the MINT needs the
 * booted core (api / storageLayer / methods). So this mounts the REAL
 * `routes/sso.ts` (its onIdentity does the actual auth.ssoLogin mint +
 * sharedSecrets handoff against the live core) on a test-local express app
 * wired to the booted application, and injects the provider config at runtime.
 * The fake IdP (../../sso/test/fake-idp.js) makes openid-client run for real.
 *
 * Proves: non-MFA login mints a session delivered ONLY via a one-time shared
 * secret (the token never appears in the redirect URL); the key is one-shot;
 * an MFA-active account hands off only the factor-gated mfaToken; a refusal
 * carries a coarse code and no secret. `-seq` because it mutates boiler config.
 */

const container = require('business/src/emails/container.ts');
const C = require('business/src/emails/constants.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getPlatform } = require('platform');
const { getApplication } = require('../src/application.ts');
const { injectTestConfigSnapshot } = require('test-helpers');
const { base32Decode, totpCode } = require('business/src/mfa/totp.ts');
const timestamp = require('unix-timestamp');

const LANDING = 'https://auth.example.com/sso-signin';
const CALLBACK_BASE = 'https://core.example.com';
const ADMIN_KEY = 'sso-e2e-admin-key';
const PROVIDER = 'testidp';
const PASSWORD = 'password-for-sso-e2e-123';
const TRUSTED_ORIGIN = 'http://test.pryv.local';
const TRUSTED_APP = 'pryv-test';

function totpCodeFor (secretB32, offsetSteps = 0) {
  const now = Math.floor(Date.now() / 1000);
  return totpCode(base32Decode(secretB32), { time: now + offsetSteps * 30, periodSeconds: 30, digits: 6 });
}

// Parse a URL fragment (`#a=1&b=2`) into a flat map.
function hashParams (location) {
  const hash = location.includes('#') ? location.slice(location.indexOf('#') + 1) : '';
  return Object.fromEntries(new URLSearchParams(hash));
}

describe('[SSOE] SSO sign-in end-to-end (mint + handoff)', function () {
  this.timeout(40000);
  let idp, ssoApp, fixtures, restoreConfig, platform;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    platform = await getPlatform();

    idp = await startFakeIdp();
    restoreConfig = injectTestConfigSnapshot({
      // Make this suite self-contained against sibling-suite config leakage.
      // dnsLess/dns: SSO is single-core / dnsLess only, else linking resolves
      // in multi-core mode. sharedSecrets: the shared-secrets-config suite runs
      // first and tightens maxSizeBytes / maxTtl to tiny values; without
      // re-asserting the defaults, our handoff secret (token + apiEndpoint URL)
      // exceeds them and sharedSecrets.create throws, surfacing as sso-failed.
      dnsLess: { isActive: true },
      dns: { active: false },
      sharedSecrets: { enabled: true, maxSizeBytes: 4096, maxTtl: 2592000 },
      sso: {
        enabled: true,
        landingPageURL: LANDING,
        callbackBaseURL: CALLBACK_BASE,
        providers: {
          [PROVIDER]: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, label: 'Test IdP' }
        }
      },
      auth: { adminAccessKey: ADMIN_KEY }
    });

    // Mount the REAL sign-in routes on a test-local app wired to the booted core.
    ssoApp = express();
    require('../src/routes/sso.ts').default(ssoApp, getApplication());
  });

  after(async function () {
    if (restoreConfig != null) restoreConfig();
    if (idp != null) await idp.close();
    await fixtures.clean();
  });

  beforeEach(function () {
    Object.assign(idp.control, {
      sub: 'idp-sub-' + cuid(),
      email: null,
      emailVerified: true,
      audOverride: null,
      issOverride: null,
      expOverride: null,
      omitNonce: false,
      signingKey: 'primary'
    });
  });

  // A user whose `email` both routes to it (platform row) and is PROVED in the
  // :_emails: container, so the SSO linking rules resolve it (R5).
  async function makeProvedUser (email, opts = {}) {
    const username = 'ssoe' + cuid().toLowerCase().slice(1, 12);
    await fixtures.user(username, { email: cuid() + '@primary.example.com', password: opts.password });
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    await container.ensureContainerStream(userId);
    await container.reserveRow(username, email);
    await container.createEmailEvent(userId, {
      value: email,
      primary: false,
      status: C.STATUS_VERIFIED,
      verifiedAt: timestamp.now(),
      verificationMethod: C.METHOD_OPERATOR
    });
    return { username, userId };
  }

  // Drive /start → fake IdP /authorize → returns the state cookie + callback path.
  async function startFlow () {
    const res1 = await request(ssoApp).get(`/auth/sso/${PROVIDER}/start`);
    assert.strictEqual(res1.status, 302, 'start should 302 to the IdP: ' + JSON.stringify(res1.body));
    const setCookie = res1.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.length === 1, 'start should set the state cookie');
    const cookie = setCookie[0].split(';')[0];
    const idpRes = await fetch(res1.headers.location, { redirect: 'manual' });
    assert.strictEqual(idpRes.status, 302, 'fake IdP authorize should 302 back');
    const cbUrl = new URL(idpRes.headers.get('location'));
    return { cookie, callbackPath: cbUrl.pathname + cbUrl.search };
  }

  async function runCallback () {
    const { cookie, callbackPath } = await startFlow();
    const res = await request(ssoApp).get(callbackPath).set('Cookie', cookie);
    assert.strictEqual(res.status, 302, 'callback should 302 to the landing page');
    return res.headers.location;
  }

  it('[SSOE1] non-MFA: mints a session delivered via a one-time shared secret; no token in the URL', async function () {
    const email = cuid() + '@ssoe1.example.com';
    const u = await makeProvedUser(email);
    idp.control.email = email;

    const location = await runCallback();
    assert.ok(location.startsWith(LANDING + '#'), 'must redirect to the landing page fragment: ' + location);
    const p = hashParams(location);
    assert.strictEqual(p.ssoStatus, 'login', 'expected login; location=' + location);
    assert.strictEqual(p.ssoUser, u.username);
    assert.ok(p.ssoKey && p.ssoKey.length > 0, 'a one-time handoff key must be present');
    assert.strictEqual(p.ssoError, undefined);

    // Redeem the one-time key (unauthenticated, key in the body).
    const ret = await coreRequest.post(`/${u.username}/shared-secrets/retrieve`).send({ key: p.ssoKey });
    assert.strictEqual(ret.status, 200, 'retrieve should succeed: ' + JSON.stringify(ret.body));
    const secret = ret.body.secret;
    assert.ok(secret && typeof secret.token === 'string', 'the secret must carry the session token');
    assert.strictEqual(secret.provider, PROVIDER);

    // The long-lived token NEVER appeared in the redirect URL.
    assert.strictEqual(location.includes(secret.token), false, 'the session token must not appear in the URL');

    // Session parity: the minted token authenticates a normal API call.
    const who = await coreRequest.get(`/${u.username}/access-info`).set('Authorization', secret.token);
    assert.strictEqual(who.status, 200, 'the minted token must authenticate: ' + JSON.stringify(who.body));

    // First-login binding was persisted (a second sign-in would hit R4).
    const bound = await platform.getUsersUniqueField('sso-' + PROVIDER, idp.control.sub);
    assert.ok(bound != null, 'the (provider, sub) binding must be persisted');
  });

  it('[SSOE2] the handoff key is one-shot: a second redemption fails', async function () {
    const email = cuid() + '@ssoe2.example.com';
    const u = await makeProvedUser(email);
    idp.control.email = email;

    const p = hashParams(await runCallback());
    const first = await coreRequest.post(`/${u.username}/shared-secrets/retrieve`).send({ key: p.ssoKey });
    assert.strictEqual(first.status, 200);
    const second = await coreRequest.post(`/${u.username}/shared-secrets/retrieve`).send({ key: p.ssoKey });
    assert.notStrictEqual(second.status, 200, 'a consumed key must not redeem twice');
  });

  it('[SSOE3] refusal (no matching account) carries a coarse code and no secret', async function () {
    idp.control.email = cuid() + '@nobody-ssoe.example.com';
    const location = await runCallback();
    const p = hashParams(location);
    assert.strictEqual(p.ssoError, 'no-account');
    assert.strictEqual(p.ssoKey, undefined);
    assert.strictEqual(p.ssoStatus, undefined);
  });

  it('[SSOE4] MFA-active account hands off only the factor-gated mfaToken, not the session token', async function () {
    const email = cuid() + '@ssoe4.example.com';
    const u = await makeProvedUser(email, { password: PASSWORD });
    idp.control.email = email;

    // Make the account MFA-active via the real TOTP ceremony.
    const login = await coreRequest.post(`/${u.username}/auth/login`).set('Origin', TRUSTED_ORIGIN)
      .send({ username: u.username, password: PASSWORD, appId: TRUSTED_APP });
    assert.strictEqual(login.status, 200, 'password login: ' + JSON.stringify(login.body));
    const personalToken = login.body.token;
    const act = await coreRequest.post(`/${u.username}/mfa/activate`).set('Authorization', personalToken).send({});
    assert.strictEqual(act.status, 302, 'mfa activate: ' + JSON.stringify(act.body));
    const secret = act.body.secret;
    const confirm = await coreRequest.post(`/${u.username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
      .send({ code: totpCodeFor(secret, -1) });
    assert.strictEqual(confirm.status, 200, 'mfa confirm: ' + JSON.stringify(confirm.body));

    // SSO sign-in now hands off the mfaToken only.
    const location = await runCallback();
    const p = hashParams(location);
    assert.strictEqual(p.ssoStatus, 'mfa');
    assert.strictEqual(p.ssoUser, u.username);
    assert.ok(p.ssoMfaToken && p.ssoMfaToken.length > 0, 'an mfaToken must be handed off');
    assert.strictEqual(p.ssoMfaMethod, 'totp');
    assert.strictEqual(p.ssoKey, undefined, 'no shared-secret key in the MFA branch');

    // Completing the second factor yields the real token, which was NEVER in the URL.
    const verify = await coreRequest.post(`/${u.username}/mfa/verify`).set('Authorization', p.ssoMfaToken)
      .send({ code: totpCodeFor(secret, 0) });
    assert.strictEqual(verify.status, 200, 'mfa verify: ' + JSON.stringify(verify.body));
    assert.ok(verify.body.token != null, 'the real token is released only after the second factor');
    assert.strictEqual(location.includes(verify.body.token), false, 'the session token must not appear in the URL');
  });

  it('[SSOE5] auth.ssoLogin is refused when reached with an access token (callBatch), and mints nothing', async function () {
    const u = await makeProvedUser(cuid() + '@ssoe5.example.com', { password: PASSWORD });
    const login = await coreRequest.post(`/${u.username}/auth/login`).set('Origin', TRUSTED_ORIGIN)
      .send({ username: u.username, password: PASSWORD, appId: TRUSTED_APP });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const token = login.body.token;

    // The generic batch dispatcher sets methodId from client input; the mint is
    // password-less, so it must be refused for any token-bearing caller.
    const res = await coreRequest.post(`/${u.username}`).set('Authorization', token)
      .send([{ method: 'auth.ssoLogin', params: { username: u.username, appId: 'sso-evil' } }]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const results = res.body.results;
    assert.ok(Array.isArray(results) && results.length === 1, JSON.stringify(res.body));
    assert.ok(results[0].error != null, 'auth.ssoLogin must be refused via batch, got ' + JSON.stringify(results[0]));
    assert.strictEqual(results[0].token, undefined, 'no session token may be minted');

    // No side effect: the guard runs before openSession / access creation.
    const accesses = await coreRequest.get(`/${u.username}/accesses`).set('Authorization', token);
    const evil = (accesses.body.accesses || []).find((a) => a.name === 'sso-evil');
    assert.strictEqual(evil, undefined, 'the refused mint must not create a personal access');
  });
});
