/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [PMRG] OAuth consent grants and refreshed sessions merge permissions stream
 * by stream.
 *
 * - Re-authorization joins the new consent into the durable data-grant: a
 *   stream granted at another level gets the level covering both, a pair no
 *   level covers exactly (`read` / `create-only`) is refused.
 * - A refresh mints the session from the meet of the chain's permissions and
 *   the data-grant's current ones: a narrowed stream is kept at the narrowed
 *   level, the grant's forbidden features reach the session.
 *
 * Two levels on one stream come from the app changing its offer between two
 * consents (the offer's capability copy is updated with the app's personal
 * token), so the second consent is a re-authorization of the same grant.
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid; outbound HTTP
 * through the in-process fetch shim.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const storage = require('oauth2/src/storage.ts');
const { parseApiEndpoint } = require('cmc/src/outbound.ts');
const { buildFetchShim } = require('./cmc-fetch-shim.cjs');

const REDIRECT_URI = 'https://app.example/cb';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';

function base64url (buf) {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function describeRes (res) {
  if (res == null) return '<no response>';
  return `status=${res.status} body=${JSON.stringify(res.body)} text=${String(res.text ?? '').slice(0, 300)}`;
}

/** An access id without its version serial. */
function baseOf (accessId) {
  return accessId.split(':')[0];
}

/** The plain (non-system) stream entries of a permission set. */
function userStreams (permissions) {
  return (permissions ?? []).filter((p) => typeof p.streamId === 'string' && !p.streamId.startsWith(':'))
    .map((p) => ({ streamId: p.streamId, level: p.level }));
}

describe('[PMRG] OAuth permission merge rule (re-consent join, refresh meet)', function () {
  this.timeout(120000);

  let username, personalToken, endUser, appUsername, appToken, clientId, fixtures, restoreConsentUrl, originalFetch;
  const offers = {}; // name -> capabilityUrl

  const STREAMS = ['pm1', 'pm2', 'pm3', 'pm4a', 'pm4b', 'pm5a', 'pm5b', 'pm6'];
  const INITIAL_OFFERS = {
    p1: [{ streamId: 'pm1', level: 'read' }],
    p2: [{ streamId: 'pm2', level: 'read' }],
    p3: [{ streamId: 'pm3', level: 'contribute' }],
    p4: [{ streamId: 'pm4a', level: 'read' }, { streamId: 'pm4b', level: 'read' }],
    p5: [{ streamId: 'pm5a', level: 'contribute' }, { streamId: 'pm5b', level: 'read' }],
    p6: [{ streamId: 'pm6', level: 'read' }]
  };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConsentUrl = require('test-helpers').injectTestConfigSnapshot({ oauth: { consentUrl: CONSENT_URL } });
    originalFetch = globalThis.fetch;
    globalThis.fetch = buildFetchShim(originalFetch, global.coreServer);

    username = cuid();
    personalToken = cuid();
    endUser = await fixtures.user(username);
    await endUser.access({ token: personalToken, type: 'personal' });
    await endUser.session(personalToken);
    for (const id of STREAMS) {
      const res = await coreRequest.post('/' + username + '/streams').set('Authorization', personalToken)
        .send({ id, name: id });
      assert.equal(res.status, 201, describeRes(res));
    }

    appUsername = 'app' + cuid().slice(-12);
    appToken = cuid();
    const appUser = await fixtures.user(appUsername);
    await appUser.access({ token: appToken, type: 'personal' });
    await appUser.session(appToken);
    const streamRes = await coreRequest.post('/' + appUsername + '/streams').set('Authorization', appToken)
      .send({ id: ':_cmc:apps:pmrg-oauth', parentId: ':_cmc:apps', name: 'merge rule offers' });
    assert.equal(streamRes.status, 201, describeRes(streamRes));

    for (const [name, permissions] of Object.entries(INITIAL_OFFERS)) {
      const res = await coreRequest.post('/' + appUsername + '/events').set('Authorization', appToken)
        .send({
          streamIds: [':_cmc:apps:pmrg-oauth'],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            capability: { mode: 'open-link' },
            request: {
              title: { en: 'Merge rule offer ' + name },
              description: { en: 'merge rule e2e' },
              consent: { en: 'I agree.' },
              permissions,
              allowUserChoice: true
            },
            requesterMeta: { displayName: 'Merge Rule Test App', appId: 'pmrg' }
          }
        });
      assert.equal(res.status, 201, describeRes(res));
      offers[name] = res.body.event.content.capabilityUrl;
      assert.equal(typeof offers[name], 'string', describeRes(res));
    }

    clientId = 'app-' + cuid();
    await storage.setClient(require('storages').platformDB, {
      clientId,
      redirectUris: [REDIRECT_URI],
      scope: Object.keys(offers).map((n) => 'cmc:' + n),
      cmcOffers: Object.fromEntries(Object.entries(offers).map(([n, capabilityUrl]) => [n, { capabilityUrl }])),
      grantTypes: ['authorization_code'],
      clientName: 'Merge Rule Test App',
      updatedAt: Date.now()
    });
  });

  after(async function () {
    if (restoreConsentUrl != null) restoreConsentUrl();
    if (originalFetch != null) globalThis.fetch = originalFetch;
    if (clientId != null) {
      try { await storage.deleteClient(require('storages').platformDB, clientId); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_) { /* best-effort */ }
    }
  });

  /** The app changes what its offer asks for (the copy the capability serves). */
  async function setOfferPermissions (offerName, permissions) {
    const { token } = parseApiEndpoint(offers[offerName]);
    const got = await coreRequest.get('/' + appUsername + '/events').set('Authorization', token)
      .query({ types: ['consent/request-cmc'] });
    assert.equal(got.status, 200, describeRes(got));
    assert.equal(got.body.events.length, 1, describeRes(got));
    const offer = got.body.events[0];
    const res = await coreRequest.put('/' + appUsername + '/events/' + offer.id).set('Authorization', appToken)
      .send({ content: { ...offer.content, request: { ...offer.content.request, permissions } } });
    assert.equal(res.status, 200, describeRes(res));
    // /authorize caches a resolved offer for a few seconds.
    require('oauth2/src/offerResolver.ts').clearOfferCache();
  }

  /** authorize + accept (+ token exchange when the accept succeeds). */
  async function consent (offerName, grantedPermissions) {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const authRes = await coreRequest.get('/oauth2/authorize').query({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'cmc:' + offerName
    });
    assert.equal(authRes.status, 302, describeRes(authRes));
    const signedState = decodeURIComponent(authRes.headers.location.split('state=')[1].split('&')[0]);
    const acceptRes = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state: signedState, username, userToken: personalToken, grantedPermissions });
    if (acceptRes.status !== 200) return { acceptRes };
    const code = decodeURIComponent(acceptRes.body.redirectTo.match(/code=([^&]+)/)[1]);
    const tokenRes = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI
    });
    assert.equal(tokenRes.status, 200, describeRes(tokenRes));
    return { acceptRes, tokenRes };
  }

  async function refresh (refreshToken) {
    return await coreRequest.post('/oauth2/token').type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  }

  async function accessInfo (token) {
    const res = await coreRequest.get('/' + username + '/access-info').set('Authorization', token);
    assert.equal(res.status, 200, describeRes(res));
    return res.body;
  }

  async function dataGrantOf (sessionToken) {
    const id = (await accessInfo(sessionToken)).clientData?.oauth?.dataGrantId;
    assert.equal(typeof id, 'string', 'premise: the session names its data-grant');
    return await getAccess(id);
  }

  async function getAccess (id, query = {}) {
    const res = await coreRequest.get('/' + username + '/accesses/' + encodeURIComponent(id))
      .set('Authorization', personalToken).query(query);
    assert.equal(res.status, 200, describeRes(res));
    return query.includeHistory ? res.body : res.body.access;
  }

  async function sessionCount () {
    const res = await coreRequest.get('/' + username + '/accesses').set('Authorization', personalToken);
    assert.equal(res.status, 200, describeRes(res));
    return res.body.accesses.filter((a) => a.name === 'oauth:' + clientId).length;
  }

  /** The owner rewrites the grant's permissions through the API. */
  async function ownerUpdateGrant (grant, mapPermissions) {
    const res = await coreRequest.put('/' + username + '/accesses/' + encodeURIComponent(grant.id))
      .set('Authorization', personalToken).send({ permissions: mapPermissions(grant.permissions) });
    assert.equal(res.status, 200, describeRes(res));
  }

  const setLevel = (streamId, level) => (perms) =>
    perms.map((p) => (p.streamId === streamId ? { streamId, level } : p));

  it('[PMRG1] a re-consent at a wider level on a granted stream leaves one entry at that level, in one new version', async function () {
    const first = await consent('p1', [{ streamId: 'pm1', level: 'read' }]);
    assert.equal(first.acceptRes.status, 200, describeRes(first.acceptRes));
    const grantBefore = await dataGrantOf(first.tokenRes.body.access_token);
    assert.deepEqual(userStreams(grantBefore.permissions), [{ streamId: 'pm1', level: 'read' }]);
    const historyBefore = (await getAccess(baseOf(grantBefore.id), { includeHistory: true })).history?.length ?? 0;

    await setOfferPermissions('p1', [{ streamId: 'pm1', level: 'contribute' }]);
    const second = await consent('p1', [{ streamId: 'pm1', level: 'contribute' }]);
    assert.equal(second.acceptRes.status, 200, describeRes(second.acceptRes));

    const grantAfter = await dataGrantOf(second.tokenRes.body.access_token);
    assert.equal(baseOf(grantAfter.id), baseOf(grantBefore.id), 'the same data-grant is reused');
    assert.deepEqual(userStreams(grantAfter.permissions), [{ streamId: 'pm1', level: 'contribute' }]);
    const historyAfter = (await getAccess(baseOf(grantBefore.id), { includeHistory: true })).history?.length ?? 0;
    assert.equal(historyAfter, historyBefore + 1, 'one new version of the grant');

    // A re-consent at the level already granted changes nothing.
    const third = await consent('p1', [{ streamId: 'pm1', level: 'contribute' }]);
    assert.equal(third.acceptRes.status, 200, describeRes(third.acceptRes));
    const historyNoop = (await getAccess(baseOf(grantBefore.id), { includeHistory: true })).history?.length ?? 0;
    assert.equal(historyNoop, historyAfter, 'a same-level re-consent writes no version');
  });

  it('[PMRG2] a re-consent asking create-only on a stream granted read is refused (400 invalid_scope), grant unchanged, no session, audited', async function () {
    const first = await consent('p2', [{ streamId: 'pm2', level: 'read' }]);
    assert.equal(first.acceptRes.status, 200, describeRes(first.acceptRes));
    const grantBefore = await dataGrantOf(first.tokenRes.body.access_token);
    const sessionsBefore = await sessionCount();

    const auditSingleton = require('audit').default;
    const originalEventForUser = auditSingleton.eventForUser;
    const refusals = [];
    auditSingleton.eventForUser = async function (userId, row, event) {
      if (event === 'oauth.consent.refused') refusals.push(row.content.record);
      return await originalEventForUser.apply(this, arguments);
    };
    let second;
    try {
      await setOfferPermissions('p2', [{ streamId: 'pm2', level: 'create-only' }]);
      second = await consent('p2', [{ streamId: 'pm2', level: 'create-only' }]);
    } finally {
      auditSingleton.eventForUser = originalEventForUser;
    }
    assert.equal(second.acceptRes.status, 400, describeRes(second.acceptRes));
    assert.equal(second.acceptRes.body.error, 'invalid_scope');
    assert.match(second.acceptRes.body.error_description, /conflicting permission level/);
    assert.match(second.acceptRes.body.error_description, /pm2/);

    const grantAfter = await getAccess(baseOf(grantBefore.id));
    assert.deepEqual(grantAfter.permissions, grantBefore.permissions, 'grant unchanged');
    assert.equal(await sessionCount(), sessionsBefore, 'no session minted');
    assert.ok(refusals.some((r) => r.clientId === clientId && r.reason === 'permission-level-conflict'),
      'audited as a refused consent: ' + JSON.stringify(refusals));
  });

  it('[PMRG3] a refresh after the owner narrowed the grant from contribute to read carries read', async function () {
    const r = await consent('p3', [{ streamId: 'pm3', level: 'contribute' }]);
    assert.equal(r.acceptRes.status, 200, describeRes(r.acceptRes));
    const grant = await dataGrantOf(r.tokenRes.body.access_token);
    await ownerUpdateGrant(grant, setLevel('pm3', 'read'));

    const refreshed = await refresh(r.tokenRes.body.refresh_token);
    assert.equal(refreshed.status, 200, describeRes(refreshed));
    const session = await accessInfo(refreshed.body.access_token);
    assert.deepEqual(userStreams(session.permissions), [{ streamId: 'pm3', level: 'read' }]);
    const write = await coreRequest.post('/' + username + '/events').set('Authorization', refreshed.body.access_token)
      .send({ streamIds: ['pm3'], type: 'note/txt', content: 'x' });
    assert.equal(write.status, 403, describeRes(write));
  });

  it('[PMRG4] a refresh after narrowing a read stream to create-only drops it; a session left with no reach gets invalid_grant', async function () {
    const both = await consent('p4', [{ streamId: 'pm4a', level: 'read' }, { streamId: 'pm4b', level: 'read' }]);
    assert.equal(both.acceptRes.status, 200, describeRes(both.acceptRes));
    const only = await consent('p4', [{ streamId: 'pm4a', level: 'read' }]);
    assert.equal(only.acceptRes.status, 200, describeRes(only.acceptRes));
    const grant = await dataGrantOf(both.tokenRes.body.access_token);
    await ownerUpdateGrant(grant, setLevel('pm4a', 'create-only'));

    const refreshedBoth = await refresh(both.tokenRes.body.refresh_token);
    assert.equal(refreshedBoth.status, 200, describeRes(refreshedBoth));
    assert.deepEqual(userStreams((await accessInfo(refreshedBoth.body.access_token)).permissions),
      [{ streamId: 'pm4b', level: 'read' }]);

    const refreshedOnly = await refresh(only.tokenRes.body.refresh_token);
    assert.equal(refreshedOnly.status, 400, describeRes(refreshedOnly));
    assert.equal(refreshedOnly.body.error, 'invalid_grant');
  });

  it('[PMRG5] a grant stored with two entries for one stream applies the last one, and the next consent writes it deduplicated', async function () {
    const first = await consent('p5', [{ streamId: 'pm5a', level: 'contribute' }]);
    assert.equal(first.acceptRes.status, 200, describeRes(first.acceptRes));
    const grant = await dataGrantOf(first.tokenRes.body.access_token);
    // Seed the legacy shape storage-direct (the API refuses it).
    const legacy = grant.permissions.flatMap((p) => (p.streamId === 'pm5a'
      ? [{ streamId: 'pm5a', level: 'read' }, { streamId: 'pm5a', level: 'contribute' }]
      : [p]));
    const base = baseOf(grant.id);
    const repo = require('storages').storageLayer.accesses;
    const user = { id: endUser.attrs.id, username };
    const stored = await new Promise((resolve, reject) => repo.findOne(user, { id: base }, null,
      (err, found) => (err != null ? reject(err) : resolve(found))));
    const seeded = { ...stored, permissions: legacy };
    require('business').integrity.accesses.set(seeded);
    await new Promise((resolve, reject) => repo.updateOne(user, { id: base },
      { permissions: legacy, ...(seeded.integrity != null ? { integrity: seeded.integrity } : {}) },
      (err) => (err != null ? reject(err) : resolve())));
    require('cache').default.unsetAccessLogic(endUser.attrs.id, { id: base, token: grant.token });

    // Loads as contribute (the last entry): the grant's own token can write.
    const write = await coreRequest.post('/' + username + '/events').set('Authorization', grant.token)
      .send({ streamIds: ['pm5a'], type: 'note/txt', content: 'x' });
    assert.equal(write.status, 201, describeRes(write));

    const second = await consent('p5', [{ streamId: 'pm5b', level: 'read' }]);
    assert.equal(second.acceptRes.status, 200, describeRes(second.acceptRes));
    const after = await getAccess(base);
    assert.deepEqual(userStreams(after.permissions),
      [{ streamId: 'pm5a', level: 'contribute' }, { streamId: 'pm5b', level: 'read' }]);
  });

  it('[PMRG6] a forbidden feature added to the grant after the session exists reaches the refreshed session', async function () {
    const r = await consent('p6', [{ streamId: 'pm6', level: 'read' }]);
    assert.equal(r.acceptRes.status, 200, describeRes(r.acceptRes));
    const grant = await dataGrantOf(r.tokenRes.body.access_token);
    await ownerUpdateGrant(grant, (perms) => perms.concat([{ feature: 'webhooks', setting: 'forbidden' }]));

    const refreshed = await refresh(r.tokenRes.body.refresh_token);
    assert.equal(refreshed.status, 200, describeRes(refreshed));
    const session = await accessInfo(refreshed.body.access_token);
    assert.ok(session.permissions.some((p) => p.feature === 'webhooks' && p.setting === 'forbidden'),
      'the refreshed session carries the grant\'s restriction: ' + JSON.stringify(session.permissions));
    assert.ok(session.permissions.some((p) => p.feature === 'selfRevoke' && p.setting === 'allowed'),
      'the session keeps its selfRevoke override: ' + JSON.stringify(session.permissions));
    assert.deepEqual(userStreams(session.permissions), [{ streamId: 'pm6', level: 'read' }]);
  });
});
