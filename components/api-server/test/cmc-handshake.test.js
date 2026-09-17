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
    globalThis.fetch = buildFetchShim(originalFetch, global.coreServer || global.app.expressApp);

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
  // rather than re-use CN12's, so each scenario stays hermetic and reads
  // independently of what ran before it.
  //
  // (Historically this was not a preference but a requirement: the matcher
  // keyed on (peer.username, peer.host, appCode), so a second handshake with
  // the same peer overwrote the first's back-channel pointers. Relationships
  // are now keyed on their per-request scope — see [CMCHS-DUP].)

  /**
   * Run a fresh request → accept handshake for a given study-id, return
   * the per-peer chat / collector stream-ids on both sides.
   *
   * This mirrors what CN12 does, factored out so the extended /
   * scope-update describes can each get their own clean access pair.
   *
   * `appId` (default 'my-app') selects the app scope. The revocation
   * describes pass a dedicated app-code per test; that used to be load-
   * bearing (the matcher picked the FIRST access matching (peer, appCode),
   * so only a unique app-code guaranteed the fresh data-grant received the
   * back-channel pointers). Relationships are now keyed on their
   * per-request scope, so it is merely tidy isolation.
   */
  async function runFreshHandshake (studyId, appId = 'my-app', opts = {}) {
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
          // Default is single-use; open-link is opt-in (multiple accepts
          // until the requester invalidates the link).
          ...(opts.mode != null ? { capability: { mode: opts.mode } } : {}),
          request: {
            title: { en: studyId },
            description: { en: 'fresh handshake for in-process test' },
            consent: { en: 'I consent.' },
            permissions: [{ streamId: 'fertility', level: 'read' }],
            ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
          },
          requesterMeta: { username: alice.username, appId },
        },
      });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const capabilityUrl = reqRes.body?.event?.content?.capabilityUrl;
    const capabilityId = reqRes.body?.event?.content?.capabilityId;
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
    // remote streams for THIS study.
    //
    // Generous deadline (4x): this marker sits THREE chained
    // fire-and-forget hops behind the accept (accept dispatch on bob →
    // incoming-accept on alice → back-channel POST back to bob), each
    // doing real PG + HTTP work through the in-process shim. On an
    // unloaded box the whole chain lands in well under a second, but
    // under matrix load it has been seen to exceed both 10 s and 20 s
    // while remaining perfectly healthy — a lapse here fails a whole
    // describe's before-all, so the deadline is deliberately far above
    // the observed worst case rather than close to it. It costs nothing
    // when the chain is fast (the poll returns as soon as the marker
    // appears); it only spends time when the box is genuinely slow.
    await pollInboxFor(
      bob.eventsPath, bob.token, 'consent/back-channel-cmc',
      (e) => e.content?.from?.username === alice.username &&
             e.content?.remoteChatStreamId === triggerStreamId + ':chats:' +
               C.slug.counterpartySlug({ username: bob.username, host: 'x.pryv.me' }),
      POLL_TIMEOUT_MS * 4
    );

    const TEST_HOST = 'x.pryv.me';
    const aliceSlug = C.slug.counterpartySlug({ username: alice.username, host: TEST_HOST });
    const bobSlug = C.slug.counterpartySlug({ username: bob.username, host: TEST_HOST });
    return {
      triggerStreamId,
      capabilityUrl,
      capabilityId,
      // The invite trigger itself: what a revoke arrival's `inviteEventId`
      // must match, from the requester's point of view.
      requestEventId: reqRes.body?.event?.id,
      capabilityExpiresAt: reqRes.body?.event?.content?.capabilityExpiresAt,
      aliceChatStreamId: C.chatStreamUnder(triggerStreamId, bobSlug),
      bobChatStreamId: C.chatStreamUnder(triggerStreamId, aliceSlug),
      aliceCollectorStreamId: C.collectorStreamUnder(triggerStreamId, bobSlug),
      bobCollectorStreamId: C.collectorStreamUnder(triggerStreamId, aliceSlug),
    };
  }

  /**
   * Who has joined `owner`'s invite for `capabilityId`: the counterparties of
   * the live relationship accesses carrying that capability id.
   */
  async function liveAccepters (owner, capabilityId) {
    const res = await coreRequest.get(owner.accessesPath).set('Authorization', owner.token);
    return (res.body?.accesses || [])
      .filter((a) => a?.clientData?.cmc?.role === 'counterparty' &&
        a?.clientData?.cmc?.capabilityId === capabilityId)
      .map((a) => ({ ...a.clientData.cmc.counterparty, accessId: a.id, created: a.created }));
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

  describe('[CMCHS-SR] collector scope request answered by the user', function () {
    let h;
    let bobDataGrantId;

    async function pollEvent (actor, eventId, predicate, label) {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        const res = await coreRequest.get(actor.eventsPath + '/' + eventId)
          .set('Authorization', actor.token);
        last = res.body?.event;
        if (last != null && predicate(last)) return last;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error('poll timeout: ' + label + '; last content=' + JSON.stringify(last?.content));
    }

    async function grantStreamIds (actor, accessId) {
      const res = await coreRequest.get(actor.accessesPath).set('Authorization', actor.token);
      const acc = (res.body?.accesses || []).find((a) => a.id === accessId);
      return new Set((acc?.permissions || []).map((p) => p.streamId));
    }

    // Collector side: propose, wait for delivery, return the id the request
    // got on the user's account.
    async function propose (hs, newPermissions) {
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({ streamIds: [hs.aliceCollectorStreamId], type: 'consent/scope-request-cmc', content: { newPermissions } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const done = await pollEvent(alice, res.body.event.id,
        (e) => e.content?.status === 'completed' || e.content?.status === 'failed', 'scope request delivered');
      assert.strictEqual(done.content.status, 'completed', JSON.stringify(done.content));
      assert.ok(typeof done.content.remoteEventId === 'string', 'completed request must carry remoteEventId');
      return done.content.remoteEventId;
    }

    async function answer (streamId, content) {
      const res = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({ streamIds: [streamId], type: 'consent/scope-update-cmc', content });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return pollEvent(bob, res.body.event.id,
        (e) => e.content?.status === 'completed' || e.content?.status === 'failed', 'scope update processed');
    }

    before(async function () {
      h = await runFreshHandshake('study-sr');
      const dg = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);
      bobDataGrantId = dg.id;
    });

    it('[CN40] the collector\'s completed request carries the id it has on the user\'s account, created by the user\'s grant for that collector', async function () {
      const remoteId = await propose(h, [{ streamId: 'fertility', level: 'read' }, { streamId: 'steps', level: 'read' }]);
      const res = await coreRequest.get(bob.eventsPath + '/' + remoteId).set('Authorization', bob.token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const arrived = res.body.event;
      assert.strictEqual(arrived.type, 'consent/scope-request-cmc');
      assert.ok(arrived.streamIds.includes(h.bobCollectorStreamId));
      assert.strictEqual(arrived.createdBy.split(' ')[0], bobDataGrantId);
      assert.strictEqual(arrived.content.from.username, alice.username);
    });

    it('[CN41] accepting applies the request\'s permissions to that grant, completes with applied, and notifies the collector', async function () {
      const remoteId = await propose(h, [{ streamId: 'fertility', level: 'read' }, { streamId: 'steps', level: 'read' }]);
      assert.ok(!(await grantStreamIds(bob, bobDataGrantId)).has('steps'), 'baseline must not grant steps');
      const done = await answer(h.bobCollectorStreamId, { scopeRequestEventId: remoteId, accept: true });
      assert.strictEqual(done.content.status, 'completed', JSON.stringify(done.content));
      assert.strictEqual(done.content.applied, true);
      assert.strictEqual(done.content.accessId, bobDataGrantId);
      const ids = await grantStreamIds(bob, bobDataGrantId);
      assert.ok(ids.has('steps') && ids.has('fertility'), JSON.stringify([...ids]));
      assert.ok([...ids].some((s) => s.startsWith(':_cmc:')), 'machinery permissions must survive');
      await pollStreamFor(alice.eventsPath, alice.token, h.aliceCollectorStreamId, 'consent/scope-update-cmc',
        (e) => e.content?.scopeRequestEventId === remoteId && e.content?.accept === true &&
          e.content?.newPermissions?.some((p) => p.streamId === 'steps'));
      // A second answer to the same request is refused.
      const again = await answer(h.bobCollectorStreamId, { scopeRequestEventId: remoteId, accept: true });
      assert.strictEqual(again.content.status, 'failed');
      assert.strictEqual(again.content.failure.reason, 'cmc-scope-request-already-answered');
    });

    it('[CN42] an answer on another relationship\'s collectors stream changes neither grant', async function () {
      const other = await runFreshHandshake('study-sr-other');
      const otherGrant = await pollCounterpartyAccessForScope(bob, alice.username, other.triggerStreamId);
      const remoteId = await propose(h, [{ streamId: 'fertility', level: 'read' }, { streamId: 'mood', level: 'read' }]);
      const done = await answer(other.bobCollectorStreamId, { scopeRequestEventId: remoteId, accept: true });
      assert.strictEqual(done.content.status, 'failed');
      assert.strictEqual(done.content.failure.reason, 'cmc-scope-request-stream-mismatch');
      assert.ok(!(await grantStreamIds(bob, bobDataGrantId)).has('mood'));
      assert.ok(!(await grantStreamIds(bob, otherGrant.id)).has('mood'));
    });

    it('[CN43] a request the user wrote themself cannot be answered into a grant change', async function () {
      const forged = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobCollectorStreamId],
          type: 'consent/scope-request-cmc',
          content: { newPermissions: [{ streamId: '*', level: 'manage' }] },
        });
      assert.strictEqual(forged.status, 201, JSON.stringify(forged.body));
      const done = await answer(h.bobCollectorStreamId, { scopeRequestEventId: forged.body.event.id, accept: true });
      assert.strictEqual(done.content.status, 'failed');
      assert.strictEqual(done.content.failure.reason, 'cmc-scope-request-not-from-peer');
      assert.ok(!(await grantStreamIds(bob, bobDataGrantId)).has('*'));
    });

    it('[CN44] refusing applies nothing, completes with applied false, and tells the collector', async function () {
      const remoteId = await propose(h, [{ streamId: 'fertility', level: 'read' }, { streamId: 'sleep', level: 'read' }]);
      const done = await answer(h.bobCollectorStreamId, { scopeRequestEventId: remoteId, accept: false });
      assert.strictEqual(done.content.status, 'completed', JSON.stringify(done.content));
      assert.strictEqual(done.content.applied, false);
      assert.ok(!(await grantStreamIds(bob, bobDataGrantId)).has('sleep'));
      await pollStreamFor(alice.eventsPath, alice.token, h.aliceCollectorStreamId, 'consent/scope-update-cmc',
        (e) => e.content?.scopeRequestEventId === remoteId && e.content?.accept === false);
    });
  });

  describe('[CMCHS-AS] accept on an app scope the accepter never created', function () {
    async function issueRequest (appId) {
      const root = ':_cmc:apps:' + appId;
      const trigger = root + ':study';
      await ensureStream(alice.streamsPath, alice.token, { id: root, parentId: ':_cmc:apps', name: appId });
      await ensureStream(alice.streamsPath, alice.token, { id: trigger, parentId: root, name: 'study' });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [trigger],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            request: {
              title: { en: appId },
              description: { en: 'absent accept scope' },
              consent: { en: 'I consent.' },
              permissions: [{ streamId: 'fertility', level: 'read' }],
            },
            requesterMeta: { username: alice.username, appId },
          },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.event.content.capabilityUrl;
    }

    async function streamExists (actor, streamId) {
      const res = await coreRequest.get(actor.streamsPath).set('Authorization', actor.token);
      const find = (list) => {
        for (const s of list || []) {
          if (s.id === streamId) return s;
          const c = find(s.children);
          if (c != null) return c;
        }
        return null;
      };
      return find(res.body?.streams);
    }

    it('[CN45] a personal-token accept provisions the absent scope and completes', async function () {
      const appId = 'fresh-' + cuid().slice(-8).toLowerCase();
      const capabilityUrl = await issueRequest(appId);
      const scope = ':_cmc:apps:' + appId + ':cohort';
      assert.strictEqual(await streamExists(bob, ':_cmc:apps:' + appId), null, 'precondition: scope absent');
      const res = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({ streamIds: [scope], type: 'consent/accept-cmc', content: { capabilityUrl, accessName: 'cmc-grant-' + appId } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const created = await streamExists(bob, scope);
      assert.ok(created != null, 'scope stream must now exist');
      assert.strictEqual(created.clientData?.cmc?.autoProvisioned, true);
      const t0 = Date.now();
      let status;
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        const ev = await coreRequest.get(bob.eventsPath + '/' + res.body.event.id).set('Authorization', bob.token);
        status = ev.body?.event?.content?.status;
        if (status === 'completed' || status === 'failed') break;
        await sleep(POLL_INTERVAL_MS);
      }
      assert.strictEqual(status, 'completed');
    });

    it('[CN46] a non-personal token gets no provisioning', async function () {
      const appId = 'fresh-' + cuid().slice(-8).toLowerCase();
      const capabilityUrl = await issueRequest(appId);
      const appToken = cuid();
      const accRes = await coreRequest.post(bob.accessesPath)
        .set('Authorization', bob.token)
        .send({ type: 'app', name: 'app-' + appId, token: appToken, permissions: [{ streamId: ':_cmc:apps:' + appId, level: 'manage' }] });
      assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));
      const scope = ':_cmc:apps:' + appId + ':cohort';
      const res = await coreRequest.post(bob.eventsPath)
        .set('Authorization', appToken)
        .send({ streamIds: [scope], type: 'consent/accept-cmc', content: { capabilityUrl } });
      assert.notStrictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'unknown-referenced-resource', JSON.stringify(res.body));
      assert.strictEqual(await streamExists(bob, scope), null);
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
      const newAccessId = String(peerNotif.content.newAccessId);
      assert.ok(newAccessId === dataGrant.id || newAccessId.startsWith(dataGrant.id + ':'),
        'newAccessId must reference the updated data-grant: ' + newAccessId);
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

  // Two concurrent relationships between the SAME pair under the SAME app.
  //
  // Every other describe here keeps its scenario hermetic by handshaking
  // once (or by using a per-test app-code), which is precisely why this gap
  // has never been exercised: the back-channel matcher and the outbound
  // chat/system/revoke selectors BOTH resolve a counterparty access by
  // (peer username, peer host, appCode) first-match, and appCode is derived
  // from the app scope — not from the per-request scope. So two
  // relationships with one peer under one app are indistinguishable to both
  // halves, and they agree with each other only because they are wrong in
  // the same direction.
  //
  // Concretely: the second handshake's back-channel overwrites the FIRST
  // grant's remote stream pointers with the second relationship's scope.
  // A send on the first relationship then resolves that same first grant
  // and delivers to the SECOND relationship's streams.
  //
  // Deliveries on the older relationship are therefore misrouted, and a
  // consent-revocation on it cannot reach the counterparty at all.
  //
  // Both halves now resolve through the shared selector in relationshipKey,
  // keyed on the per-request scope stream rather than on appCode.
  describe('[CMCHS-DUP] two relationships with one peer under one app', function () {
    let first, second;

    before(async function () {
      // Same appId (the default 'my-app') — only the per-request scope differs.
      first = await runFreshHandshake('study-dup-a');
      second = await runFreshHandshake('study-dup-b');
    });

    it('[CN26] the newer relationship delivers to its own streams', async function () {
      const text = 'newer relationship ' + Date.now();
      const res = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [second.bobChatStreamId],
          type: 'message/chat-cmc',
          content: { content: text },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));

      await pollStreamFor(
        alice.eventsPath, alice.token, second.aliceChatStreamId, 'message/chat-cmc',
        (e) => e.content?.content === text
      );
    });

    it('[CN27] the older relationship delivers to its own streams, not the newer one\'s', async function () {
      const text = 'older relationship ' + Date.now();
      const res = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [first.bobChatStreamId],
          type: 'message/chat-cmc',
          content: { content: text },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));

      // The message must land on the FIRST relationship's stream.
      await pollStreamFor(
        alice.eventsPath, alice.token, first.aliceChatStreamId, 'message/chat-cmc',
        (e) => e.content?.content === text
      );

      // ...and must NOT have been misrouted onto the second's.
      const onSecond = await coreRequest.get(alice.eventsPath)
        .set('Authorization', alice.token)
        .query({ streams: [second.aliceChatStreamId], types: ['message/chat-cmc'], limit: 100 });
      const leaked = (onSecond.body?.events || [])
        .some((e) => e.content?.content === text);
      assert.equal(leaked, false,
        'message sent on the older relationship must not surface on the newer one\'s stream');
    });

    it('[CN28] each relationship keeps its own back-channel pointers', async function () {
      const res = await coreRequest.get(bob.accessesPath)
        .set('Authorization', bob.token);
      const grants = (res.body?.accesses || []).filter((a) => {
        const cmc = a?.clientData?.cmc;
        return cmc?.role === 'counterparty' &&
               cmc?.counterparty?.username === alice.username;
      });
      const scopeOf = (g) => g?.clientData?.cmc?.counterparty?.remoteChatStreamId;
      const scopes = grants.map(scopeOf).filter((s) => typeof s === 'string');

      // Both scopes must be represented across the grants — if the second
      // handshake overwrote the first grant, one of them is simply absent.
      const hasFirst = scopes.some((s) => s.startsWith(first.triggerStreamId + ':'));
      const hasSecond = scopes.some((s) => s.startsWith(second.triggerStreamId + ':'));
      assert.ok(hasFirst,
        'a grant must still point at ' + first.triggerStreamId + '; scopes seen: ' + JSON.stringify(scopes));
      assert.ok(hasSecond,
        'a grant must point at ' + second.triggerStreamId + '; scopes seen: ' + JSON.stringify(scopes));
    });
  });

  // Withdraw-then-re-consent through a still-open shareable link.
  //
  // Who joined an open-link invite is the set of live relationship
  // accesses the requester holds for its capability, and a second accept
  // from a subject still in that set is refused
  // (`cmc-capability-already-accepted-by-you`). When that subject
  // withdraws, their relationship access goes, so a fresh consent through
  // the SAME link is accepted again — while every OTHER accepter stays
  // joined.
  describe('[CMCHS-RECONSENT] withdraw ends the join so the same link accepts again', function () {
    // Each case runs a full two-party open-link handshake plus a revoke round
    // trip (several chained fire-and-forget hops); under full-matrix CPU
    // contention these balloon, so the bound is generous (matches the oauth2
    // reconsent block). The bodies complete in ~1s isolated.
    this.timeout(120_000);

    async function capabilityAcceptedBy (owner, capabilityId) {
      return await liveAccepters(owner, capabilityId);
    }

    async function pollAcceptedBy (owner, capabilityId, username, shouldContain, label) {
      const t0 = Date.now();
      let names = [];
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        const list = await capabilityAcceptedBy(owner, capabilityId);
        names = list.map((e) => e.username);
        if (names.includes(username) === shouldContain) return list;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error((label || '') + ' timeout: joined contains(' + username +
        ')=' + shouldContain + '; saw ' + JSON.stringify(names));
    }

    async function postAccept (actor, capabilityUrl, tag) {
      const res = await coreRequest.post(actor.eventsPath)
        .set('Authorization', actor.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/accept-cmc',
          content: { capabilityUrl, accessName: 'cmc-grant-' + tag + '-' + Date.now() },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.event.id;
    }

    async function pollEventStatus (actor, eventId, statuses) {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        const res = await coreRequest.get(actor.eventsPath + '/' + eventId)
          .set('Authorization', actor.token);
        last = res.body?.event?.content;
        if (statuses.includes(last?.status)) return res.body.event;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error('event ' + eventId + ' never reached ' + JSON.stringify(statuses) +
        '; last status=' + JSON.stringify(last?.status));
    }

    it('[CN29] helper-driven revoke of an open-link accept lets the SAME link accept again', async function () {
      const h = await runFreshHandshake('reco-a', 'my-app', { mode: 'open-link' });
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);

      // First accept: bob holds a relationship through the capability.
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN29 pre-revoke');

      // Bob withdraws via the CMC helper trigger.
      const revRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: dataGrant.id, reason: { en: 'CN29 withdraw' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      // The withdrawal ends bob's join (his relationship access is gone on
      // alice's side), so re-consent is no longer blocked.
      await pollAcceptedBy(alice, h.capabilityId, bob.username, false, 'CN29 post-revoke');

      // A fresh accept through the SAME capability URL now succeeds — proven
      // by bob joining again (a rejected accept mints no relationship).
      await postAccept(bob, h.capabilityUrl, 'reco-a-again');
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN29 re-accept');
    });

    it('[CN30] raw accesses.delete of the accept lets the SAME link accept again', async function () {
      const h = await runFreshHandshake('reco-b', 'my-app', { mode: 'open-link' });
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN30 pre-revoke');

      // Bob withdraws by removing the relationship access directly
      // (the delete-hook forwarding path; no CMC helper trigger).
      const delRes = await coreRequest.delete(bob.accessesPath + '/' + dataGrant.id)
        .set('Authorization', bob.token);
      assert.strictEqual(delRes.status, 200, JSON.stringify(delRes.body));

      await pollAcceptedBy(alice, h.capabilityId, bob.username, false, 'CN30 post-revoke');
      await postAccept(bob, h.capabilityUrl, 'reco-b-again');
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN30 re-accept');
    });

    it('[CN31] one accepter\'s withdrawal leaves a co-accepter blocked; only the withdrawer re-accepts', async function () {
      const carol = await makeActor('carol-' + cuid().slice(-8));

      // Bob handshakes the open-link; carol accepts the SAME link.
      const h = await runFreshHandshake('reco-c', 'my-app', { mode: 'open-link' });
      const bobGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN31 bob accepted');

      await postAccept(carol, h.capabilityUrl, 'reco-c-carol');
      await pollAcceptedBy(alice, h.capabilityId, carol.username, true, 'CN31 carol accepted');

      // Bob withdraws (raw delete). Only bob must be cleared.
      const delRes = await coreRequest.delete(bob.accessesPath + '/' + bobGrant.id)
        .set('Authorization', bob.token);
      assert.strictEqual(delRes.status, 200, JSON.stringify(delRes.body));
      await pollAcceptedBy(alice, h.capabilityId, bob.username, false, 'CN31 bob cleared');

      // Co-accepter stays joined.
      const stillCarol = await capabilityAcceptedBy(alice, h.capabilityId);
      assert.ok(stillCarol.some((e) => e.username === carol.username),
        'CN31: carol\'s relationship must survive bob\'s withdrawal; saw ' +
        JSON.stringify(stillCarol.map((e) => e.username)));

      // Carol's re-accept is STILL rejected — she never withdrew.
      const carolAgain = await postAccept(carol, h.capabilityUrl, 'reco-c-carol-again');
      const carolTrigger = await pollEventStatus(carol, carolAgain, ['failed', 'completed']);
      assert.equal(carolTrigger.content.status, 'failed',
        'CN31: carol\'s re-accept must be refused (she is still joined)');
      // The peer's typed CMC id rides in error.data.id; error.id is the
      // generic Pryv error class ('invalid-operation').
      const carolErr = carolTrigger.content.failure?.detail?.body?.error;
      assert.equal(carolErr?.data?.id, 'cmc-capability-already-accepted-by-you',
        'CN31: refusal must carry the already-accepted-by-you id; got ' +
        JSON.stringify(carolTrigger.content.failure));

      // Bob (who withdrew) can re-consent through the same link.
      await postAccept(bob, h.capabilityUrl, 'reco-c-bob-again');
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN31 bob re-accept');
    });

    it('[CN32] requester-local revoke of the back-channel ends the join for re-consent', async function () {
      const h = await runFreshHandshake('reco-d', 'my-app', { mode: 'open-link' });
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN32 pre-revoke');

      // Locate alice's OWN back-channel access for this relationship (carries
      // the capabilityId stamp), and tear it down locally with a raw delete —
      // the requester-side withdrawal path.
      let backChannel = null;
      const t0 = Date.now();
      while (Date.now() - t0 < POLL_TIMEOUT_MS && backChannel == null) {
        const res = await coreRequest.get(alice.accessesPath).set('Authorization', alice.token);
        backChannel = (res.body?.accesses || []).find((a) => {
          const cmc = a?.clientData?.cmc;
          return cmc?.role === 'counterparty' && cmc?.capabilityId === h.capabilityId &&
                 cmc?.counterparty?.username === bob.username;
        }) || null;
        if (backChannel == null) await sleep(POLL_INTERVAL_MS);
      }
      assert.ok(backChannel != null,
        'CN32: alice\'s back-channel access (with capabilityId stamp) must exist');

      // Requester withdraws her own relationship via the CMC helper trigger
      // (consent/revoke-cmc targeting the back-channel access by id). This is
      // the requester-side teardown path that carries the capabilityId stamp,
      // so deleting it ends the accepter's join.
      const revRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [h.aliceCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: backChannel.id, reason: { en: 'CN32 requester withdraw' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      await pollAcceptedBy(alice, h.capabilityId, bob.username, false, 'CN32 post-revoke');

      // Bob re-consents through the same link.
      await postAccept(bob, h.capabilityUrl, 'reco-d-again');
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN32 re-accept');
    });

    it('[CN33] requester RAW accesses.delete of the back-channel ends the join locally', async function () {
      // CN32 exercises the requester-side teardown via the CMC helper trigger
      // (dispatch path). This drives the OTHER requester-side teardown: a raw
      // accesses.delete of the back-channel, which runs the accesses.delete
      // post-hook. Re-consent through the same link must be accepted once the
      // relationship access is gone. Exercises the real
      // production wiring the DH12/DH13 unit tests (fake mall) could not.
      const h = await runFreshHandshake('reco-e', 'my-app', { mode: 'open-link' });
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN33 pre-revoke');

      // Locate alice's OWN back-channel access for this relationship (carries the
      // capabilityId stamp).
      let backChannel = null;
      const t0 = Date.now();
      while (Date.now() - t0 < POLL_TIMEOUT_MS && backChannel == null) {
        const res = await coreRequest.get(alice.accessesPath).set('Authorization', alice.token);
        backChannel = (res.body?.accesses || []).find((a) => {
          const cmc = a?.clientData?.cmc;
          return cmc?.role === 'counterparty' && cmc?.capabilityId === h.capabilityId &&
                 cmc?.counterparty?.username === bob.username;
        }) || null;
        if (backChannel == null) await sleep(POLL_INTERVAL_MS);
      }
      assert.ok(backChannel != null,
        'CN33: alice\'s back-channel access (with capabilityId stamp) must exist');

      // Raw delete (NOT the CMC helper) — drives the delete post-hook.
      const delRes = await coreRequest.delete(alice.accessesPath + '/' + backChannel.id)
        .set('Authorization', alice.token);
      assert.strictEqual(delRes.status, 200, JSON.stringify(delRes.body));

      await pollAcceptedBy(alice, h.capabilityId, bob.username, false, 'CN33 post-revoke');

      // Bob re-consents through the same link (blocked while he was joined).
      await postAccept(bob, h.capabilityUrl, 'reco-e-again');
      await pollAcceptedBy(alice, h.capabilityId, bob.username, true, 'CN33 re-accept');
    });
  });

  describe('[CMCHS-EXP] capability expiry per mode', function () {
    this.timeout(120_000);

    const TWO_YEARS = 2 * 365 * 24 * 60 * 60;

    async function capabilityAccess (owner, capabilityId) {
      const res = await coreRequest.get(owner.accessesPath).set('Authorization', owner.token);
      return (res.body?.accesses || []).find((a) =>
        a?.clientData?.cmc?.kind === 'capability' &&
        a?.clientData?.cmc?.capabilityId === capabilityId);
    }

    async function postRequest (studyId, { mode, expiresAt }) {
      const triggerStreamId = ':_cmc:apps:my-app:' + studyId;
      await ensureStream(alice.streamsPath, alice.token, {
        id: triggerStreamId, parentId: ':_cmc:apps:my-app', name: studyId,
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [triggerStreamId],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            ...(mode != null ? { capability: { mode } } : {}),
            request: {
              title: { en: studyId },
              description: { en: 'expiry test' },
              consent: { en: 'I consent.' },
              permissions: [{ streamId: 'fertility', level: 'read' }],
              expiresAt,
            },
            requesterMeta: { username: alice.username, appId: 'my-app' },
          },
        });
      return { res, triggerStreamId };
    }

    async function acceptAndWaitOutcome (actor, capabilityUrl, tag) {
      const res = await coreRequest.post(actor.eventsPath)
        .set('Authorization', actor.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/accept-cmc',
          content: { capabilityUrl, accessName: 'cmc-grant-' + tag + '-' + Date.now() },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const eventId = res.body.event.id;
      const t0 = Date.now();
      let content;
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        const r = await coreRequest.get(actor.eventsPath + '/' + eventId).set('Authorization', actor.token);
        content = r.body?.event?.content;
        if (content?.status === 'completed' || content?.status === 'failed') return content;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error('accept ' + eventId + ' never settled; last status=' + JSON.stringify(content?.status));
    }

    it('[CN47] an open-link invite with expiresAt null has no expiry and completes a handshake', async function () {
      const h = await runFreshHandshake('noexp-a', 'my-app', { mode: 'open-link', expiresAt: null });
      assert.strictEqual(h.capabilityExpiresAt, null);
      const acc = await capabilityAccess(alice, h.capabilityId);
      assert.ok(acc != null, 'capability access must be listed');
      assert.ok(acc.expires == null, 'capability access must carry no expiry: ' + JSON.stringify(acc.expires));
    });

    it('[CN48] a single-use invite with expiresAt null is refused and not persisted', async function () {
      const { res, triggerStreamId } = await postRequest('noexp-b', { expiresAt: null });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-capability-no-expiry-not-allowed');
      const list = await coreRequest.get(alice.eventsPath)
        .set('Authorization', alice.token)
        .query({ streams: [triggerStreamId], types: ['consent/request-cmc'] });
      assert.strictEqual((list.body?.events || []).length, 0);
    });

    it('[CN49] invalidation still ends an open-link invite that has no expiry', async function () {
      const h = await runFreshHandshake('noexp-c', 'my-app', { mode: 'open-link', expiresAt: null });
      const invRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/invalidate-link-cmc',
          content: { capabilityId: h.capabilityId },
        });
      assert.strictEqual(invRes.status, 201, JSON.stringify(invRes.body));
      const t0 = Date.now();
      let state;
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        state = (await capabilityAccess(alice, h.capabilityId))?.clientData?.cmc?.capability?.state;
        if (state === 'invalidated') break;
        await sleep(POLL_INTERVAL_MS);
      }
      assert.strictEqual(state, 'invalidated');
      const outcome = await acceptAndWaitOutcome(bob, h.capabilityUrl, 'noexp-c-again');
      assert.strictEqual(outcome.status, 'failed', JSON.stringify(outcome));
      assert.strictEqual(outcome.failure?.reason, 'cmc-capability-invalidated', JSON.stringify(outcome));
    });

    it('[CN50] a numeric expiresAt two years ahead is accepted for open-link and refused for single-use', async function () {
      const expiresAt = Math.floor(Date.now() / 1000) + TWO_YEARS;
      const h = await runFreshHandshake('noexp-d', 'my-app', { mode: 'open-link', expiresAt });
      // The hook and the mint each read the clock once; a second boundary
      // between the two reads is the only way the stamp can differ (by 1).
      assert.ok(h.capabilityExpiresAt === expiresAt || h.capabilityExpiresAt === expiresAt + 1,
        'capabilityExpiresAt ' + h.capabilityExpiresAt + ' vs requested ' + expiresAt);

      const { res } = await postRequest('noexp-e', { expiresAt });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-capability-ttl-out-of-range');
      assert.strictEqual(res.body?.error?.data?.mode, 'single-use');
      assert.strictEqual(res.body?.error?.data?.maxTtlSeconds, 30 * 24 * 60 * 60);
    });

    it('[CN51] accepting through an unknown capability token fails with cmc-capability-invalid', async function () {
      const h = await runFreshHandshake('noexp-f', 'my-app', { mode: 'open-link' });
      const url = new URL(h.capabilityUrl);
      url.username = 'unknowntoken' + cuid().slice(-8);
      const outcome = await acceptAndWaitOutcome(bob, url.toString(), 'noexp-f-bad');
      assert.strictEqual(outcome.status, 'failed', JSON.stringify(outcome));
      assert.strictEqual(outcome.failure?.reason, 'cmc-capability-invalid', JSON.stringify(outcome));
    });
  });

  /**
   * [CMCHS-INVITE] the request trigger reports the invite's outcome.
   *
   * The requester's app watches its `consent/request-cmc` trigger; the core
   * writes each transition there (accepted / refused / revoked for single-use,
   * invalidated for open-link). Who joined an open-link invite is read from the
   * live relationship accesses, which nothing rewrites per accept.
   */
  describe('[CMCHS-INVITE] invite state on the request trigger', function () {
    this.timeout(180_000);

    async function pollTrigger (actor, eventId, predicate, label) {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < POLL_TIMEOUT_MS * 3) {
        const res = await coreRequest.get(actor.eventsPath + '/' + eventId).set('Authorization', actor.token);
        last = res.body?.event;
        if (last != null && predicate(last.content || {})) return last;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error(label + ': event ' + eventId + ' never matched; last content=' +
        JSON.stringify(last?.content));
    }

    async function postInvite (studyId, mode) {
      const triggerStreamId = ':_cmc:apps:my-app:' + studyId;
      await ensureStream(alice.streamsPath, alice.token, {
        id: triggerStreamId, parentId: ':_cmc:apps:my-app', name: studyId,
      });
      const res = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [triggerStreamId],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            ...(mode != null ? { capability: { mode } } : {}),
            request: {
              title: { en: studyId },
              description: { en: 'invite state test' },
              consent: { en: 'I consent.' },
              permissions: [{ streamId: 'fertility', level: 'read' }],
            },
            requesterMeta: { username: alice.username, appId: 'my-app' },
          },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return {
        triggerStreamId,
        requestEventId: res.body.event.id,
        capabilityUrl: res.body.event.content.capabilityUrl,
        capabilityId: res.body.event.content.capabilityId,
      };
    }

    async function postAnswer (actor, type, capabilityUrl, extra = {}) {
      const res = await coreRequest.post(actor.eventsPath)
        .set('Authorization', actor.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type,
          content: { capabilityUrl, ...extra },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.event.id;
    }

    async function capabilityAccessOf (owner, capabilityId) {
      const res = await coreRequest.get(owner.accessesPath).set('Authorization', owner.token);
      return (res.body?.accesses || []).find((a) =>
        a?.clientData?.cmc?.kind === 'capability' && a?.clientData?.cmc?.capabilityId === capabilityId);
    }

    const settled = (c) => c.status === 'completed' || c.status === 'failed';

    it('[CN52] a single-use accept marks the invite accepted, naming the accepter and the back-channel', async function () {
      const h = await runFreshHandshake('inv-a');
      const trigger = await pollTrigger(alice, h.requestEventId, (c) => c.status === 'accepted', 'CN52');
      assert.strictEqual(trigger.content.acceptedBy?.username, bob.username, JSON.stringify(trigger.content));
      assert.ok(typeof trigger.content.acceptedAt === 'number', JSON.stringify(trigger.content));
      const joined = await liveAccepters(alice, h.capabilityId);
      assert.strictEqual(joined.length, 1, JSON.stringify(joined));
      assert.strictEqual(trigger.content.backChannelAccessId, joined[0].accessId);
    });

    it('[CN53] a refusal reaches the requester and marks the invite refused; the subject may still accept', async function () {
      const inv = await postInvite('inv-b');
      const refuseId = await postAnswer(bob, 'consent/refuse-cmc', inv.capabilityUrl, { reason: { en: 'CN53 no' } });
      const refuse = await pollTrigger(bob, refuseId, settled, 'CN53 refuse trigger');
      assert.strictEqual(refuse.content.status, 'completed', JSON.stringify(refuse.content));
      const refused = await pollTrigger(alice, inv.requestEventId, (c) => c.status === 'refused', 'CN53 invite');
      assert.strictEqual(refused.content.refusedBy?.username, bob.username, JSON.stringify(refused.content));

      // A refusal does not consume a single-use link.
      const acceptId = await postAnswer(bob, 'consent/accept-cmc', inv.capabilityUrl,
        { accessName: 'cmc-grant-inv-b-' + Date.now() });
      const accept = await pollTrigger(bob, acceptId, settled, 'CN53 accept trigger');
      assert.strictEqual(accept.content.status, 'completed', JSON.stringify(accept.content));
      await pollTrigger(alice, inv.requestEventId, (c) => c.status === 'accepted', 'CN53 accepted after refusal');
    });

    it('[CN54] invalidating an open-link marks the invite invalidated and later accepts fail', async function () {
      const h = await runFreshHandshake('inv-c', 'my-app', { mode: 'open-link' });
      const invRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/invalidate-link-cmc',
          content: { capabilityId: h.capabilityId },
        });
      assert.strictEqual(invRes.status, 201, JSON.stringify(invRes.body));
      await pollTrigger(alice, h.requestEventId, (c) => c.status === 'invalidated', 'CN54');

      const carol = await makeActor('carol-' + cuid().slice(-8));
      const acceptId = await postAnswer(carol, 'consent/accept-cmc', h.capabilityUrl,
        { accessName: 'cmc-grant-inv-c-' + Date.now() });
      const accept = await pollTrigger(carol, acceptId, settled, 'CN54 late accept');
      assert.strictEqual(accept.content.failure?.reason, 'cmc-capability-invalidated', JSON.stringify(accept.content));
      const after = await pollTrigger(alice, h.requestEventId, () => true, 'CN54 after');
      assert.strictEqual(after.content.status, 'invalidated');
    });

    it('[CN55] withdrawing a single-use relationship marks the invite revoked, from either side', async function () {
      // The accepter withdraws.
      const a = await runFreshHandshake('inv-d');
      await pollTrigger(alice, a.requestEventId, (c) => c.status === 'accepted', 'CN55 a accepted');
      const bobGrant = await pollCounterpartyAccessForScope(bob, alice.username, a.triggerStreamId);
      const revRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [a.bobCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: bobGrant.id, reason: { en: 'CN55 withdraw' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));
      const revoked = await pollTrigger(alice, a.requestEventId, (c) => c.status === 'revoked', 'CN55 a revoked');
      assert.ok(typeof revoked.content.revokedAt === 'number', JSON.stringify(revoked.content));

      // The requester deletes her own back-channel.
      const b = await runFreshHandshake('inv-e');
      await pollTrigger(alice, b.requestEventId, (c) => c.status === 'accepted', 'CN55 b accepted');
      const [joined] = await liveAccepters(alice, b.capabilityId);
      const delRes = await coreRequest.delete(alice.accessesPath + '/' + joined.accessId)
        .set('Authorization', alice.token);
      assert.strictEqual(delRes.status, 200, JSON.stringify(delRes.body));
      await pollTrigger(alice, b.requestEventId, (c) => c.status === 'revoked', 'CN55 b revoked');
    });

    it('[CN56] concurrent accepts on one open-link all join, and the capability access is never rewritten', async function () {
      const inv = await postInvite('inv-f', 'open-link');
      // The post-create hook stamps requestEventId on the capability access;
      // take the baseline once that write has landed.
      let baseline;
      const t0 = Date.now();
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        baseline = await capabilityAccessOf(alice, inv.capabilityId);
        if (baseline?.clientData?.cmc?.requestEventId === inv.requestEventId) break;
        await sleep(POLL_INTERVAL_MS);
      }
      assert.strictEqual(baseline?.clientData?.cmc?.requestEventId, inv.requestEventId);

      const actors = [];
      for (let i = 0; i < 5; i++) actors.push(await makeActor('joiner' + i + '-' + cuid().slice(-8)));
      const triggerIds = await Promise.all(actors.map((actor, i) =>
        postAnswer(actor, 'consent/accept-cmc', inv.capabilityUrl, { accessName: 'cmc-grant-inv-f-' + i })));
      for (let i = 0; i < actors.length; i++) {
        const t = await pollTrigger(actors[i], triggerIds[i], settled, 'CN56 accept ' + i);
        assert.strictEqual(t.content.status, 'completed', JSON.stringify(t.content));
      }

      const t1 = Date.now();
      let names = [];
      while (Date.now() - t1 < POLL_TIMEOUT_MS * 3) {
        names = (await liveAccepters(alice, inv.capabilityId)).map((e) => e.username);
        if (names.length >= actors.length) break;
        await sleep(POLL_INTERVAL_MS);
      }
      assert.deepStrictEqual(names.sort(), actors.map((a) => a.username).sort());

      const after = await capabilityAccessOf(alice, inv.capabilityId);
      assert.strictEqual(after.modified, baseline.modified, 'the capability access must not be rewritten per accept');
      assert.strictEqual(after.clientData.cmc.capability.acceptedBy, undefined);
      const trigger = await pollTrigger(alice, inv.requestEventId, () => true, 'CN56 trigger');
      assert.ok(['pending', 'delivered'].includes(trigger.content.status), JSON.stringify(trigger.content));
    });

    it('[CN57] two concurrent accepts by the same subject leave exactly one relationship', async function () {
      const inv = await postInvite('inv-g', 'open-link');
      const dave = await makeActor('dave-' + cuid().slice(-8));
      const ids = await Promise.all([0, 1].map((i) =>
        postAnswer(dave, 'consent/accept-cmc', inv.capabilityUrl, { accessName: 'cmc-grant-inv-g-' + i })));
      for (const id of ids) {
        const t = await pollTrigger(dave, id, settled, 'CN57 accept');
        if (t.content.status === 'failed') {
          assert.strictEqual(t.content.failure?.detail?.body?.error?.data?.id,
            'cmc-capability-already-accepted-by-you', JSON.stringify(t.content));
        }
      }
      // Let a late back-channel settle before counting.
      let joined = [];
      const t0 = Date.now();
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        joined = (await liveAccepters(alice, inv.capabilityId)).filter((e) => e.username === dave.username);
        if (joined.length >= 1) break;
        await sleep(POLL_INTERVAL_MS);
      }
      await sleep(1000);
      joined = (await liveAccepters(alice, inv.capabilityId)).filter((e) => e.username === dave.username);
      assert.strictEqual(joined.length, 1, JSON.stringify(joined));
    });
  });

  /**
   * [CMCHS-TEARDOWN] a received revocation destroys the access it arrived
   * through.
   *
   * Each side deletes the access the PEER holds against its own account: the
   * withdrawing side does its half locally, and the receiving side does the
   * other half when the revoke lands. Before that second half existed, the
   * withdrawing side kept a live token on the peer's data after both sides
   * considered the relationship over.
   *
   * Destructive by nature (every case tears a relationship down), so this
   * describe runs last and each case builds its own fresh handshake.
   */
  describe('[CMCHS-TEARDOWN] a received revoke deletes the access it arrived through', function () {
    // The requester's back-channel access for ONE relationship, identified by
    // the channel permissions it holds (scope-keyed, so it works in every
    // capability mode and with several relationships per peer).
    async function backChannelFor (actor, triggerStreamId) {
      const t0 = Date.now();
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        const res = await coreRequest.get(actor.accessesPath).set('Authorization', actor.token);
        const hit = (res.body?.accesses || []).find((a) => {
          if (a?.clientData?.cmc?.role !== 'counterparty') return false;
          return (a.permissions || []).some((p) =>
            typeof p?.streamId === 'string' && p.streamId.startsWith(triggerStreamId + ':'));
        });
        if (hit != null) return hit;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error('no counterparty access found under ' + triggerStreamId);
    }

    // The token the REQUESTER received for the peer's data, taken from the
    // accept mirror that names this relationship's back-channel access.
    async function requesterGrantToken (h) {
      const bc = await backChannelFor(alice, h.triggerStreamId);
      const mirror = await pollInboxFor(
        alice.eventsPath, alice.token, 'consent/accept-cmc',
        (e) => e.content?.backChannelAccessId === bc.id
      );
      const apiEndpoint = mirror.content?.grantedAccess?.apiEndpoint;
      assert.ok(typeof apiEndpoint === 'string' && apiEndpoint.length > 0,
        'accept mirror must carry grantedAccess.apiEndpoint: ' + JSON.stringify(mirror.content));
      return { token: tokenOf(apiEndpoint), backChannel: bc };
    }

    function tokenOf (apiEndpoint) {
      return apiEndpoint.replace(/^https?:\/\//, '').split('@')[0];
    }

    // Is `token` still a live access on `owner`'s account? access-info answers
    // that without depending on any stream existing.
    async function tokenLivesOn (owner, token) {
      const res = await coreRequest.get('/' + owner.username + '/access-info')
        .set('Authorization', token);
      return res.status === 200;
    }

    async function pollTokenDead (owner, token, label) {
      const t0 = Date.now();
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        if (!await tokenLivesOn(owner, token)) return;
        await sleep(POLL_INTERVAL_MS);
      }
      assert.fail(label + ': the token still authenticates on ' + owner.username +
        ' after the revoke was delivered');
    }

    async function accessExists (owner, accessId) {
      const res = await coreRequest.get(owner.accessesPath).set('Authorization', owner.token);
      return (res.body?.accesses || []).some((a) => a.id === accessId);
    }

    async function countInboxRevokes (actor) {
      const res = await coreRequest.get(actor.eventsPath)
        .set('Authorization', actor.token)
        .query({ streams: [':_cmc:inbox'], types: ['consent/revoke-cmc'], limit: 50 });
      return (res.body?.events || []).length;
    }

    // Local copies of the re-consent describe's helpers: that one's postAccept
    // hardcodes the `my-app` scope, and these cases each run under their own
    // app code.
    async function pollAcceptedByLocal (owner, capabilityId, username, shouldContain, label) {
      const t0 = Date.now();
      let names = [];
      while (Date.now() - t0 < POLL_TIMEOUT_MS) {
        names = (await liveAccepters(owner, capabilityId)).map((e) => e.username);
        if (names.includes(username) === shouldContain) return;
        await sleep(POLL_INTERVAL_MS);
      }
      assert.fail(label + ' timeout: joined contains(' + username + ')=' +
        shouldContain + '; saw ' + JSON.stringify(names));
    }

    async function postAcceptUnder (actor, appId, capabilityUrl, tag) {
      const res = await coreRequest.post(actor.eventsPath)
        .set('Authorization', actor.token)
        .send({
          streamIds: [':_cmc:apps:' + appId],
          type: 'consent/accept-cmc',
          content: { capabilityUrl, accessName: 'cmc-grant-' + tag + '-' + Date.now() },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.event.id;
    }

    it('[CN34] requester withdraws: her own token on the accepter dies with the relationship', async function () {
      const h = await runFreshHandshake('td-a', 'td-app-a', { mode: 'open-link' });
      const { token: grantToken, backChannel } = await requesterGrantToken(h);

      // Premise: the grant works before the revoke. Without this the test
      // could pass on a token that never worked at all.
      assert.equal(await tokenLivesOn(bob, grantToken), true,
        'CN34 premise: the requester grant must authenticate before the revoke');
      // Resolve the grant's id NOW: after the teardown there is nothing left to
      // look it up by, and an id resolved then would be undefined, making the
      // "is it gone" assertion vacuously true.
      const grantOnBob = (await coreRequest.get(bob.accessesPath)
        .set('Authorization', bob.token)).body?.accesses?.find((a) => a.token === grantToken);
      assert.ok(grantOnBob?.id, 'CN34 premise: the grant must be listed on the accepter account');
      const revokesOnAliceBefore = await countInboxRevokes(alice);

      const revRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [h.aliceCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: backChannel.id, reason: { en: 'CN34 requester withdraw' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      // The accepter observes the withdrawal ...
      await pollInboxFor(bob.eventsPath, bob.token, 'consent/revoke-cmc',
        (e) => e.content?.from?.username === alice.username);
      // ... and acts on it: the requester's token is dead and the access gone.
      await pollTokenDead(bob, grantToken, 'CN34');

      assert.equal(await accessExists(bob, grantOnBob.id), false,
        'CN34: the grant must be gone from the accepter account');

      // Loop-safety: the receiving side enforces locally and POSTs nothing,
      // so no revoke bounces back to the withdrawing side.
      assert.equal(await countInboxRevokes(alice), revokesOnAliceBefore,
        'CN34: the teardown must not deliver anything back to the requester');
    });

    it('[CN35] accepter withdraws: the requester-side back-channel access dies too', async function () {
      const h = await runFreshHandshake('td-b', 'td-app-b', { mode: 'open-link' });
      const bc = await backChannelFor(alice, h.triggerStreamId);
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);

      // The token the ACCEPTER holds on the requester account travels in the
      // back-channel event the requester sent him.
      const backChannelEvent = await pollInboxFor(
        bob.eventsPath, bob.token, 'consent/back-channel-cmc',
        (e) => e.content?.from?.username === alice.username &&
               typeof e.content?.apiEndpoint === 'string'
      );
      const bcToken = tokenOf(backChannelEvent.content.apiEndpoint);
      assert.equal(await tokenLivesOn(alice, bcToken), true,
        'CN35 premise: the accepter back-channel token must authenticate before the revoke');
      // Assert bob IS recorded before asserting he is cleared: without this the
      // post-revoke poll passes instantly if the accept never recorded him.
      await pollAcceptedByLocal(alice, h.capabilityId, bob.username, true, 'CN35 pre-revoke');

      const revRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: dataGrant.id, reason: { en: 'CN35 accepter withdraw' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      await pollInboxFor(alice.eventsPath, alice.token, 'consent/revoke-cmc',
        (e) => e.content?.from?.username === bob.username);
      await pollTokenDead(alice, bcToken, 'CN35');
      assert.equal(await accessExists(alice, bc.id), false,
        'CN35: the back-channel access must be gone from the requester account');

      // The bookkeeping half still runs, and re-consent through the same link
      // still works even though the back-channel access was deleted.
      await pollAcceptedByLocal(alice, h.capabilityId, bob.username, false, 'CN35 post-revoke');
      await postAcceptUnder(bob, 'td-app-b', h.capabilityUrl, 'td-b-again');
      await pollAcceptedByLocal(alice, h.capabilityId, bob.username, true, 'CN35 re-accept');
    });

    it('[CN36] raw accesses.delete by the requester tears the accepter side down as well', async function () {
      const h = await runFreshHandshake('td-c', 'td-app-c', { mode: 'open-link' });
      const { token: grantToken, backChannel } = await requesterGrantToken(h);
      assert.equal(await tokenLivesOn(bob, grantToken), true, 'CN36 premise');

      // The generic "connected apps" path: a plain delete, not the CMC helper.
      const delRes = await coreRequest.delete(alice.accessesPath + '/' + backChannel.id)
        .set('Authorization', alice.token);
      assert.strictEqual(delRes.status, 200, JSON.stringify(delRes.body));

      await pollInboxFor(bob.eventsPath, bob.token, 'consent/revoke-cmc',
        (e) => e.content?.from?.username === alice.username);
      await pollTokenDead(bob, grantToken, 'CN36');
    });

    it('[CN37] revoking one relationship leaves a second one with the same peer untouched', async function () {
      // Two relationships, one app code, one peer: the isolation the
      // scope-keying work established must survive the teardown too.
      const h1 = await runFreshHandshake('td-d1', 'td-app-d', { mode: 'open-link' });
      const h2 = await runFreshHandshake('td-d2', 'td-app-d', { mode: 'open-link' });
      const r1 = await requesterGrantToken(h1);
      const r2 = await requesterGrantToken(h2);
      assert.notEqual(r1.token, r2.token, 'CN37 premise: two distinct grants');
      assert.equal(await tokenLivesOn(bob, r1.token), true, 'CN37 premise r1');
      assert.equal(await tokenLivesOn(bob, r2.token), true, 'CN37 premise r2');

      const revRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [h1.aliceCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: r1.backChannel.id, reason: { en: 'CN37 withdraw one' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      await pollTokenDead(bob, r1.token, 'CN37');
      assert.equal(await tokenLivesOn(bob, r2.token), true,
        'CN37: the untouched relationship must keep its grant');
    });

    it('[CN38] the requester\'s arrival is enriched with ids her app already holds', async function () {
      // Direction: the accepter withdraws, the requester receives. Her app knows
      // the relationship by the accept mirror it stored, so the arrival is
      // joined to that by the back-channel access id and the invite event id.
      const h = await runFreshHandshake('td-e', 'td-app-e', { mode: 'open-link' });
      const bc = await backChannelFor(alice, h.triggerStreamId);
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);

      const revRes = await coreRequest.post(bob.eventsPath)
        .set('Authorization', bob.token)
        .send({
          streamIds: [h.bobCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: dataGrant.id, reason: { en: 'CN38 accepter withdraw' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      // Poll until the enrichment lands: it runs after the teardown, so the
      // arrival is observable before it is enriched.
      const arrival = await pollInboxFor(
        alice.eventsPath, alice.token, 'consent/revoke-cmc',
        // Scope the match: the inbox accumulates arrivals from the earlier
        // cases in this describe, all of them also from bob and also enriched.
        (e) => e.content?.from?.username === bob.username &&
               e.content?.scopeStreamId === h.triggerStreamId &&
               e.content?.backChannelAccessId != null
      );
      assert.equal(arrival.content.backChannelAccessId, bc.id,
        'CN38: the arrival must name the requester-side access, not the sender\'s');
      assert.equal(arrival.content.inviteEventId, h.requestEventId,
        'CN38: the arrival must name the invite the relationship descends from');
      assert.equal(arrival.content.scopeStreamId, h.triggerStreamId);
      assert.deepEqual(arrival.content.revokedAccessIds, [bc.id]);
      // The sender's own id is still there, unchanged, as the schema requires.
      assert.equal(arrival.content.accessId, dataGrant.id);
    });

    it('[CN39] the accepter\'s arrival is enriched with his own grant and trigger ids', async function () {
      const h = await runFreshHandshake('td-f', 'td-app-f', { mode: 'open-link' });
      const { backChannel } = await requesterGrantToken(h);
      const dataGrant = await pollCounterpartyAccessForScope(bob, alice.username, h.triggerStreamId);

      const revRes = await coreRequest.post(alice.eventsPath)
        .set('Authorization', alice.token)
        .send({
          streamIds: [h.aliceCollectorStreamId],
          type: 'consent/revoke-cmc',
          content: { accessId: backChannel.id, reason: { en: 'CN39 requester withdraw' } },
        });
      assert.strictEqual(revRes.status, 201, JSON.stringify(revRes.body));

      const arrival = await pollInboxFor(
        bob.eventsPath, bob.token, 'consent/revoke-cmc',
        (e) => e.content?.from?.username === alice.username &&
               e.content?.scopeStreamId === h.triggerStreamId &&
               e.content?.dataGrantAccessId != null
      );
      assert.equal(arrival.content.dataGrantAccessId, dataGrant.id,
        'CN39: the arrival must name the accepter-side grant');
      assert.equal(arrival.content.scopeStreamId, h.triggerStreamId);
      assert.deepEqual(arrival.content.revokedAccessIds, [dataGrant.id]);
      // The trigger ids must equal what bob's own grant was stamped with, which
      // is what his app matched the relationship by in the first place.
      const grantCmc = dataGrant.clientData?.cmc || {};
      assert.equal(arrival.content.offerEventId, grantCmc.offerEventId,
        'CN39: offerEventId must match the accepter\'s own grant');
      assert.equal(arrival.content.acceptEventId, grantCmc.acceptEventId,
        'CN39: acceptEventId must match the accepter\'s own grant');
    });
  });
});
