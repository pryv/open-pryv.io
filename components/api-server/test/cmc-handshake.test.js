/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — two-user handshake integration tests.
 *
 * [CMCHS] covers the full cross-user CMC flow against the in-process
 * api-server with a real PostgreSQL (or SQLite) backend:
 *   - request → accept → back-channel handshake (CN12).
 *   - chat round-trip after handshake (CN13).
 *   - accept re-delivery idempotency (CN14).
 *
 * Outbound HTTP from the dispatch loop is intercepted by a fetch shim
 * that translates `https://<username>.pryv.me/*` URLs into the
 * in-process supertest agent. External fetches (data-types flat.json
 * etc.) pass through to the native fetch.
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid. Requires
 * `events.ts` to resolve `globalThis.fetch` lazily (each call), so the
 * shim installed in the `before` hook is picked up by the cmc dispatch
 * middleware even though the middleware was registered earlier.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const supertest = require('supertest');
const C = require('cmc');

// The fetch shim recognises URLs that target the in-process api-server.
// `service.api` may be either path-based (`http://127.0.0.1:3000/{username}/`,
// when override-config.yml is in effect) or subdomain-style
// (`https://{username}.pryv.me/`, from test/service-info.json when the
// boiler test path skips override-config). Match both: exact-host for the
// path-based form, *.pryv.me for the subdomain-style form. The matcher
// returns either null (passthrough) or the supertest `/{username}/<rest>`
// path to use.
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function resolveSupertestPath (u) {
  // Path-based test override-config: host is 127.0.0.1:3000, username
  // already in pathname.
  if (u.host === '127.0.0.1:3000' || u.host === 'localhost:3000') {
    return u.pathname + (u.search || '');
  }
  // Subdomain-style canonical test service-info: host is <user>.pryv.me;
  // synthesize `/<user>` prefix.
  if (u.host.endsWith('.pryv.me')) {
    const subdomain = u.host.slice(0, -('.pryv.me'.length));
    if (subdomain.length > 0 && !subdomain.includes('.')) {
      return '/' + subdomain + u.pathname + (u.search || '');
    }
  }
  return null;
}

/**
 * Build a fetch shim that routes URLs targeting the in-process api-server
 * through the supertest agent. Other URLs (rqlite at :4001,
 * pryv.github.io for data-types) pass through to the original fetch.
 */
function buildFetchShim (originalFetch, app) {
  return async function shim (url, init) {
    let u;
    try { u = new URL(url); } catch (_e) { return originalFetch(url, init); }
    const path = resolveSupertestPath(u);
    if (path == null) return originalFetch(url, init);
    const method = (init && init.method ? init.method : 'GET').toLowerCase();
    const headers = (init && init.headers) || {};

    let req = supertest(app)[method](path);
    for (const [k, v] of Object.entries(headers)) {
      req = req.set(k, v);
    }
    if (u.username && !(headers.authorization || headers.Authorization)) {
      req = req.set('Authorization', decodeURIComponent(u.username));
    }
    if (init && init.body != null) {
      try {
        req = req.send(JSON.parse(init.body));
      } catch (_e) {
        req = req.send(init.body);
      }
    }
    const res = await req;
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      async json () { return res.body; },
      async text () { return typeof res.text === 'string' ? res.text : JSON.stringify(res.body); },
    };
  };
}

async function ensureStream (path, token, params) {
  const res = await coreRequest.post(path).set('Authorization', token).send(params);
  // 201 created, or 400 item-already-exists — both fine.
  if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
    throw new Error('ensureStream(' + params.id + ') failed: ' +
      res.status + ' ' + JSON.stringify(res.body));
  }
}

async function pollInboxFor (path, token, type, predicate) {
  const t0 = Date.now();
  while (Date.now() - t0 < POLL_TIMEOUT_MS) {
    const res = await coreRequest.get(path)
      .set('Authorization', token)
      .query({ streams: [':_cmc:inbox'], types: [type], limit: 20 });
    const events = res.body?.events || [];
    const match = events.find((e) => predicate(e));
    if (match != null) return match;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('poll timeout: ' + type + ' on :_cmc:inbox via ' + path);
}

async function pollStreamFor (path, token, streamId, type, predicate) {
  const t0 = Date.now();
  while (Date.now() - t0 < POLL_TIMEOUT_MS) {
    const res = await coreRequest.get(path)
      .set('Authorization', token)
      .query({ streams: [streamId], types: [type], limit: 50 });
    const events = res.body?.events || [];
    const match = events.find((e) => predicate(e));
    if (match != null) return match;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('poll timeout: ' + type + ' on ' + streamId + ' via ' + path);
}

describe('[CMCHS] cmc two-user handshake (in-process integration)', function () {
  this.timeout(60_000);

  let alice, bob;          // { username, token, streamsPath, eventsPath, accessesPath }
  let originalFetch;
  let fixtures;

  before(async function () {
    await initTests();
    await initCore();

    // Install fetch shim. The events.ts cmc deps wrap `globalThis.fetch`
    // in a per-call closure (so the shim installed after middleware
    // registration is picked up by the dispatch loop).
    originalFetch = globalThis.fetch;
    globalThis.fetch = buildFetchShim(originalFetch, global.app.expressApp);

    fixtures = getNewFixture();
    alice = await makeActor('alice-' + cuid().slice(-8));
    bob = await makeActor('bob-' + cuid().slice(-8));
  });

  after(async function () {
    if (originalFetch != null) globalThis.fetch = originalFetch;
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  async function makeActor (username) {
    const token = cuid();
    const u = await fixtures.user(username);
    await u.access({ token, type: 'personal' });
    await u.session(token);
    const actor = {
      username,
      token,
      streamsPath: '/' + username + '/streams',
      eventsPath: '/' + username + '/events',
      accessesPath: '/' + username + '/accesses',
    };
    // Provision the :_cmc:apps:my-app scope (lazy auto-provision creates
    // :_cmc:* + :_cmc:apps on the FIRST events.create touching CMC; we
    // pre-provision the app-scope so request / accept have a place to
    // land. The trigger sub-stream is created per test below.
    await ensureStream(actor.streamsPath, token,
      { id: ':_cmc:apps:my-app', parentId: ':_cmc:apps', name: 'My App' });
    return actor;
  }

  describe('[CMCHS-OK] full request → accept → back-channel handshake', function () {
    it('[CN12] alice issues request, bob accepts, both inboxes see counterpart\'s message', async function () {
      const triggerStreamId = ':_cmc:apps:my-app:study-1';

      // Alice creates the trigger sub-stream + the request event.
      await ensureStream(alice.streamsPath, alice.token, {
        id: triggerStreamId, parentId: ':_cmc:apps:my-app', name: 'Study 1',
      });

      const reqRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [triggerStreamId],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            request: {
              title: { en: 'CN12 study' },
              description: { en: 'Two-user handshake integration test' },
              consent: { en: 'I consent.' },
              permissions: [{ streamId: 'fertility', level: 'read' }],
            },
            requesterMeta: { username: alice.username, appId: 'my-app' },
          },
        });
      assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
      const capabilityUrl = reqRes.body?.event?.content?.capabilityUrl;
      assert.ok(typeof capabilityUrl === 'string' && capabilityUrl.length > 0,
        'capabilityUrl should be stamped synchronously: ' + JSON.stringify(reqRes.body?.event?.content));

      // Bob accepts via capabilityUrl. Accept's dispatch is fire-and-forget;
      // we poll alice's inbox for the resulting consent/accept-cmc.
      await ensureStream(bob.streamsPath, bob.token, {
        id: ':_cmc:apps:my-app', parentId: ':_cmc:apps', name: 'My App',
      });
      const accRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/accept-cmc',
          content: { capabilityUrl, accessName: 'cmc-grant-cn12-' + Date.now() },
        });
      assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));

      const inboxAccept = await pollInboxFor(
        alice.eventsPath, alice.token, 'consent/accept-cmc',
        (e) => e.content?.from?.username === bob.username
      );
      const dataGrant = inboxAccept.content?.grantedAccess;
      assert.ok(dataGrant?.apiEndpoint?.match(/^https?:\/\//),
        'inbox accept must carry grantedAccess.apiEndpoint, got: ' + JSON.stringify(inboxAccept.content));

      // Back-channel handshake: alice fans out a consent/back-channel-cmc
      // to bob's inbox carrying alice's back-channel apiEndpoint +
      // remote stream-ids (so bob's data-grant can be updated to know
      // where to POST back to alice).
      const inboxBackChannel = await pollInboxFor(
        bob.eventsPath, bob.token, 'consent/back-channel-cmc',
        (e) => e.content?.from?.username === alice.username
      );
      assert.ok(inboxBackChannel.content?.apiEndpoint?.match(/^https?:\/\//),
        'bob\'s back-channel inbox event must carry alice\'s back-channel apiEndpoint, got: ' +
        JSON.stringify(inboxBackChannel.content));
      assert.ok(typeof inboxBackChannel.content?.remoteChatStreamId === 'string',
        'back-channel must carry remoteChatStreamId');
      assert.ok(typeof inboxBackChannel.content?.remoteCollectorStreamId === 'string',
        'back-channel must carry remoteCollectorStreamId');
    });
  });

  describe('[CMCHS-CHAT] chat round-trip after handshake', function () {
    let aliceChatStreamId, bobChatStreamId;

    before(async function () {
      // CN12 already ran handshake; the per-peer chats streams should
      // exist (auto-provisioned by handleAccept / handleIncomingAccept's
      // anchorStreams). Both sides anchor under the REQUESTER'S per-request
      // scope (`:_cmc:apps:my-app:study-1`) — see pickScopeFromOfferOrTrigger
      // in handleAccept.ts: bob's anchor reads `offer.content.originStreamId`
      // (stamped by capability mint to alice's trigger stream) rather than
      // falling back to bob's bare app-scope.
      // With override-config skipped, test/service-info.json wins:
      //   service.api: 'https://{username}.pryv.me/'
      // cmcSelfIdentityFor substitutes 'x' for {username} → host 'x.pryv.me'
      // for ALL users (same canonical host on both sides, as it should be).
      const TEST_HOST = 'x.pryv.me';
      const aliceSlug = C.slug.counterpartySlug({ username: alice.username, host: TEST_HOST });
      const bobSlug = C.slug.counterpartySlug({ username: bob.username, host: TEST_HOST });
      const sharedScope = ':_cmc:apps:my-app:study-1';
      aliceChatStreamId = sharedScope + ':chats:' + bobSlug;
      bobChatStreamId = sharedScope + ':chats:' + aliceSlug;
    });

    it('[CN13] alice posts chat → bob receives it on his chats stream', async function () {
      const text = 'hello from alice ' + Date.now();
      const chatRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [aliceChatStreamId],
          type: 'message/chat-cmc',
          content: { content: text },
        });
      assert.strictEqual(chatRes.status, 201, JSON.stringify(chatRes.body));

      const received = await pollStreamFor(
        bob.eventsPath, bob.token, bobChatStreamId, 'message/chat-cmc',
        (e) => e.content?.content === text
      );
      assert.equal(received.content.from?.username, alice.username,
        'received message must carry alice as origin');
    });
  });

  // NOTE: CMCHS-IDEMP (CN14) is defined LAST in this file so it doesn't
  // pollute the CMCHS-EXT / CMCHS-SU describes' back-channel state. The
  // current handleIncomingBackChannel matcher keys on (peer.username,
  // peer.host, appCode) and overwrites the FIRST counterparty access
  // matching when a second back-channel arrives — fine for the CN14
  // idempotency test, but leaves earlier handshakes' remote-stream
  // pointers stale, which would break CN15-CN17 / CN18.

  // --- Extended in-process scenarios (ported from _plans/68/tests/) ---
  //
  // The CN12-CN14 block above covers the canonical handshake:
  //   request → accept → back-channel + chat (one-way) + accept re-delivery.
  // The extended block below covers the bidirectional / post-acceptance
  // flows the deployed-infra scripts used to validate, but which can be
  // exercised in-process via the same fetch shim. The KEEP-as-deployed
  // scenarios (02 cross-cores, 03 cross-infra) remain in _plans/68/tests/.
  //
  // These tests establish their OWN fresh handshake (study-ext / study-su)
  // rather than re-use CN12's. The current back-channel matcher
  // (handleIncomingBackChannel) keys on (peer.username, peer.host,
  // appCode) only, so a second handshake with the same peer overwrites
  // the first's back-channel info — fine for the CN14 re-delivery test
  // but it leaves earlier study's remote-stream pointers stale. Fresh
  // handshakes per describe keep each scenario hermetic.

  /**
   * Run a fresh request → accept handshake for a given study-id, return
   * the per-peer chat / collector stream-ids on both sides.
   *
   * This mirrors what CN12 does, factored out so the extended /
   * scope-update describes can each get their own clean access pair.
   */
  async function runFreshHandshake (studyId) {
    const triggerStreamId = ':_cmc:apps:my-app:' + studyId;
    await ensureStream(alice.streamsPath, alice.token, {
      id: triggerStreamId, parentId: ':_cmc:apps:my-app', name: studyId,
    });
    const reqRes = await coreRequest.post(alice.eventsPath)
      .set('Authorization', alice.token)
      .send({
        streamIds: [triggerStreamId],
        type: 'consent/request-cmc',
        content: {
          to: null,
          capabilityRequested: true,
          request: {
            title: { en: studyId },
            description: { en: 'fresh handshake for in-process test' },
            consent: { en: 'I consent.' },
            permissions: [{ streamId: 'fertility', level: 'read' }],
          },
          requesterMeta: { username: alice.username, appId: 'my-app' },
        },
      });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const capabilityUrl = reqRes.body?.event?.content?.capabilityUrl;
    assert.ok(typeof capabilityUrl === 'string' && capabilityUrl.length > 0);

    await ensureStream(bob.streamsPath, bob.token, {
      id: ':_cmc:apps:my-app', parentId: ':_cmc:apps', name: 'My App',
    });
    const accRes = await coreRequest.post(bob.eventsPath)
      .set('Authorization', bob.token)
      .send({
        streamIds: [':_cmc:apps:my-app'],
        type: 'consent/accept-cmc',
        content: { capabilityUrl, accessName: 'cmc-grant-' + studyId + '-' + Date.now() },
      });
    assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));

    // Wait until the back-channel-cmc landed on bob's inbox — that's
    // the marker that bob's data-grant has been updated with alice's
    // remote streams for THIS study.
    await pollInboxFor(
      bob.eventsPath, bob.token, 'consent/back-channel-cmc',
      (e) => e.content?.from?.username === alice.username &&
             e.content?.remoteChatStreamId === triggerStreamId + ':chats:' +
               C.slug.counterpartySlug({ username: bob.username, host: 'x.pryv.me' })
    );

    const TEST_HOST = 'x.pryv.me';
    const aliceSlug = C.slug.counterpartySlug({ username: alice.username, host: TEST_HOST });
    const bobSlug = C.slug.counterpartySlug({ username: bob.username, host: TEST_HOST });
    return {
      triggerStreamId,
      aliceChatStreamId: C.chatStreamUnder(triggerStreamId, bobSlug),
      bobChatStreamId: C.chatStreamUnder(triggerStreamId, aliceSlug),
      aliceCollectorStreamId: C.collectorStreamUnder(triggerStreamId, bobSlug),
      bobCollectorStreamId: C.collectorStreamUnder(triggerStreamId, aliceSlug),
    };
  }

  describe('[CMCHS-EXT] bidirectional messaging post-handshake', function () {
    let h; // handshake handles

    before(async function () {
      h = await runFreshHandshake('study-ext');
    });

    it('[CN15] bob posts chat → alice receives it on her chats stream (return direction)', async function () {
      const text = 'hi back from bob ' + Date.now();
      const chatRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobChatStreamId],
          type: 'message/chat-cmc',
          content: { content: text },
        });
      assert.strictEqual(chatRes.status, 201, JSON.stringify(chatRes.body));

      const received = await pollStreamFor(
        alice.eventsPath, alice.token, h.aliceChatStreamId, 'message/chat-cmc',
        (e) => e.content?.content === text
      );
      assert.equal(received.content.from?.username, bob.username,
        'received message must carry bob as origin');
    });

    it('[CN16] alice posts system alert → bob receives it on his collectors stream', async function () {
      const code = 'ext-alert-' + Date.now();
      const alertRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [h.aliceCollectorStreamId],
          type: 'notification/alert-cmc',
          content: {
            code,
            level: 'info',
            title: { en: 'CN16 alert A→B' },
            body: { en: 'extended messaging integration test' },
          },
        });
      assert.strictEqual(alertRes.status, 201, JSON.stringify(alertRes.body));

      const received = await pollStreamFor(
        bob.eventsPath, bob.token, h.bobCollectorStreamId, 'notification/alert-cmc',
        (e) => e.content?.code === code
      );
      assert.equal(received.content.from?.username, alice.username,
        'received alert must carry alice as origin');
    });

    it('[CN17] bob posts system alert → alice receives it on her collectors stream (return direction)', async function () {
      const code = 'ext-alert-back-' + Date.now();
      const alertRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobCollectorStreamId],
          type: 'notification/alert-cmc',
          content: {
            code,
            level: 'info',
            title: { en: 'CN17 alert B→A' },
            body: { en: 'extended messaging return direction' },
          },
        });
      assert.strictEqual(alertRes.status, 201, JSON.stringify(alertRes.body));

      const received = await pollStreamFor(
        alice.eventsPath, alice.token, h.aliceCollectorStreamId, 'notification/alert-cmc',
        (e) => e.content?.code === code
      );
      assert.equal(received.content.from?.username, bob.username,
        'received alert must carry bob as origin');
    });
  });

  describe('[CMCHS-SU] scope-update local-apply + peer notify', function () {
    // Unit-level coverage: handleSystemScopeUpdate has [HS22]-[HS28b]
    // unit tests; accessesUpdateHook has [AU01]-[AU10]. The integration
    // test here fires the actual events.create → dispatch loop end-to-end
    // through the api-server + plugin to catch wiring regressions (e.g.
    // dispatch switch missing the type, or the local-apply suppression
    // failing to mute the post-hook).
    //
    // We establish a FRESH handshake (study-su) so bob's data-grant has
    // a known starting state — `fertility:read` only.

    let h;
    let bobDataGrantId; // bob's counterparty access pointing to alice

    /**
     * Find on `actor`'s mall the access whose clientData.cmc identifies
     * `peerUsername` as the counterparty AND whose stored remoteChat
     * stream-id sits under `expectedScope`. Disambiguates between
     * multiple counterparty accesses to the same peer.
     */
    async function findCounterpartyAccessForScope (actor, peerUsername, expectedScope) {
      const res = await coreRequest.get(actor.accessesPath)
        .set('Authorization', actor.token);
      const accesses = res.body?.accesses || [];
      return accesses.find((a) => {
        const cmc = a?.clientData?.cmc;
        if (cmc?.role !== 'counterparty') return false;
        if (cmc?.counterparty?.username !== peerUsername) return false;
        const rcs = cmc?.counterparty?.remoteChatStreamId;
        return typeof rcs === 'string' && rcs.startsWith(expectedScope + ':chats:');
      });
    }

    before(async function () {
      h = await runFreshHandshake('study-su');
      const dg = await findCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);
      assert.ok(dg != null,
        'expected bob to have a counterparty access whose back-channel points to ' + h.triggerStreamId);
      bobDataGrantId = dg.id;
    });

    it('[CN18] accepter (bob) widens grant → local access updated + requester (alice) notified', async function () {
      // Look up the access fresh so we have the latest permissions list
      // (the auto-merge in handleSystemScopeUpdate uses it as the base
      // for re-attaching CMC machinery).
      const dgRes = await coreRequest.get(bob.accessesPath)
        .set('Authorization', bob.token);
      const dataGrantBefore = (dgRes.body?.accesses || []).find((a) => a.id === bobDataGrantId);
      assert.ok(dataGrantBefore != null);
      const beforeStreamIds = new Set(
        (dataGrantBefore.permissions || []).map((p) => p.streamId));
      assert.ok(beforeStreamIds.has('fertility'),
        'baseline data-grant should permit fertility (from study-su request)');
      assert.ok(!beforeStreamIds.has('steps'),
        'baseline data-grant must NOT yet permit steps');

      const newPermissions = [
        { streamId: 'fertility', level: 'read' },
        { streamId: 'steps', level: 'read' },
      ];

      const triggerRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobCollectorStreamId],
          type: 'consent/scope-update-cmc',
          content: {
            accessId: bobDataGrantId,
            newPermissions,
            previousPermissions: dataGrantBefore.permissions,
          },
        });
      assert.strictEqual(triggerRes.status, 201, JSON.stringify(triggerRes.body));

      // 1. Local data-grant permissions should reflect the update.
      //    handleSystemScopeUpdate auto-merges the :_cmc:* machinery
      //    permissions back in (HS28a/b).
      const t0 = Date.now();
      let dataGrantAfter = null;
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        const r = await coreRequest.get(bob.accessesPath)
          .set('Authorization', bob.token);
        dataGrantAfter = (r.body?.accesses || []).find((a) => a.id === bobDataGrantId);
        const ids = new Set((dataGrantAfter?.permissions || []).map((p) => p.streamId));
        if (ids.has('steps')) break;
        await sleep(POLL_INTERVAL_MS);
      }
      const afterStreamIds = new Set(
        (dataGrantAfter?.permissions || []).map((p) => p.streamId));
      assert.ok(afterStreamIds.has('steps'),
        'data-grant permissions should now include steps:read — got ' +
        JSON.stringify(dataGrantAfter?.permissions));
      assert.ok(afterStreamIds.has('fertility'),
        'data-grant must still grant fertility:read after widening');

      // 2. Alice should receive a consent/scope-update-cmc notification on
      //    her collectors stream (handleSystemScopeUpdate routes through
      //    handleSystemEvent which POSTs to the peer's collectors stream).
      const peerNotif = await pollStreamFor(
        alice.eventsPath, alice.token, h.aliceCollectorStreamId,
        'consent/scope-update-cmc',
        (e) => Array.isArray(e.content?.newPermissions) &&
               e.content.newPermissions.some((p) => p.streamId === 'steps')
      );
      assert.ok(peerNotif?.id != null,
        'alice must receive consent/scope-update-cmc carrying the new permissions');
    });
  });

  describe('[CMCHS-IDEMP] accept re-delivery idempotency', function () {
    // Defined LAST: this test triggers a second back-channel-cmc to bob
    // from a different scope, which (per the current matcher) overwrites
    // an existing data-grant's remote-stream pointers. Earlier describes
    // (CMCHS-EXT / CMCHS-SU) need a clean back-channel, so they go first.
    it('[CN14] second accept from the same peer for a different scope does not collide on back-channel access name', async function () {
      const triggerStreamId = ':_cmc:apps:my-app:study-2';
      await ensureStream(alice.streamsPath, alice.token, {
        id: triggerStreamId, parentId: ':_cmc:apps:my-app', name: 'Study 2',
      });

      const reqRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [triggerStreamId],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            request: {
              title: { en: 'CN14 second study' },
              description: { en: 'Second handshake from the same peer' },
              consent: { en: 'I consent.' },
              permissions: [{ streamId: 'fertility', level: 'read' }],
            },
            requesterMeta: { username: alice.username, appId: 'my-app' },
          },
        });
      assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
      const capabilityUrl = reqRes.body?.event?.content?.capabilityUrl;

      const accRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/accept-cmc',
          content: { capabilityUrl, accessName: 'cmc-grant-cn14-' + Date.now() },
        });
      assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));

      // We expect a SECOND consent/accept-cmc to land on alice's inbox.
      // The bug-#12 regression would have shown up as the dispatch loop
      // failing with `duplicate key violates unique constraint`; the
      // bug-#13 regression would have shown the trigger event flipped
      // to status='failed' without delivery. Either would prevent this
      // poll from succeeding.
      const accepts = [];
      const t0 = Date.now();
      while (Date.now() - t0 < POLL_TIMEOUT_MS && accepts.length < 2) {
        const res = await coreRequest.get(alice.eventsPath)
          .set('Authorization', alice.token)
          .query({ streams: [':_cmc:inbox'], types: ['consent/accept-cmc'], limit: 20 });
        const events = res.body?.events || [];
        accepts.length = 0;
        for (const e of events) {
          if (e.content?.from?.username === bob.username) accepts.push(e);
        }
        if (accepts.length < 2) await sleep(POLL_INTERVAL_MS);
      }
      assert.ok(accepts.length >= 2,
        're-delivery should land a second consent/accept-cmc; got ' + accepts.length);
    });
  });
});
