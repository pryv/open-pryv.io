/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-E2E] OAuth 2.0 authorization-code flow — full end-to-end.
 *
 * Exercises the wiring landed in components/api-server/src/routes/oauth2.ts:
 *   GET  /oauth2/authorize           → 302 to consent URL w/ signed state
 *   POST /oauth2/authorize/accept    → user-authenticated; mints access; returns code redirect
 *   POST /oauth2/token               → PKCE verify; returns Bearer + refresh
 *   GET  /<username>/events          → token works on the resource server
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid. Drives
 * the full chain with the real api method registry, so this also acts
 * as the integration test for the resolveUser + createAccess callbacks.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const storage = require('oauth2/src/storage.ts');
const { getConfig } = require('@pryv/boiler');

const REDIRECT_URI = 'https://app.example/cb';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';

function pkce () {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function base64url (buf) {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

describe('[OAUTH-E2E] OAuth 2.0 authorization-code flow', function () {
  this.timeout(30000);

  let username, personalToken, clientId, fixtures, savedConsentUrl;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();

    const config = await getConfig();
    savedConsentUrl = config.get('oauth:consentUrl');
    config.set('oauth:consentUrl', CONSENT_URL);

    // User + personal token via the standard fixture helpers.
    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username);
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);

    // Register the OAuth client directly in PlatformDB — no CLI roundtrip
    // needed for the test, the wire shape is what matters.
    clientId = 'app-' + cuid();
    const platformDB = require('storages').platformDB;
    await storage.setClient(platformDB, {
      clientId,
      redirectUris: [REDIRECT_URI],
      scope: ['pryv:read', 'pryv:write'],
      grantTypes: ['authorization_code'],
      clientName: 'OAuth E2E Test App',
      updatedAt: Date.now(),
    });
  });

  after(async function () {
    const config = await getConfig();
    if (savedConsentUrl != null) config.set('oauth:consentUrl', savedConsentUrl);
    if (clientId != null) {
      const platformDB = require('storages').platformDB;
      try { await storage.deleteClient(platformDB, clientId); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) await fixtures.clean();
  });

  // Drive the four-call flow once; tests below assert different
  // properties on the captured artifacts.
  async function runFullFlow (overrides = {}) {
    const { verifier, challenge } = pkce();
    const csrf = 'csrf-' + cuid();
    const requestedScope = overrides.scope ?? 'pryv:read pryv:write';
    const grantedScope = overrides.grantedScope ?? ['pryv:read'];

    // 1. /authorize
    const authRes = await coreRequest
      .get('/oauth2/authorize')
      .query({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        state: csrf,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: requestedScope,
      });
    if (overrides.expectAuthStatus != null) {
      assert.equal(authRes.status, overrides.expectAuthStatus,
        `expected /authorize ${overrides.expectAuthStatus}, got ${authRes.status}`);
      return { authRes };
    }
    assert.equal(authRes.status, 302);
    const loc = authRes.headers.location;
    const signedState = decodeURIComponent(loc.split('state=')[1].split('&')[0]);

    // 2. /authorize/accept
    const acceptRes = await coreRequest
      .post('/oauth2/authorize/accept')
      .send({
        state: signedState,
        username,
        userToken: personalToken,
        grantedScope,
      });
    if (overrides.expectAcceptStatus != null) {
      assert.equal(acceptRes.status, overrides.expectAcceptStatus,
        `expected /accept ${overrides.expectAcceptStatus}, got ${acceptRes.status} ${JSON.stringify(acceptRes.body)}`);
      return { authRes, acceptRes };
    }
    assert.equal(acceptRes.status, 200, JSON.stringify(acceptRes.body));
    const code = decodeURIComponent(acceptRes.body.redirectTo.match(/code=([^&]+)/)[1]);

    // 3. /token
    const tokenBody = {
      grant_type: 'authorization_code',
      code,
      code_verifier: overrides.wrongVerifier ?? verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    };
    const tokenRes = await coreRequest
      .post('/oauth2/token')
      .type('form')
      .send(tokenBody);

    return { authRes, signedState, acceptRes, code, tokenBody, tokenRes, verifier };
  }

  describe('[OAUTH-E2E-OK] happy path', function () {
    it('[OE01] /authorize 302s to consent URL with signed state', async function () {
      const { challenge } = pkce();
      const res = await coreRequest
        .get('/oauth2/authorize')
        .query({
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          state: 'csrf-1',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'pryv:read',
        });
      assert.equal(res.status, 302);
      assert.ok(res.headers.location.startsWith(CONSENT_URL + '?state='));
    });

    it('[OE02] full chain mints a Bearer token usable on /<username>/events', async function () {
      const r = await runFullFlow();
      assert.equal(r.tokenRes.status, 200, JSON.stringify(r.tokenRes.body));
      assert.equal(r.tokenRes.body.token_type, 'Bearer');
      assert.equal(r.tokenRes.body.scope, 'pryv:read');
      assert.equal(typeof r.tokenRes.body.access_token, 'string');
      assert.equal(typeof r.tokenRes.body.refresh_token, 'string');
      assert.equal(typeof r.tokenRes.body.apiEndpoint, 'string');

      // Token works on the resource server.
      const eventsRes = await coreRequest
        .get('/' + username + '/events')
        .set('Authorization', r.tokenRes.body.access_token);
      assert.equal(eventsRes.status, 200);
      assert.ok(Array.isArray(eventsRes.body.events));
    });

    it('[OE03] scope downgrade — requested write+read, granted read only', async function () {
      const r = await runFullFlow({ scope: 'pryv:read pryv:write', grantedScope: ['pryv:read'] });
      assert.equal(r.tokenRes.status, 200);
      assert.equal(r.tokenRes.body.scope, 'pryv:read');
    });
  });

  describe('[OAUTH-E2E-FAIL] negative cases', function () {
    it('[OE10] code reuse → invalid_grant on the second exchange', async function () {
      const r = await runFullFlow();
      assert.equal(r.tokenRes.status, 200);
      const second = await coreRequest
        .post('/oauth2/token')
        .type('form')
        .send(r.tokenBody);
      assert.equal(second.status, 400);
      assert.equal(second.body.error, 'invalid_grant');
    });

    it('[OE11] wrong PKCE verifier → invalid_grant', async function () {
      const r = await runFullFlow({ wrongVerifier: 'wrong-verifier-' + cuid() });
      assert.equal(r.tokenRes.status, 400);
      assert.equal(r.tokenRes.body.error, 'invalid_grant');
    });

    it('[OE12] /accept with wrong userToken → 401', async function () {
      // Drive /authorize to capture a real signed state.
      const { challenge } = pkce();
      const csrf = 'csrf-bad-tok';
      const authRes = await coreRequest
        .get('/oauth2/authorize')
        .query({
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          state: csrf,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'pryv:read',
        });
      const signedState = decodeURIComponent(authRes.headers.location.split('state=')[1].split('&')[0]);
      const acceptRes = await coreRequest
        .post('/oauth2/authorize/accept')
        .send({
          state: signedState,
          username,
          userToken: 'not-a-real-token',
          grantedScope: ['pryv:read'],
        });
      assert.equal(acceptRes.status, 401);
    });

    it('[OE13] /authorize with unknown client_id → HTML 400 (no redirect)', async function () {
      const { challenge } = pkce();
      const res = await coreRequest
        .get('/oauth2/authorize')
        .query({
          client_id: 'never-registered',
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          state: 'x',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'pryv:read',
        });
      assert.equal(res.status, 400);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.equal(res.headers.location, undefined);
    });
  });

  describe('[OAUTH-E2E-REFRESH] refresh_token grant', function () {
    it('[OE15] refresh round-trip: code-grant → refresh-grant → new Bearer usable on /events', async function () {
      const r = await runFullFlow();
      assert.equal(r.tokenRes.status, 200);
      const firstAccess = r.tokenRes.body.access_token;
      const firstRefresh = r.tokenRes.body.refresh_token;
      // Refresh
      const refreshRes = await coreRequest
        .post('/oauth2/token')
        .type('form')
        .send({ grant_type: 'refresh_token', refresh_token: firstRefresh, client_id: clientId });
      assert.equal(refreshRes.status, 200, JSON.stringify(refreshRes.body));
      assert.equal(refreshRes.body.token_type, 'Bearer');
      assert.notEqual(refreshRes.body.access_token, firstAccess, 'refresh must mint a new access');
      assert.notEqual(refreshRes.body.refresh_token, firstRefresh, 'refresh must rotate the refresh token');
      assert.equal(refreshRes.body.scope, 'pryv:read');
      // New token works on the resource server.
      const eventsRes = await coreRequest
        .get('/' + username + '/events')
        .set('Authorization', refreshRes.body.access_token);
      assert.equal(eventsRes.status, 200);
    });

    it('[OE16] reused refresh token → invalid_grant', async function () {
      const r = await runFullFlow();
      const firstRefresh = r.tokenRes.body.refresh_token;
      const params = { grant_type: 'refresh_token', refresh_token: firstRefresh, client_id: clientId };
      const r1 = await coreRequest.post('/oauth2/token').type('form').send(params);
      assert.equal(r1.status, 200);
      const r2 = await coreRequest.post('/oauth2/token').type('form').send(params);
      assert.equal(r2.status, 400);
      assert.equal(r2.body.error, 'invalid_grant');
    });
  });

  describe('[OAUTH-E2E-REFUSE] refuse path', function () {
    it('[OE14] POST /oauth2/authorize/refuse returns redirect URL with error=access_denied', async function () {
      const { challenge } = pkce();
      const authRes = await coreRequest
        .get('/oauth2/authorize')
        .query({
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          state: 'csrf-refuse',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'pryv:read',
        });
      const signedState = decodeURIComponent(authRes.headers.location.split('state=')[1].split('&')[0]);
      const refuseRes = await coreRequest
        .post('/oauth2/authorize/refuse')
        .send({ state: signedState });
      assert.equal(refuseRes.status, 200, JSON.stringify(refuseRes.body));
      assert.ok(refuseRes.body.redirectTo.startsWith(REDIRECT_URI + '?error=access_denied'));
      assert.match(refuseRes.body.redirectTo, /&state=csrf-refuse/);
      assert.match(refuseRes.body.redirectTo, /&iss=/);
    });
  });

  describe('[OAUTH-E2E-CC] client_credentials grant', function () {
    let ccClientId, ccSecret;

    before(async function () {
      // Register an OAuth client with a client_secret and the
      // client_credentials grant enabled. Use the existing test user as
      // its `accountUsername` so the minted access targets a known user.
      const { mintSecret } = require('oauth2/src/clientSecret.ts');
      const mint = await mintSecret();
      ccSecret = mint.plaintext;
      ccClientId = 'app-cc-' + cuid();
      const platformDB = require('storages').platformDB;
      await storage.setClient(platformDB, {
        clientId: ccClientId,
        redirectUris: ['https://app.example/cb'],
        scope: ['pryv:read', 'pryv:write'],
        grantTypes: ['client_credentials'],
        clientName: 'OAuth E2E CC App',
        clientSecretHash: mint.hash,
        accountUsername: username,
        updatedAt: Date.now(),
      });
    });

    after(async function () {
      if (ccClientId != null) {
        const platformDB = require('storages').platformDB;
        try { await storage.deleteClient(platformDB, ccClientId); } catch (_) { /* best-effort */ }
      }
    });

    it('[OE17] HTTP Basic auth → 200 with Bearer; token works on /<username>/events; no refresh_token', async function () {
      const basic = 'Basic ' + Buffer.from(ccClientId + ':' + ccSecret).toString('base64');
      const tokenRes = await coreRequest
        .post('/oauth2/token')
        .type('form')
        .set('Authorization', basic)
        .send({ grant_type: 'client_credentials' });
      assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.body));
      assert.equal(tokenRes.body.token_type, 'Bearer');
      assert.equal(tokenRes.body.refresh_token, undefined, 'RFC 6749 §4.4.3 — no refresh_token');
      assert.equal(typeof tokenRes.body.access_token, 'string');
      assert.equal(typeof tokenRes.body.apiEndpoint, 'string');

      // Token works on the app account's own resource server.
      const eventsRes = await coreRequest
        .get('/' + username + '/events')
        .set('Authorization', tokenRes.body.access_token);
      assert.equal(eventsRes.status, 200);
      assert.ok(Array.isArray(eventsRes.body.events));
    });

    it('[OE18] wrong client_secret → 401 invalid_client', async function () {
      const basic = 'Basic ' + Buffer.from(ccClientId + ':wrong').toString('base64');
      const res = await coreRequest
        .post('/oauth2/token')
        .type('form')
        .set('Authorization', basic)
        .send({ grant_type: 'client_credentials' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'invalid_client');
    });
  });

  describe('[OAUTH-E2E-WK] discovery doc', function () {
    it('[OE20] GET /.well-known/oauth-authorization-server returns RFC 8414 doc', async function () {
      const res = await coreRequest.get('/.well-known/oauth-authorization-server');
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /json/);
      assert.ok(typeof res.body.issuer === 'string');
      assert.deepEqual(res.body.response_types_supported, ['code']);
      assert.deepEqual(res.body.code_challenge_methods_supported, ['S256']);
      assert.equal(res.body.authorization_response_iss_parameter_supported, true);
    });
  });
});
