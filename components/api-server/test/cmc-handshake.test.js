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

const C = require('cmc');
// Shared in-process fetch shim (also used by the OAuth2 e2e suite).
const { buildFetchShim } = require('./cmc-fetch-shim.cjs');

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function ensureStream (path, token, params) {
  const res = await coreRequest.post(path).set('Authorization', token).send(params);
  // 201 created, or 400 item-already-exists — both fine.
  if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
    throw new Error('ensureStream(' + params.id + ') failed: ' +
      res.status + ' ' + JSON.stringify(res.body));
  }
}

async function pollInboxFor (path, token, type, predicate, timeoutMs = POLL_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
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

  // --- Extended in-process scenarios ---
  //
  // The CN12-CN14 block above covers the canonical handshake:
  //   request → accept → back-channel + chat (one-way) + accept re-delivery.
  // The extended block below covers the bidirectional / post-acceptance
  // flows, exercised in-process via the same fetch shim. Deployed-infra
  // scenarios (cross-cores, cross-infra) are exercised by separate
  // deployment tests.
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
   *
   * `appId` (default 'my-app') selects the app scope. The revocation
   * describes pass a dedicated app-code per test: the back-channel
   * matcher keys on (peer.username, peer.host, appCode) and picks the
   * FIRST matching access, so only a unique app-code guarantees the
   * fresh data-grant (not an earlier study's) receives the back-channel
   * pointers the revoke delivery relies on.
   */
  async function runFreshHandshake (studyId, appId = 'my-app') {
    const appRootStreamId = ':_cmc:apps:' + appId;
    const triggerStreamId = appRootStreamId + ':' + studyId;
    await ensureStream(alice.streamsPath, alice.token, {
      id: appRootStreamId, parentId: ':_cmc:apps', name: appId,
    });
    await ensureStream(alice.streamsPath, alice.token, {
      id: triggerStreamId, parentId: appRootStreamId, name: studyId,
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
          requesterMeta: { username: alice.username, appId },
        },
      });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const capabilityUrl = reqRes.body?.event?.content?.capabilityUrl;
    assert.ok(typeof capabilityUrl === 'string' && capabilityUrl.length > 0);

    await ensureStream(bob.streamsPath, bob.token, {
      id: appRootStreamId, parentId: ':_cmc:apps', name: appId,
    });
    const accRes = await coreRequest.post(bob.eventsPath)
      .set('Authorization', bob.token)
      .send({
        streamIds: [appRootStreamId],
        type: 'consent/accept-cmc',
        content: { capabilityUrl, accessName: 'cmc-grant-' + studyId + '-' + Date.now() },
      });
    assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));

    // Wait until the back-channel-cmc landed on bob's inbox — that's
    // the marker that bob's data-grant has been updated with alice's
    // remote streams for THIS study. Double deadline: this marker is
    // three chained async hops behind the accept (accept dispatch →
    // incoming-accept on alice → back-channel POST to bob), and on
    // loaded full-matrix runs the default 10 s has been seen to lapse
    // while the chain was still healthy.
    await pollInboxFor(
      bob.eventsPath, bob.token, 'consent/back-channel-cmc',
      (e) => e.content?.from?.username === alice.username &&
             e.content?.remoteChatStreamId === triggerStreamId + ':chats:' +
               C.slug.counterpartySlug({ username: bob.username, host: 'x.pryv.me' }),
      POLL_TIMEOUT_MS * 2
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

  /**
   * Poll `actor`'s accesses until one matches: clientData.cmc identifies
   * `peerUsername` as the counterparty AND its stored remoteChat
   * stream-id sits under `expectedScope`. Disambiguates between
   * multiple counterparty accesses to the same peer.
   *
   * `runFreshHandshake` returns when the back-channel-cmc EVENT lands
   * on bob's inbox, but bob's counterparty access is updated via a
   * separate async path (cmc post-hook + pubsub). On heavily loaded
   * runs (`just test all` matrix) that update can land a few hundred
   * ms after the inbox event. Polling here aligns the two paths.
   * (Shared by the scope-update + revocation describes.)
   */
  async function pollCounterpartyAccessForScope (actor, peerUsername, expectedScope) {
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_TIMEOUT_MS) {
      const res = await coreRequest.get(actor.accessesPath)
        .set('Authorization', actor.token);
      const accesses = res.body?.accesses || [];
      const match = accesses.find((a) => {
        const cmc = a?.clientData?.cmc;
        if (cmc?.role !== 'counterparty') return false;
        if (cmc?.counterparty?.username !== peerUsername) return false;
        const rcs = cmc?.counterparty?.remoteChatStreamId;
        return typeof rcs === 'string' && rcs.startsWith(expectedScope + ':chats:');
      });
      if (match != null) return match;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('poll timeout: counterparty access with back-channel under ' + expectedScope + ' for peer ' + peerUsername);
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

    before(async function () {
      h = await runFreshHandshake('study-su');
      const dg = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);
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

    before(async function () {
      // Full-matrix runs have intermittently seen `404 !== 201` in [CN14]
      // — an actor fixture going missing/stale deep in a matrix, not
      // idempotency logic. Fail legibly here instead of cryptically below.
      for (const actor of [alice, bob]) {
        const res = await coreRequest
          .get('/' + actor.username + '/access-info')
          .set('Authorization', actor.token);
        assert.strictEqual(res.status, 200,
          'fixture user/session "' + actor.username + '" is missing or stale entering [CMCHS-IDEMP]: ' +
          res.status + ' ' + JSON.stringify(res.body));
      }
    });
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

  describe('[CMCHS-COLL] accept reusing an already-taken accessName', function () {
    // A client app typically passes its own fixed app name as accessName
    // on every accept. Accesses are unique on (name, type, deviceName),
    // so the second accept's data-grant used to fail permanently on the
    // uniqueness constraint (raw duplicate-key surfaced, retries burned).
    // The handler now uniquifies with a deterministic per-accept suffix.
    it('[CN19] second accept with the same accessName mints a suffixed data-grant instead of failing', async function () {
      const FIXED_NAME = 'my-fixed-app-name';
      const acceptEventIds = [];

      async function requestAndAccept (studyId) {
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
                description: { en: 'accessName-collision repro' },
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
            content: { capabilityUrl, accessName: FIXED_NAME },
          });
        assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));
        return accRes.body.event.id;
      }

      async function grantsFor (ids) {
        const res = await coreRequest.get(bob.accessesPath)
          .set('Authorization', bob.token);
        return (res.body?.accesses || [])
          .filter((a) => ids.includes(a.clientData?.cmc?.acceptEventId));
      }

      async function pollGrants (ids, count) {
        const t0 = Date.now();
        let grants = await grantsFor(ids);
        while (Date.now() - t0 < POLL_TIMEOUT_MS && grants.length < count) {
          await sleep(POLL_INTERVAL_MS);
          grants = await grantsFor(ids);
        }
        return grants;
      }

      // Round 1 — plain name. Await its data-grant so round 2
      // deterministically hits the collision.
      acceptEventIds.push(await requestAndAccept('coll-study-1'));
      let grants = await pollGrants(acceptEventIds, 1);
      assert.strictEqual(grants.length, 1, 'first accept must mint its data-grant');
      assert.strictEqual(grants[0].name, FIXED_NAME);

      // Round 2 — same accessName.
      acceptEventIds.push(await requestAndAccept('coll-study-2'));
      grants = await pollGrants(acceptEventIds, 2);
      assert.strictEqual(grants.length, 2,
        'second accept must mint a data-grant despite the name collision; got ' +
        JSON.stringify(grants.map((g) => g.name)));
      const secondGrant = grants.find((g) => g.clientData?.cmc?.acceptEventId === acceptEventIds[1]);
      assert.strictEqual(secondGrant.name,
        FIXED_NAME + ' (' + acceptEventIds[1].slice(-8) + ')');

      // Neither trigger event may end up failed.
      for (const id of acceptEventIds) {
        const evRes = await coreRequest.get(bob.eventsPath + '/' + id)
          .set('Authorization', bob.token);
        assert.notStrictEqual(evRes.body?.event?.content?.status, 'failed',
          JSON.stringify(evRes.body?.event?.content));
      }
    });
  });

  // Defined LAST so the extra alice accesses created below do not interfere
  // with the back-channel state CN12-CN17 / CN18 rely on. The CMCHS-IDEMP /
  // CMCHS-EXT / CMCHS-SU describes share the alice/bob actors and key
  // counterparty-access lookups on (username, host, appCode) — extra
  // alice-side accesses granting :_cmc:* perms confuse those lookups under
  // the current handleIncomingBackChannel matcher.
  describe('[CMCHS-AP] accesses.create accepts :_cmc:* permissions', function () {
    // Regression for B-2026-05-21-4: `accesses.create` with a permission
    // referencing a `:`-prefixed CMC stream-id (e.g. `:_cmc:apps:<app>`,
    // `:_cmc:inbox`) used to hit the local-store streamId regex in
    // ensureStream() and fail with invalid-request-structure
    // ("forbidden character(s) in streamId ...") at access-create time —
    // blocking new-doctor onboarding via app-web-auth-3 and bridge flows.
    // The fix in createDataStructureFromPermissions skips the auto-create
    // step for `:_cmc:*` stream-ids (the CMC plugin owns provisioning).
    it('[AP01] creates an app access whose permissions reference :_cmc:* stream-ids', async function () {
      const res = await coreRequest.post(alice.accessesPath)
        .set('Authorization', alice.token)
        .send({
          name: 'cmc-perms-ap01-' + Date.now(),
          type: 'app',
          permissions: [
            { defaultName: 'My App scope', level: 'manage', streamId: ':_cmc:apps:my-app' },
            { defaultName: 'CMC inbox', level: 'manage', streamId: ':_cmc:inbox' },
          ],
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.ok(res.body?.access?.token, 'created access must carry a token');
      const grantedStreamIds = (res.body.access.permissions || []).map((p) => p.streamId);
      assert.ok(grantedStreamIds.includes(':_cmc:apps:my-app'));
      assert.ok(grantedStreamIds.includes(':_cmc:inbox'));
    });

    it('[AP02] creates an access mixing local + :_cmc:* perms in one call', async function () {
      // Mirrors the doctor-dashboard / app-web-auth-3 onboarding payload
      // captured in B-2026-05-21-4: a real app permission alongside two
      // CMC ones in a single accesses.create.
      const localStreamId = 'app-ap02-' + cuid().slice(-8);
      await ensureStream(alice.streamsPath, alice.token,
        { id: localStreamId, parentId: null, name: 'App AP02' });
      const res = await coreRequest.post(alice.accessesPath)
        .set('Authorization', alice.token)
        .send({
          name: 'cmc-perms-ap02-' + Date.now(),
          type: 'app',
          permissions: [
            { defaultName: 'App scope', level: 'manage', streamId: localStreamId },
            { defaultName: 'Collector scope', level: 'manage', streamId: ':_cmc:apps:my-app' },
            { defaultName: 'Inbox', level: 'manage', streamId: ':_cmc:inbox' },
          ],
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });

    it('[AP03] still rejects truly invalid local stream-ids (regex un-touched for non-CMC)', async function () {
      // Pin that the fix narrowly skips only the `:_cmc:*` namespace.
      // A bare local stream-id that breaks `^[a-z0-9-]{1,100}` (uppercase)
      // must still be rejected with the same invalid-request-structure
      // error and the (now fixed) "forbidden character(s)" message.
      const res = await coreRequest.post(alice.accessesPath)
        .set('Authorization', alice.token)
        .send({
          name: 'cmc-perms-ap03-' + Date.now(),
          type: 'app',
          permissions: [
            { defaultName: 'Bad scope', level: 'manage', streamId: 'BadStreamId' },
          ],
        });
      assert.ok(res.status >= 400 && res.status < 500,
        'should reject; got status ' + res.status + ' body ' + JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'invalid-request-structure');
      assert.ok(/forbidden character/.test(res.body?.error?.message || ''),
        'error should cite forbidden character, got: ' + res.body?.error?.message);
    });
  });

  describe('[CMCHS-AP-PER-APP] accesses.{create,update} auto-provision per-app appScope roots', function () {
    // Plan-driven: HDS handoff 2026-05-26 (B-2026-05-26-1). The 5 reserved
    // parents under :_cmc:* are pre-provisioned at user creation
    // (provisioning.ts). Per-app sub-trees under :_cmc:apps:<app-code>
    // were historically created on-demand at CMC-acceptance time — but
    // the OAuth-grant flow (doctor-dashboard via app-web-auth-3) never
    // reaches an acceptance event before the first invite, so the
    // per-app *root* :_cmc:apps:<app-code> was missing when downstream
    // streams.create for a child of it ran, returning
    // unknown-referenced-resource ("Unknown referenced unknown Stream").
    //
    // The fix: a new hook (createAccessProvisionAppScopeHook) runs after
    // createAccess / snapshotAndApplyUpdate, scans the post-state perms
    // for any streamId resolving to a valid app-code via getAppCode(),
    // and lazy-creates :_cmc:apps:<app-code> as a child of :_cmc:apps
    // via mall.streams.create.
    //
    // Verification pattern: re-attempt creating the leaf via the user's
    // personal token after accesses.create / accesses.update — if the
    // hook fired, the second create returns item-already-exists (the
    // intended outcome); if it didn't, the create succeeds 201 (test
    // fails — hook regressed).

    it('[PA01] accesses.create with :_cmc:apps:<new-app> perm auto-provisions the leaf', async function () {
      const appCode = 'pa01-' + cuid().slice(-6);
      const leafStreamId = ':_cmc:apps:' + appCode;

      const res = await coreRequest.post(alice.accessesPath)
        .set('Authorization', alice.token)
        .send({
          name: 'cmc-perms-pa01-' + Date.now(),
          type: 'app',
          permissions: [
            { defaultName: 'App scope', level: 'manage', streamId: leafStreamId },
          ],
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));

      // Re-attempt the leaf create — must collide with the
      // auto-provisioned stream.
      const verify = await coreRequest.post(alice.streamsPath)
        .set('Authorization', alice.token)
        .send({ id: leafStreamId, parentId: ':_cmc:apps', name: appCode });
      assert.strictEqual(verify.body?.error?.id, 'item-already-exists',
        'leaf should already exist after accesses.create; got ' + JSON.stringify(verify.body));
    });

    it('[PA02] accesses.create with an already-existing leaf perm succeeds (idempotent)', async function () {
      // :_cmc:apps:my-app was pre-provisioned by makeActor.
      const res = await coreRequest.post(alice.accessesPath)
        .set('Authorization', alice.token)
        .send({
          name: 'cmc-perms-pa02-' + Date.now(),
          type: 'app',
          permissions: [
            { defaultName: 'App scope', level: 'manage', streamId: ':_cmc:apps:my-app' },
          ],
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });

    it('[PA03] accesses.update that ADDS a per-app perm provisions the new leaf', async function () {
      // Start with an access that has no per-app perm.
      const createRes = await coreRequest.post(alice.accessesPath)
        .set('Authorization', alice.token)
        .send({
          name: 'cmc-perms-pa03-' + Date.now(),
          type: 'app',
          permissions: [
            { defaultName: 'Inbox', level: 'manage', streamId: ':_cmc:inbox' },
          ],
        });
      assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));
      const accessId = createRes.body.access.id;

      const appCode = 'pa03-' + cuid().slice(-6);
      const leafStreamId = ':_cmc:apps:' + appCode;

      // Update to add the per-app perm. Route auto-wraps body into {update}.
      // accesses.update now accepts the same `defaultName`/`name` extras as
      // accesses.create (B-2026-05-14-4 symmetry fix); kept bare here so the
      // test exercises the minimal canonical shape.
      const updateRes = await coreRequest.put(alice.accessesPath + '/' + accessId)
        .set('Authorization', alice.token)
        .send({
          permissions: [
            { level: 'manage', streamId: ':_cmc:inbox' },
            { level: 'manage', streamId: leafStreamId },
          ],
        });
      assert.strictEqual(updateRes.status, 200, JSON.stringify(updateRes.body));

      // Verify the new leaf exists.
      const verify = await coreRequest.post(alice.streamsPath)
        .set('Authorization', alice.token)
        .send({ id: leafStreamId, parentId: ':_cmc:apps', name: appCode });
      assert.strictEqual(verify.body?.error?.id, 'item-already-exists',
        'leaf should exist after accesses.update; got ' + JSON.stringify(verify.body));
    });

    it('[PA04] accesses.create with deep :_cmc:apps:<app>:chats:* perm also provisions the leaf', async function () {
      // OAuth-grant flow typically asks for the leaf, but deep perms
      // must work too — the leaf is required for any descendant create.
      const appCode = 'pa04-' + cuid().slice(-6);
      const leafStreamId = ':_cmc:apps:' + appCode;
      const deepStreamId = leafStreamId + ':chats:peer--example-com';

      const res = await coreRequest.post(alice.accessesPath)
        .set('Authorization', alice.token)
        .send({
          name: 'cmc-perms-pa04-' + Date.now(),
          type: 'app',
          permissions: [
            { defaultName: 'Chats', level: 'manage', streamId: deepStreamId },
          ],
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));

      const verify = await coreRequest.post(alice.streamsPath)
        .set('Authorization', alice.token)
        .send({ id: leafStreamId, parentId: ':_cmc:apps', name: appCode });
      assert.strictEqual(verify.body?.error?.id, 'item-already-exists',
        'leaf should exist even for deep-path perm; got ' + JSON.stringify(verify.body));
    });
  });

  describe('[CMCHS-UP] raw accesses.update forwarded to the counterparty', function () {
    // A scope edit performed with plain accesses.update (no CMC trigger
    // event) must reach the peer's COLLECTORS stream via the route-level
    // post-hook — system-family types are rejected on the peer's inbox,
    // which is exactly the regression this test pins.

    it('[CN23] bob edits his data-grant via accesses.update → alice receives consent/scope-update-cmc on her collectors stream', async function () {
      const h = await runFreshHandshake('study-upd', 'upd-app');
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);

      // A fresh stream to widen the grant onto.
      await ensureStream(bob.streamsPath, bob.token, { id: 'updextra', name: 'Upd Extra' });
      const newPermissions = (dataGrant.permissions || []).concat([{ streamId: 'updextra', level: 'read' }]);

      const updRes = await coreRequest.put(bob.accessesPath + '/' + dataGrant.id)
        .set('Authorization', bob.token)
        .send({ permissions: newPermissions });
      assert.strictEqual(updRes.status, 200, JSON.stringify(updRes.body));

      const peerNotif = await pollStreamFor(
        alice.eventsPath, alice.token, h.aliceCollectorStreamId,
        'consent/scope-update-cmc',
        (e) => e.content?.source === 'post-hook' &&
               Array.isArray(e.content?.newPermissions) &&
               e.content.newPermissions.some((p) => p.streamId === 'updextra')
      );
      assert.equal(peerNotif.content.from?.username, bob.username,
        'delivered scope-update must carry bob as server-stamped origin');
      // Post-update the access id is the composite <base>:<serial> form
      // (access versioning bumps the serial on every update).
      assert.ok(String(peerNotif.content.newAccessId).startsWith(dataGrant.id + ':') ||
                peerNotif.content.newAccessId === dataGrant.id,
        'newAccessId must reference the updated data-grant: ' + peerNotif.content.newAccessId);
    });
  });

  describe('[CMCHS-RV] revocation forwarded to the counterparty', function () {
    // Defined at the very end: these tests DESTROY relationship accesses.
    // Each test runs its own handshake under a DEDICATED app-code (see
    // runFreshHandshake docstring: the back-channel matcher needs a
    // unique (peer, appCode) tuple to deterministically wire the fresh
    // data-grant), so they are hermetic w.r.t. the earlier describes.

    async function pollInboxRevokeFor (actor, fromUsername, accessId) {
      return await pollInboxFor(
        actor.eventsPath, actor.token, 'consent/revoke-cmc',
        (e) => e.content?.from?.username === fromUsername &&
               e.content?.accessId === accessId
      );
    }

    async function countInboxRevokesFor (actor, accessId) {
      const res = await coreRequest.get(actor.eventsPath)
        .set('Authorization', actor.token)
        .query({ streams: [':_cmc:inbox'], types: ['consent/revoke-cmc'], limit: 50 });
      return (res.body?.events || [])
        .filter((e) => e.content?.accessId === accessId).length;
    }

    it('[CN20] helper-driven revoke (consent/revoke-cmc trigger) lands in the requester\'s inbox', async function () {
      const h = await runFreshHandshake('study-rva', 'rev-app-a');
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);

      // Bob (accepter) revokes via the CMC lifecycle event — the helper
      // flow (pryv.cmc.revokeAcceptance writes exactly this trigger).
      const revRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: dataGrant.id, reason: { en: 'CN20 helper revoke' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      // Alice (requester) must observe the revocation in her inbox,
      // carrying the revoked access id.
      const inboxRevoke = await pollInboxRevokeFor(alice, bob.username, dataGrant.id);
      assert.equal(inboxRevoke.content.appCode, 'rev-app-a');

      // And bob's local data-grant must be gone (handleRevoke teardown).
      const t0 = Date.now();
      let stillThere = true;
      while (Date.now() - t0 < POLL_TIMEOUT_MS && stillThere) {
        const r = await coreRequest.get(bob.accessesPath).set('Authorization', bob.token);
        stillThere = (r.body?.accesses || []).some((a) => a.id === dataGrant.id);
        if (stillThere) await sleep(POLL_INTERVAL_MS);
      }
      assert.equal(stillThere, false, 'bob\'s data-grant access must be deleted by the revoke');
    });

    it('[CN21] raw accesses.delete of the data-grant forwards consent/revoke-cmc to the requester', async function () {
      const h = await runFreshHandshake('study-rvb', 'rev-app-b');
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);

      // Bob removes the relationship access from a generic
      // "connected apps"-style path: plain accesses.delete, personal token.
      const delRes = await coreRequest.delete(bob.accessesPath + '/' + dataGrant.id)
        .set('Authorization', bob.token);
      assert.strictEqual(delRes.status, 200, JSON.stringify(delRes.body));
      assert.equal(delRes.body?.accessDeletion?.id, dataGrant.id);

      // The requester must observe the revocation exactly as if it had
      // been issued through the CMC helpers.
      const inboxRevoke = await pollInboxRevokeFor(alice, bob.username, dataGrant.id);
      assert.equal(inboxRevoke.content.appCode, 'rev-app-b');
    });

    it('[CN22] revoke after raw delete is idempotent: no duplicate inbox revoke, delete 404s', async function () {
      const h = await runFreshHandshake('study-rvc', 'rev-app-c');
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);

      // Raw delete first (fires the post-delete forwarding).
      const delRes = await coreRequest.delete(bob.accessesPath + '/' + dataGrant.id)
        .set('Authorization', bob.token);
      assert.strictEqual(delRes.status, 200, JSON.stringify(delRes.body));
      await pollInboxRevokeFor(alice, bob.username, dataGrant.id);

      // A helper revoke for the same (already-deleted) relationship must
      // not produce a second inbox revoke on alice's side — handleRevoke
      // finds no counterparty access and fails the trigger locally.
      const revRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: dataGrant.id, reason: { en: 'CN22 duplicate revoke' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      // A second raw delete of the same access must 404.
      const delAgain = await coreRequest.delete(bob.accessesPath + '/' + dataGrant.id)
        .set('Authorization', bob.token);
      assert.strictEqual(delAgain.status, 404, JSON.stringify(delAgain.body));

      // Give the (fire-and-forget) pipelines time to run, then assert
      // alice still has exactly ONE revoke for this access id.
      await sleep(1500);
      const count = await countInboxRevokesFor(alice, dataGrant.id);
      assert.equal(count, 1, 'alice must see exactly one consent/revoke-cmc for ' + dataGrant.id);
    });
  });
});
