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

// Tests run with override-config.yml's `service.api: http://127.0.0.1:3000/{username}/`
// (path-based username routing). The capability URL the api-server stamps on
// minted accesses therefore has host `127.0.0.1:3000` and the username in
// the path. The shim matches that host exactly and forwards path + query.
const TEST_API_HOSTS = new Set(['127.0.0.1:3000', 'localhost:3000']);
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Build a fetch shim that routes URLs whose host matches the in-process
 * api-server (127.0.0.1:3000 by default) through the supertest agent.
 * Other URLs (rqlite at :4001, pryv.github.io for data-types) pass
 * through to the original fetch.
 */
function buildFetchShim (originalFetch, app) {
  return async function shim (url, init) {
    let u;
    try { u = new URL(url); } catch (_e) { return originalFetch(url, init); }
    if (!TEST_API_HOSTS.has(u.host)) return originalFetch(url, init);
    const path = u.pathname + (u.search || '');
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
      // Test override-config has `service.api: http://127.0.0.1:3000/{username}/`
      // so cmcSelfIdentityFor returns host '127.0.0.1:3000' for all users.
      // slugifyHost strips the port → '127-0-0-1'.
      const TEST_HOST = '127.0.0.1:3000';
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

  describe('[CMCHS-IDEMP] accept re-delivery idempotency', function () {
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
