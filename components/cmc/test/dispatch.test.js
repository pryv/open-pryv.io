/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — orchestration dispatch loop tests.
 *
 * [CMCDISP] covers dispatch() + createDispatchMiddleware() against fake
 * mall + fetch.
 */

const assert = require('node:assert/strict');
const { dispatch, createDispatchMiddleware } = require('../src/dispatch.ts');
const { assertEventUpdateShape, assertOutboundUrl } = require('./_fake-assertions.cjs');

function fakeMall () {
  const calls = { eventsUpdated: [], accessesCreated: [], accessesDeleted: [] };
  return {
    calls,
    accesses: {
      async create (userId, params) {
        calls.accessesCreated.push({ userId, ...params });
        return {
          id: 'acc-' + (calls.accessesCreated.length),
          token: 'tok',
          apiEndpoint: 'https://tok-grant@recipient.example.com/',
          ...params,
        };
      },
      async delete (userId, params) { calls.accessesDeleted.push({ userId, ...params }); },
    },
    events: {
      async update (userId, params) {
        assertEventUpdateShape(params);
        calls.eventsUpdated.push({ userId, ...params });
      },
      async create () { return { event: { id: 'ne' } }; },
    },
    streams: {
      async create () { return { id: 's' }; },
    },
  };
}

function fakeFetch (responses) {
  const calls = [];
  let idx = 0;
  return {
    fetch (url, init) {
      assertOutboundUrl(url, init);
      calls.push({ url, init });
      const spec = Array.isArray(responses) ? responses[idx++] : responses;
      if (spec instanceof Error) return Promise.reject(spec);
      return Promise.resolve({
        status: spec.status,
        ok: spec.status >= 200 && spec.status < 300,
        async json () { return spec.body; },
        async text () { return JSON.stringify(spec.body); },
      });
    },
    calls,
  };
}

const SELF = { username: 'alice', host: 'recipient.example.com' };
const VALID_OFFER = {
  id: 'evt-offer',
  type: 'consent/request-cmc',
  content: {
    request: {
      title: { en: 'Example' },
      description: { en: 'desc' },
      consent: { en: 'I agree' },
      permissions: [{ streamId: 'fertility', level: 'read' }],
    },
    requesterMeta: { username: 'provider-a', appId: 'example-app' },
    capabilityId: 'cap-x',
  },
};

describe('[CMCDISP] cmc/dispatch', () => {
  describe('[CMCDISP-D] dispatch() type-routing', () => {
    it('[CD01] skips events without a cmc/ type prefix', async () => {
      const r = await dispatch({
        userId: 'u1',
        event: { id: 'e1', type: 'note/txt', content: 'x' },
        deps: makeDeps({}),
      });
      assert.equal(r.handled, false);
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'not-cmc-event');
    });

    it('[CD02] skips consent/request-cmc (handled by capability-mint hook elsewhere)', async () => {
      const r = await dispatch({
        userId: 'u1',
        event: { id: 'e1', type: 'consent/request-cmc', content: { capabilityRequested: true } },
        deps: makeDeps({}),
      });
      assert.equal(r.handled, false);
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'request-handled-elsewhere');
    });

    it('[CD03] returns skipped for non-CMC event types', async () => {
      // After the class/format rename, types are looked up against the
      // exact ALL_EVENT_TYPES set (not by prefix), so any unrecognised
      // type lands in the same "not-cmc-event" branch — including
      // app-defined types under our shared classes (`consent/foo`,
      // `notification/bar`).
      const r = await dispatch({
        userId: 'u1',
        event: { id: 'e1', type: 'consent/never-defined-v9', content: {} },
        deps: makeDeps({}),
      });
      assert.equal(r.handled, false);
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'not-cmc-event');
    });
  });

  describe('[CMCDISP-A] dispatch routes consent/accept-cmc → handleAccept', () => {
    it('[CD04] happy path: stamps delivered then completed', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-accept',
          type: 'consent/accept-cmc',
          content: { capabilityUrl: 'https://Tok@example.com/' },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.handled, true);
      assert.equal(r.status, 'completed');
      // Mall: 2 events.update — one to 'delivered', one to 'completed'
      assert.equal(mall.calls.eventsUpdated.length, 2);
      assert.equal(mall.calls.eventsUpdated[0].content.status, 'delivered');
      assert.equal(mall.calls.eventsUpdated[1].content.status, 'completed');
      assert.equal(mall.calls.eventsUpdated[1].content.dataGrantAccessId, 'acc-1');
      // Dispatch must stamp the resolved REQUESTER identity (returned by
      // handleAccept as `requesterIdentity`) onto `content.from` of the
      // completed-update. listAcceptedRelationships on the accepter side
      // reads this to identify the counterparty for each row — without
      // it the mapper falls back to `content.acceptedBy` (the accepter's
      // own data-grant apiEndpoint).
      assert.deepEqual(mall.calls.eventsUpdated[1].content.from, { username: 'provider-a', host: 'example.com' });
    });

    it('[CD05] failed delivery → stamps failed with reason + detail', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 400, body: { error: 'bad' } }, // 4xx delivery → handler rolls back
      ]);
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-accept',
          type: 'consent/accept-cmc',
          content: { capabilityUrl: 'https://Tok@example.com/' },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.handled, true);
      assert.equal(r.status, 'failed');
      assert.equal(r.reason, 'cmc-handler-delivery-rejected');
      const updates = mall.calls.eventsUpdated;
      assert.equal(updates[updates.length - 1].content.status, 'failed');
      assert.equal(updates[updates.length - 1].content.failure.reason, 'cmc-handler-delivery-rejected');
      // Rollback triggered
      assert.equal(mall.calls.accessesDeleted.length, 1);
    });

    it('[CD06] handler throws → caught and surfaced as failed', async () => {
      const mall = fakeMall();
      mall.accesses.create = async () => { throw new Error('mall-down'); };
      const { fetch } = fakeFetch([{ status: 200, body: { events: [VALID_OFFER] } }]);
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-accept',
          type: 'consent/accept-cmc',
          content: { capabilityUrl: 'https://Tok@example.com/' },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.status, 'failed');
      assert.equal(r.reason, 'cmc-handler-data-grant-create-failed');
    });
  });

  describe('[CMCDISP-INB] dispatch routes consent/accept-cmc on :_cmc:inbox → handleIncomingAccept', () => {
    it('[CD11] inbox-direction routes to handleIncomingAccept (mints back-channel + provisions anchors)', async () => {
      const mall = fakeMall();
      // Stub events.get so handleIncomingAccept's resolveRequestScope
      // can find the request event by id.
      mall.events.get = async () => [{
        id: 'orig-req-1',
        type: 'consent/request-cmc',
        streamIds: [':_cmc:apps:my-app:campaign-2026'],
      }];
      const { fetch } = fakeFetch({ status: 200, body: {} });
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-incoming-accept',
          type: 'consent/accept-cmc',
          streamIds: [':_cmc:inbox'],
          content: {
            grantedAccess: { apiEndpoint: 'https://granted-tok@accepter.pryv.me/' },
            from: { username: 'alice', host: 'pryv.me' },
            originalEventId: 'orig-req-1',
          },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.handled, true);
      assert.equal(r.status, 'completed');
      // Back-channel access minted (mall.accesses.create called once)
      assert.equal(mall.calls.accessesCreated.length, 1);
      const acc = mall.calls.accessesCreated[0];
      assert.equal(acc.clientData.cmc.role, 'counterparty');
      assert.equal(acc.clientData.cmc.appCode, 'my-app');
      // Trigger's content gets the backChannelAccessId stamped on completion
      const completedUpdate = mall.calls.eventsUpdated.find((u) => u.content.status === 'completed');
      assert.ok(completedUpdate != null);
      assert.equal(completedUpdate.content.backChannelAccessId, 'acc-1');
      assert.ok(Array.isArray(completedUpdate.content.anchorStreamIds));
    });

    it('[CD12] app-stream direction still routes to handleAccept', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-local-accept',
          type: 'consent/accept-cmc',
          streamIds: [':_cmc:apps:my-app:campaign-2026'],
          content: { capabilityUrl: 'https://Tok@example.com/' },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.status, 'completed');
      // handleAccept ran (data-grant created, NOT a back-channel)
      assert.equal(mall.calls.accessesCreated.length, 1);
      // dataGrantAccessId field (handleAccept shape) — confirms routing.
      const completedUpdate = mall.calls.eventsUpdated.find((u) => u.content.status === 'completed');
      assert.ok(completedUpdate != null);
      assert.equal(completedUpdate.content.dataGrantAccessId, 'acc-1');
    });
  });

  describe('[CMCDISP-R] dispatch routes consent/refuse-cmc → handleRefuse', () => {
    it('[CD07] happy path: refuse completes', async () => {
      const mall = fakeMall();
      // handleRefuse now reads the offer first for capabilityId,
      // then POSTs the refuse — so two fetch responses.
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: {} },
      ]);
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-refuse',
          type: 'consent/refuse-cmc',
          content: { capabilityUrl: 'https://Tok@example.com/', reason: { en: 'no' } },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.status, 'completed');
    });
  });

  describe('[CMCDISP-LOOP] loop-avoidance via createdBy → counterparty access check', () => {
    function mallWithCounterpartyAccess (accessId) {
      const m = fakeMall();
      m.accesses.get = async () => [{
        id: accessId,
        clientData: { cmc: { role: 'counterparty' } },
      }];
      return m;
    }
    function mallWithUserAccess (accessId) {
      const m = fakeMall();
      m.accesses.get = async () => [{
        id: accessId,
        type: 'app',
        clientData: {}, // no cmc role
      }];
      return m;
    }

    for (const { type, label } of [
      { type: 'message/chat-cmc', label: 'chat' },
      { type: 'notification/alert-cmc', label: 'alert' },
      { type: 'notification/ack-cmc', label: 'ack' },
      { type: 'consent/scope-request-cmc', label: 'scope-request' },
      { type: 'consent/scope-update-cmc', label: 'scope-update' },
      { type: 'consent/revoke-cmc', label: 'revoke' },
    ]) {
      it('[CDL01-' + label + '] skips ' + type + ' when createdBy resolves to a counterparty access', async () => {
        const mall = mallWithCounterpartyAccess('acc-peer');
        const r = await dispatch({
          userId: 'u1',
          event: {
            id: 'e-' + label,
            type,
            content: { from: { username: 'peer', host: 'peer.example.com' } },
            streamIds: [':_cmc:apps:my-app:chats:peer--peer-example-com'],
            createdBy: 'acc-peer',
          },
          deps: makeDeps({ mall }),
        });
        assert.equal(r.handled, true);
        assert.equal(r.status, 'skipped');
        assert.equal(r.reason, 'cmc-incoming-from-peer');
      });
    }

    it('[CDL02] does NOT skip when createdBy resolves to a non-counterparty (user-originated) access', async () => {
      const mall = mallWithUserAccess('acc-app');
      // We're not really exercising the handler here — just verifying the
      // dispatch DOES proceed past the loop-avoidance guard. Use a refuse
      // event with no capabilityUrl so the handler returns ok:false on a
      // shape error rather than POSTing.
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'e-x',
          type: 'consent/refuse-cmc',
          content: {},
          streamIds: [':_cmc:apps:my-app'],
          createdBy: 'acc-app',
        },
        deps: makeDeps({ mall }),
      });
      // Refuse with no capabilityUrl hits the handler's shape check;
      // dispatch marks failed. The point: status is NOT 'skipped' with
      // reason 'cmc-incoming-from-peer'.
      assert.notEqual(r.reason, 'cmc-incoming-from-peer');
    });

    it('[CDL03] does NOT skip when event lacks createdBy (defensive)', async () => {
      const mall = fakeMall();
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'e-no-creator',
          type: 'message/chat-cmc',
          content: { content: 'hi' },
          streamIds: [':_cmc:apps:my-app:chats:peer--peer-com'],
          // no createdBy
        },
        deps: makeDeps({ mall }),
      });
      // Falls into handleChat which fails on missing access lookup —
      // point is reason isn't the loop-avoidance one.
      assert.notEqual(r.reason, 'cmc-incoming-from-peer');
    });

    it('[CDL04] lifecycle types (accept/refuse/back-channel/request) are exempt from the guard (their dispatch is direction-aware via isOnInbox)', async () => {
      const mall = mallWithCounterpartyAccess('acc-peer');
      // ET_REQUEST is handled-elsewhere; ET_BACK_CHANNEL is incoming-only;
      // ET_ACCEPT routes via isOnInbox. None should hit the loop guard.
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'e-req',
          type: 'consent/request-cmc',
          content: {},
          streamIds: [':_cmc:apps:my-app'],
          createdBy: 'acc-peer',
        },
        deps: makeDeps({ mall }),
      });
      assert.equal(r.reason, 'request-handled-elsewhere');
    });
  });

  describe('[CMCDISP-MW] createDispatchMiddleware (fire-and-forget)', () => {
    it('[CD08] kicks off dispatch without awaiting; calls next() immediately', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const mw = createDispatchMiddleware(makeDeps({ mall, fetch }));
      let nextCalled = false;
      mw(
        { user: { id: 'u1' } },
        {},
        { event: { id: 'evt-refuse', type: 'consent/refuse-cmc', content: { capabilityUrl: 'https://Tok@example.com/' } } },
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, true);
      // Wait for the async dispatch to settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Should have stamped delivered + completed
      assert.ok(mall.calls.eventsUpdated.length >= 1);
    });

    it('[CD09] passes through non-cmc events without firing dispatch', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const mw = createDispatchMiddleware(makeDeps({ mall, fetch }));
      let nextCalled = false;
      mw(
        { user: { id: 'u1' } },
        {},
        { event: { id: 'e1', type: 'note/txt', content: 'x' } },
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(mall.calls.eventsUpdated.length, 0);
    });

    it('[CD10] notifyEventChanged fires per status-flip (delivered + completed)', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 201, body: {} }, // refuse delivery (no offer-read needed)
      ]);
      const notifies = [];
      const baseDeps = makeDeps({ mall, fetch });
      const mw = createDispatchMiddleware(baseDeps, (_ctx) => ({
        notifyEventChanged: (userId, event) => notifies.push({ userId, eventId: event.id }),
      }));
      mw(
        { user: { id: 'u1', username: 'alice' } },
        {},
        { event: { id: 'evt-refuse', type: 'consent/refuse-cmc', content: { capabilityUrl: 'https://Tok@example.com/' } } },
        () => {}
      );
      await new Promise((resolve) => setTimeout(resolve, 15));
      // delivered + completed → 2 notifies
      assert.equal(notifies.length >= 2, true);
      for (const n of notifies) {
        assert.equal(n.userId, 'u1');
        assert.equal(n.eventId, 'evt-refuse');
      }
    });
  });
});

function makeDeps ({ mall, fetch }) {
  return {
    mall: mall || fakeMall(),
    fetch: fetch || fakeFetch({ status: 200, body: {} }).fetch,
    selfIdentityFor: () => SELF,
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
  };
}
