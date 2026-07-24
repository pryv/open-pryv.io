/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-E2E] OAuth 2.0 authorization-code flow — full end-to-end,
 * granular consent-offer scope model.
 *
 * The app account publishes an OPEN-LINK `consent/request-cmc` offer
 * carrying the granular permission set (full accesses.create lexicon,
 * incl. a feature permission); its capability URL is registered on the
 * OAuth client as `cmcOffers['e2e']`; clients request `scope=cmc:e2e`.
 *
 * Exercises the wiring landed in components/api-server/src/routes/oauth2.ts:
 *   GET  /oauth2/authorize           → resolves the offer via its capability,
 *                                      302 to consent URL w/ signed state
 *   POST /oauth2/authorize/accept    → user-authenticated; drives a real
 *                                      consent/accept-cmc (data-grant on the
 *                                      user's account); mints the session
 *                                      access from the granted subset
 *   POST /oauth2/token               → PKCE verify; returns Bearer + refresh
 *   GET  /<username>/events          → token works on the resource server
 *   refresh after consent revocation → invalid_grant (chain dies)
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid. Outbound
 * HTTP (offer resolution + CMC delivery) is routed through the shared
 * in-process fetch shim.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const storage = require('oauth2/src/storage.ts');
const { getConfig } = require('@pryv/boiler');
const { buildFetchShim } = require('./cmc-fetch-shim.cjs');

const REDIRECT_URI = 'https://app.example/cb';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const OFFER_NAME = 'e2e';

/**
 * Render a response for an assertion message. An empty JSON body
 * stringifies to a useless `{}`, which hides whether the failure was an
 * OAuth error payload, an api-server fallback, or an unrouted request —
 * so include the status, the content-type and the raw text too.
 */
function describeRes (res) {
  if (res == null) return '<no response>';
  const body = res.body != null && Object.keys(res.body).length > 0
    ? JSON.stringify(res.body)
    : '<empty body>';
  const text = typeof res.text === 'string' && res.text.length > 0
    ? res.text.slice(0, 300)
    : '<empty text>';
  return `status=${res.status} content-type=${res.headers?.['content-type'] ?? '<none>'} ` +
    `body=${body} text=${text}`;
}

// Full-lexicon offer: two stream permissions + a feature permission.
// Cherry-picking is enabled on this offer (`allowUserChoice: true` —
// the DEFAULT all-or-nothing behavior has its own offer + cases below);
// `health` is mandatory (can never be unticked).
const OFFER_PERMISSIONS = [
  { streamId: 'health', level: 'read', mandatory: true },
  { streamId: 'diary', level: 'contribute' },
  { feature: 'selfRevoke', setting: 'forbidden' },
];
const DEFAULT_GRANTED = [
  { streamId: 'health', level: 'read' },
  { feature: 'selfRevoke', setting: 'forbidden' },
];
const AON_OFFER_NAME = 'e2e-aon'; // all-or-nothing sibling offer (no allowUserChoice)

function pkce () {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function base64url (buf) {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function ensureStream (path, token, params) {
  const res = await coreRequest.post(path).set('Authorization', token).send(params);
  if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
    throw new Error('ensureStream(' + params.id + ') failed: ' +
      res.status + ' ' + JSON.stringify(res.body));
  }
}

describe('[OAUTH-E2E] OAuth 2.0 authorization-code flow (granular consent-offer scope)', function () {
  this.timeout(60000);

  let username, personalToken, clientId, fixtures, savedConsentUrl;
  let appUsername, appToken, capabilityUrl, originalFetch;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();

    const config = await getConfig();
    savedConsentUrl = config.get('oauth:consentUrl');
    config.set('oauth:consentUrl', CONSENT_URL);

    // Outbound HTTP (offer resolution via capability URL + CMC
    // delivery) routes through the in-process server.
    originalFetch = globalThis.fetch;
    globalThis.fetch = buildFetchShim(originalFetch, global.app.expressApp);

    // End user + personal token; the offer's stream permissions
    // reference streams on THIS account.
    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username);
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    await ensureStream('/' + username + '/streams', personalToken, { id: 'health', name: 'Health' });
    await ensureStream('/' + username + '/streams', personalToken, { id: 'diary', name: 'Diary' });

    // App account (the OAuth client is a promoted user account). It
    // publishes the OPEN-LINK consent offer the scope references.
    appUsername = 'app' + cuid().slice(-12);
    appToken = cuid();
    const appUser = await fixtures.user(appUsername);
    await appUser.access({ token: appToken, type: 'personal' });
    await appUser.session(appToken);
    await ensureStream('/' + appUsername + '/streams', appToken,
      { id: ':_cmc:apps:e2e-oauth', parentId: ':_cmc:apps', name: 'OAuth e2e offers' });
    async function publishOffer (request) {
      const res = await coreRequest
        .post('/' + appUsername + '/events')
        .set('Authorization', appToken)
        .send({
          streamIds: [':_cmc:apps:e2e-oauth'],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            capability: { mode: 'open-link' },
            request,
            requesterMeta: { displayName: 'OAuth E2E Test App', appId: 'oauth-e2e' },
          },
        });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const url = res.body?.event?.content?.capabilityUrl;
      assert.ok(typeof url === 'string' && url.length > 0,
        'capabilityUrl should be stamped synchronously: ' + JSON.stringify(res.body?.event?.content));
      return url;
    }

    capabilityUrl = await publishOffer({
      title: { en: 'OAuth e2e offer' },
      description: { en: 'Share health data with the e2e app.' },
      consent: { en: 'I agree to share the listed data.' },
      permissions: OFFER_PERMISSIONS,
      allowUserChoice: true,
    });
    // Sibling offer WITHOUT allowUserChoice — the all-or-nothing default.
    const aonCapabilityUrl = await publishOffer({
      title: { en: 'OAuth e2e all-or-nothing offer' },
      description: { en: 'Take it or leave it.' },
      consent: { en: 'I agree to share ALL the listed data.' },
      permissions: [
        { streamId: 'health', level: 'read' },
        { streamId: 'diary', level: 'contribute' },
      ],
    });

    // Register the OAuth client directly in PlatformDB — no CLI roundtrip
    // needed for the test, the wire shape is what matters.
    clientId = 'app-' + cuid();
    const platformDB = require('storages').platformDB;
    await storage.setClient(platformDB, {
      clientId,
      redirectUris: [REDIRECT_URI],
      scope: ['cmc:' + OFFER_NAME, 'cmc:' + AON_OFFER_NAME],
      cmcOffers: {
        [OFFER_NAME]: { capabilityUrl },
        [AON_OFFER_NAME]: { capabilityUrl: aonCapabilityUrl },
      },
      grantTypes: ['authorization_code'],
      clientName: 'OAuth E2E Test App',
      updatedAt: Date.now(),
    });
  });

  after(async function () {
    const config = await getConfig();
    if (savedConsentUrl != null) config.set('oauth:consentUrl', savedConsentUrl);
    if (originalFetch != null) globalThis.fetch = originalFetch;
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
    const requestedScope = overrides.scope ?? ('cmc:' + OFFER_NAME);
    const grantedPermissions = overrides.grantedPermissions ?? DEFAULT_GRANTED;

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
    assert.equal(authRes.status, 302, 'GET /oauth2/authorize: ' + describeRes(authRes));
    const loc = authRes.headers.location;
    assert.ok(loc.startsWith(CONSENT_URL + '?state='), 'unexpected redirect: ' + loc);
    const signedState = decodeURIComponent(loc.split('state=')[1].split('&')[0]);

    // 2. /authorize/accept
    const acceptRes = await coreRequest
      .post('/oauth2/authorize/accept')
      .send({
        state: signedState,
        username,
        userToken: personalToken,
        grantedPermissions,
      });
    if (overrides.expectAcceptStatus != null) {
      assert.equal(acceptRes.status, overrides.expectAcceptStatus,
        `expected /accept ${overrides.expectAcceptStatus}, got ` + describeRes(acceptRes));
      return { authRes, acceptRes };
    }
    assert.equal(acceptRes.status, 200, 'POST /oauth2/authorize/accept: ' + describeRes(acceptRes));
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

  async function accessInfo (token) {
    const res = await coreRequest
      .get('/' + username + '/access-info')
      .set('Authorization', token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // access-info returns the access fields at the top level.
    const access = res.body.permissions != null ? res.body : res.body.access;
    assert.ok(access?.permissions != null, 'access-info carries permissions: ' + JSON.stringify(res.body));
    return access;
  }

  describe('[OAUTH-E2E-OK] happy path', function () {
    it('[OE01] /authorize resolves the offer via its capability and 302s to consent URL', async function () {
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
          scope: 'cmc:' + OFFER_NAME,
        });
      assert.equal(res.status, 302);
      assert.ok(res.headers.location.startsWith(CONSENT_URL + '?state='));
    });

    it('[OE02] full chain mints a Bearer whose permissions are EXACTLY the granted subset (incl. the feature permission)', async function () {
      const r = await runFullFlow();
      assert.equal(r.tokenRes.status, 200, 'POST /oauth2/token: ' + describeRes(r.tokenRes));
      assert.equal(r.tokenRes.body.token_type, 'Bearer');
      assert.equal(r.tokenRes.body.scope, 'cmc:' + OFFER_NAME);
      assert.equal(typeof r.tokenRes.body.access_token, 'string');
      assert.equal(typeof r.tokenRes.body.refresh_token, 'string');
      assert.equal(typeof r.tokenRes.body.apiEndpoint, 'string');

      // Token works on the resource server.
      const eventsRes = await coreRequest
        .get('/' + username + '/events')
        .set('Authorization', r.tokenRes.body.access_token);
      assert.equal(eventsRes.status, 200);
      assert.ok(Array.isArray(eventsRes.body.events));

      // Granular: the session access carries the granted subset only.
      const access = await accessInfo(r.tokenRes.body.access_token);
      const streamPerms = access.permissions.filter((p) => p.streamId != null && !p.streamId.startsWith(':'));
      assert.deepEqual(streamPerms, [{ streamId: 'health', level: 'read' }]);
      // The offer's selfRevoke restriction binds the durable data-grant, NOT
      // the ephemeral session credential: the session access carries an
      // explicit `allowed` override so it can always revoke its own token
      // (the server relies on that to delete orphaned pre-minted accesses).
      assert.ok(access.permissions.some((p) => p.feature === 'selfRevoke' && p.setting === 'allowed'),
        'session access must carry the selfRevoke:allowed override: ' + JSON.stringify(access.permissions));
      assert.ok(!access.permissions.some((p) => p.feature === 'selfRevoke' && p.setting === 'forbidden'),
        'the offer\'s selfRevoke:forbidden must NOT reach the session access: ' + JSON.stringify(access.permissions));

      // The durable consent record (CMC data-grant) exists on the user and
      // keeps the offer's feature permissions VERBATIM (incl. the forbidden).
      const accessesRes = await coreRequest
        .get('/' + username + '/accesses')
        .set('Authorization', personalToken);
      const dataGrant = (accessesRes.body.accesses ?? [])
        .find((a) => a.clientData?.cmc?.role === 'counterparty');
      assert.ok(dataGrant != null, 'CMC data-grant must exist on the user account');
      assert.ok((dataGrant.permissions ?? []).some((p) => p.feature === 'selfRevoke' && p.setting === 'forbidden'),
        'data-grant must keep the offer\'s selfRevoke:forbidden verbatim: ' + JSON.stringify(dataGrant.permissions));
    });

    it('[OE07] the grant emits user-scoped oauth.* audit rows into the user audit trail', async function () {
      const r = await runFullFlow();
      assert.equal(r.tokenRes.status, 200, 'POST /oauth2/token: ' + describeRes(r.tokenRes));

      // Consent + code-exchange + token-issuance are user-resolved events,
      // so they land in the end-user's per-user audit storage, readable via
      // the :_audit: store with the user's personal token.
      const auditRes = await coreRequest
        .get('/' + username + '/events')
        .set('Authorization', personalToken)
        .query({ streams: [':_audit:'], limit: 200 });
      assert.equal(auditRes.status, 200, 'GET :_audit: events: ' + describeRes(auditRes));

      const actions = new Set(
        (auditRes.body.events ?? [])
          .map((e) => e.content?.action)
          .filter((a) => typeof a === 'string' && a.startsWith('oauth.'))
      );
      for (const expected of [
        'oauth.consent.granted',
        'oauth.code.exchanged',
        'oauth.token.issued.authorization_code',
      ]) {
        assert.ok(actions.has(expected),
          'expected an audit row for "' + expected + '"; saw oauth actions: ' + JSON.stringify([...actions]));
      }
    });

    it('[OE03] consent downgrade — offer has diary+health, user keeps health only', async function () {
      const r = await runFullFlow({ grantedPermissions: [{ streamId: 'health', level: 'read' }] });
      assert.equal(r.tokenRes.status, 200, 'POST /oauth2/token: ' + describeRes(r.tokenRes));
      const access = await accessInfo(r.tokenRes.body.access_token);
      assert.ok(!access.permissions.some((p) => p.streamId === 'diary'),
        'un-ticked diary permission must NOT be granted: ' + JSON.stringify(access.permissions));
      assert.ok(access.permissions.some((p) => p.streamId === 'health' && p.level === 'read'));
    });

    it('[OE04] granted ⊄ offer (widened level) → 400 invalid_scope at /accept', async function () {
      const r = await runFullFlow({
        grantedPermissions: [{ streamId: 'health', level: 'manage' }],
        expectAcceptStatus: 400,
      });
      assert.equal(r.acceptRes.body.error, 'invalid_scope');
    });

    it('[OE05] DEFAULT all-or-nothing: partial grant on an offer without allowUserChoice → 400; full grant → 200', async function () {
      const partial = await runFullFlow({
        scope: 'cmc:' + AON_OFFER_NAME,
        grantedPermissions: [{ streamId: 'health', level: 'read' }],
        expectAcceptStatus: 400,
      });
      assert.equal(partial.acceptRes.body.error, 'invalid_scope');
      assert.match(partial.acceptRes.body.error_description, /all-or-nothing/);
      const full = await runFullFlow({
        scope: 'cmc:' + AON_OFFER_NAME,
        grantedPermissions: [
          { streamId: 'health', level: 'read' },
          { streamId: 'diary', level: 'contribute' },
        ],
      });
      assert.equal(full.tokenRes.status, 200, 'POST /oauth2/token: ' + describeRes(full.tokenRes));
    });

    it('[OE06] a mandatory entry cannot be unticked even with allowUserChoice → 400 invalid_scope', async function () {
      const r = await runFullFlow({
        grantedPermissions: [{ streamId: 'diary', level: 'contribute' }], // drops mandatory health
        expectAcceptStatus: 400,
      });
      assert.equal(r.acceptRes.body.error, 'invalid_scope');
      assert.match(r.acceptRes.body.error_description, /mandatory/);
    });
  });

  describe('[OAUTH-E2E-FAIL] negative cases', function () {
    // A bare 404 out of /oauth2/authorize is ambiguous: route not mounted,
    // client row missing from PlatformDB, or the consent-offer capability
    // not resolving. Discriminate them up front so an intermittent failure
    // in the cases below reports which prerequisite actually broke.
    beforeEach(async function () {
      const noParams = await coreRequest.get('/oauth2/authorize');
      assert.notEqual(noParams.status, 404,
        '/oauth2/authorize route not mounted: ' + describeRes(noParams));
      const platformDB = require('storages').platformDB;
      const clientRow = await storage.getClient(platformDB, clientId);
      assert.ok(clientRow != null, 'OAuth client fixture missing from PlatformDB: ' + clientId);
      const capRes = await globalThis.fetch(capabilityUrl);
      assert.equal(capRes.status, 200,
        'consent-offer capability URL does not resolve: ' + capabilityUrl + ' -> ' + capRes.status);
    });

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

    it('[OE23] wrong PKCE verifier → the pre-minted session access is revoked, not left alive', async function () {
      // A failed exchange AFTER the code is consumed abandons the access
      // minted at /accept; the grant handler must self-revoke it (the
      // session access carries the selfRevoke:allowed override, so the
      // HTTP accesses.delete of its own id, auth'd by its own token,
      // succeeds even though the offer forbids selfRevoke on the
      // data-grant).
      const list = async () => {
        const res = await coreRequest
          .get('/' + username + '/accesses')
          .set('Authorization', personalToken)
          .query({ includeDeletions: true });
        assert.equal(res.status, 200, describeRes(res));
        return res.body;
      };
      const before = await list();
      const beforeLive = new Set((before.accesses ?? []).map((a) => a.id));
      const beforeDeleted = new Set((before.accessDeletions ?? []).map((d) => d.id));

      const r = await runFullFlow({ wrongVerifier: 'wrong-verifier-' + cuid() });
      assert.equal(r.tokenRes.status, 400);
      assert.equal(r.tokenRes.body.error, 'invalid_grant');

      const after = await list();
      // runFullFlow asserted /accept returned 200, so a session access WAS
      // minted for this flow — after the failed exchange no new live session
      // access may remain for this client…
      const newLive = (after.accesses ?? []).filter((a) =>
        !beforeLive.has(a.id) && a.type === 'app' && a.name === 'oauth:' + clientId);
      assert.deepEqual(newLive.map((a) => a.id), [],
        'the pre-minted session access must be revoked on a failed exchange');
      // …and the revoked access shows up among the deletions (it existed,
      // then died — as opposed to never having been minted).
      const newDeletions = (after.accessDeletions ?? []).filter((d) => !beforeDeleted.has(d.id));
      assert.ok(newDeletions.length >= 1,
        'the revoked session access must appear among access deletions');
    });

    it('[OE12] /accept with wrong userToken → 401', async function () {
      const { challenge } = pkce();
      const authRes = await coreRequest
        .get('/oauth2/authorize')
        .query({
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          state: 'csrf-bad-tok',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'cmc:' + OFFER_NAME,
        });
      const signedState = decodeURIComponent(authRes.headers.location.split('state=')[1].split('&')[0]);
      const acceptRes = await coreRequest
        .post('/oauth2/authorize/accept')
        .send({
          state: signedState,
          username,
          userToken: 'not-a-real-token',
          grantedPermissions: DEFAULT_GRANTED,
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
          scope: 'cmc:' + OFFER_NAME,
        });
      assert.equal(res.status, 400);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.equal(res.headers.location, undefined);
    });

    it('[OE19] coarse scope tokens no longer exist → invalid_scope redirect', async function () {
      const { challenge } = pkce();
      const res = await coreRequest
        .get('/oauth2/authorize')
        .query({
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          state: 'csrf-coarse',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'pryv:read',
        });
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /^https:\/\/app\.example\/cb\?error=invalid_scope/);
    });
  });

  describe('[OAUTH-E2E-REFRESH] refresh_token grant — bound to the consent data-grant', function () {
    it('[OE15] refresh round-trip: code-grant → refresh-grant → new Bearer usable on /events', async function () {
      const r = await runFullFlow();
      assert.equal(r.tokenRes.status, 200);
      const firstAccess = r.tokenRes.body.access_token;
      const firstRefresh = r.tokenRes.body.refresh_token;
      const refreshRes = await coreRequest
        .post('/oauth2/token')
        .type('form')
        .send({ grant_type: 'refresh_token', refresh_token: firstRefresh, client_id: clientId });
      assert.equal(refreshRes.status, 200, 'POST /oauth2/token (refresh): ' + describeRes(refreshRes));
      assert.equal(refreshRes.body.token_type, 'Bearer');
      assert.notEqual(refreshRes.body.access_token, firstAccess, 'refresh must mint a new access');
      assert.notEqual(refreshRes.body.refresh_token, firstRefresh, 'refresh must rotate the refresh token');
      assert.equal(refreshRes.body.scope, 'cmc:' + OFFER_NAME);
      const eventsRes = await coreRequest
        .get('/' + username + '/events')
        .set('Authorization', refreshRes.body.access_token);
      assert.equal(eventsRes.status, 200);
      // Refreshed access keeps the granted subset (no widening to the full offer).
      const access = await accessInfo(refreshRes.body.access_token);
      assert.ok(!access.permissions.some((p) => p.streamId === 'diary'),
        'refresh must not widen beyond the session grant: ' + JSON.stringify(access.permissions));
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

    it('[OE21] revoking the consent data-grant kills the refresh chain (invalid_grant)', async function () {
      const r = await runFullFlow();
      assert.equal(r.tokenRes.status, 200);
      // The user revokes the durable consent (data-grant) directly.
      const accessesRes = await coreRequest
        .get('/' + username + '/accesses')
        .set('Authorization', personalToken);
      const dataGrant = (accessesRes.body.accesses ?? [])
        .find((a) => a.clientData?.cmc?.role === 'counterparty');
      assert.ok(dataGrant != null, 'data-grant must exist before revocation');
      const delRes = await coreRequest
        .delete('/' + username + '/accesses/' + encodeURIComponent(dataGrant.id))
        .set('Authorization', personalToken);
      assert.ok(delRes.status === 200 || delRes.status === 204, JSON.stringify(delRes.body));

      const refreshRes = await coreRequest
        .post('/oauth2/token')
        .type('form')
        .send({ grant_type: 'refresh_token', refresh_token: r.tokenRes.body.refresh_token, client_id: clientId });
      assert.equal(refreshRes.status, 400, 'POST /oauth2/token (refresh): ' + describeRes(refreshRes));
      assert.equal(refreshRes.body.error, 'invalid_grant');
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
          scope: 'cmc:' + OFFER_NAME,
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
        scope: ['app:own-data'],
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
      assert.equal(tokenRes.status, 200, 'POST /oauth2/token: ' + describeRes(tokenRes));
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

    it('[OE22] requesting a cmc:<offer-name> scope on client_credentials → invalid_scope', async function () {
      const platformDB = require('storages').platformDB;
      const existing = await storage.getClient(platformDB, ccClientId);
      await storage.setClient(platformDB, {
        ...existing,
        scope: ['app:own-data', 'cmc:' + OFFER_NAME],
        cmcOffers: { [OFFER_NAME]: { capabilityUrl } },
      });
      const basic = 'Basic ' + Buffer.from(ccClientId + ':' + ccSecret).toString('base64');
      const res = await coreRequest
        .post('/oauth2/token')
        .type('form')
        .set('Authorization', basic)
        .send({ grant_type: 'client_credentials', scope: 'cmc:' + OFFER_NAME });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_scope');
    });
  });

  describe('[OAUTH-E2E-DPOP] DPoP sender-constrained round-trip (RFC 9449)', function () {
    const { webcrypto } = require('node:crypto');
    const { subtle } = webcrypto;
    const DPOP_HOST = 'api.example.test';

    async function dpopKey () {
      const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const jwk = await subtle.exportKey('jwk', pair.publicKey);
      return { pair, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
    }
    async function proof (key, { htm, path, accessToken }) {
      const b = (buf) => Buffer.from(buf).toString('base64url');
      const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk };
      const payload = {
        jti: 'e2e-' + crypto.randomBytes(12).toString('hex'),
        htm,
        htu: `http://${DPOP_HOST}${path}`,
        iat: Math.floor(Date.now() / 1000),
        ...(accessToken != null ? { ath: crypto.createHash('sha256').update(accessToken).digest('base64url') } : {}),
      };
      const h = b(JSON.stringify(header)); const p = b(JSON.stringify(payload));
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, Buffer.from(`${h}.${p}`, 'utf8'));
      return `${h}.${p}.${b(sig)}`;
    }
    // Reverse-proxy headers so the server reconstructs DPOP_HOST for htu
    // while subdomain routing keeps seeing supertest's own Host.
    const fwd = (req) => req.set('X-Forwarded-Host', DPOP_HOST).set('X-Forwarded-Proto', 'http');

    // Each DPoP test needs its OWN open-link offer + client: re-accepting
    // the SAME open-link offer as the same user currently fails
    // (requester-side accepted-by bookkeeping is never cleared — tracked
    // separately), so a shared offer would break the second test. Publish
    // a fresh offer and register a fresh client per call.
    async function freshClientAndOffer () {
      const offerName = 'dpop-' + cuid().slice(-8);
      const capUrl = await coreRequest
        .post('/' + appUsername + '/events')
        .set('Authorization', appToken)
        .send({
          streamIds: [':_cmc:apps:e2e-oauth'],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            capability: { mode: 'open-link' },
            request: {
              title: { en: 'DPoP offer' },
              description: { en: 'x' },
              consent: { en: 'ok' },
              permissions: [{ streamId: 'health', level: 'read' }],
              allowUserChoice: true,
            },
            requesterMeta: { displayName: 'DPoP E2E', appId: 'oauth-e2e' },
          },
        })
        .then((r) => { assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.event.content.capabilityUrl; });
      const cid = 'app-dpop-' + cuid();
      await storage.setClient(require('storages').platformDB, {
        clientId: cid,
        redirectUris: [REDIRECT_URI],
        scope: ['cmc:' + offerName],
        cmcOffers: { [offerName]: { capabilityUrl: capUrl } },
        grantTypes: ['authorization_code'],
        clientName: 'DPoP E2E App',
        updatedAt: Date.now(),
      });
      return { cid, offerName };
    }

    // Drive authorize + accept to a fresh code on a dedicated offer.
    async function toCode () {
      const { cid, offerName } = await freshClientAndOffer();
      const { verifier, challenge } = pkce();
      const authRes = await coreRequest.get('/oauth2/authorize').query({
        client_id: cid,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        state: 'csrf-dpop-' + cuid(),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'cmc:' + offerName,
      });
      const signedState = decodeURIComponent(authRes.headers.location.split('state=')[1].split('&')[0]);
      const acceptRes = await coreRequest.post('/oauth2/authorize/accept').send({
        state: signedState,
        username,
        userToken: personalToken,
        grantedPermissions: [{ streamId: 'health', level: 'read' }],
      });
      assert.equal(acceptRes.status, 200, describeRes(acceptRes));
      return { code: decodeURIComponent(acceptRes.body.redirectTo.match(/code=([^&]+)/)[1]), verifier, clientId: cid };
    }

    it('[OE21DP] proof at /token binds the access; the token works only WITH a proof; refresh keeps the key; replay is refused', async function () {
      const key = await dpopKey();
      const { code, verifier, clientId: dpopClientId } = await toCode();

      // Token exchange carrying a DPoP proof → DPoP-bound token.
      const tokenRes = await fwd(coreRequest.post('/oauth2/token'))
        .type('form')
        .set('DPoP', await proof(key, { htm: 'POST', path: '/oauth2/token' }))
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: dpopClientId, redirect_uri: REDIRECT_URI });
      assert.equal(tokenRes.status, 200, describeRes(tokenRes));
      assert.equal(tokenRes.body.token_type, 'DPoP');
      const accessToken = tokenRes.body.access_token;

      // The bound token is unusable as plain Bearer.
      const bearer = await coreRequest.get('/' + username + '/events').set('Authorization', accessToken);
      assert.equal(bearer.status, 403, describeRes(bearer));

      // With a valid proof it works.
      const ok = await fwd(coreRequest.get('/' + username + '/events'))
        .set('Authorization', 'DPoP ' + accessToken)
        .set('DPoP', await proof(key, { htm: 'GET', path: '/' + username + '/events', accessToken }));
      assert.equal(ok.status, 200, describeRes(ok));
      assert.ok(Array.isArray(ok.body.events));

      // Replaying that exact proof is refused (jti single-use).
      const replayProof = await proof(key, { htm: 'GET', path: '/' + username + '/events', accessToken });
      const first = await fwd(coreRequest.get('/' + username + '/events')).set('Authorization', 'DPoP ' + accessToken).set('DPoP', replayProof);
      assert.equal(first.status, 200);
      const replay = await fwd(coreRequest.get('/' + username + '/events')).set('Authorization', 'DPoP ' + accessToken).set('DPoP', replayProof);
      assert.equal(replay.status, 403, describeRes(replay));

      // Refresh with a proof by the SAME key keeps the binding.
      const refreshRes = await fwd(coreRequest.post('/oauth2/token'))
        .type('form')
        .set('DPoP', await proof(key, { htm: 'POST', path: '/oauth2/token' }))
        .send({ grant_type: 'refresh_token', refresh_token: tokenRes.body.refresh_token, client_id: dpopClientId });
      assert.equal(refreshRes.status, 200, describeRes(refreshRes));
      assert.equal(refreshRes.body.token_type, 'DPoP');
      const rotated = refreshRes.body.access_token;
      const rotatedOk = await fwd(coreRequest.get('/' + username + '/events'))
        .set('Authorization', 'DPoP ' + rotated)
        .set('DPoP', await proof(key, { htm: 'GET', path: '/' + username + '/events', accessToken: rotated }));
      assert.equal(rotatedOk.status, 200, describeRes(rotatedOk));
    });

    it('[OE22DP] a stolen bound token + a DIFFERENT key cannot be used', async function () {
      const key = await dpopKey();
      const { code, verifier, clientId: dpopClientId } = await toCode();
      const tokenRes = await fwd(coreRequest.post('/oauth2/token'))
        .type('form')
        .set('DPoP', await proof(key, { htm: 'POST', path: '/oauth2/token' }))
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: dpopClientId, redirect_uri: REDIRECT_URI });
      assert.equal(tokenRes.status, 200, describeRes(tokenRes));
      const accessToken = tokenRes.body.access_token;
      const thiefKey = await dpopKey();
      const stolen = await fwd(coreRequest.get('/' + username + '/events'))
        .set('Authorization', 'DPoP ' + accessToken)
        .set('DPoP', await proof(thiefKey, { htm: 'GET', path: '/' + username + '/events', accessToken }));
      assert.equal(stolen.status, 403, describeRes(stolen));
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
      assert.deepEqual(res.body.dpop_signing_alg_values_supported, ['ES256']);
      assert.ok(res.body.scopes_supported.includes('cmc:*'),
        'discovery must advertise the cmc namespace: ' + JSON.stringify(res.body.scopes_supported));
    });
  });
});
