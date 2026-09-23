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
      async update (userId, params, _transaction, opts) {
        assertEventUpdateShape(params);
        calls.eventsUpdated.push({ userId, ...params, _opts: opts });
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
      // Stub events.getOne so handleIncomingAccept's resolveRequestScope
      // can find the request event by id.
      mall.events.getOne = async (_userId, id) => (id === 'orig-req-1'
        ? { id: 'orig-req-1', type: 'consent/request-cmc', streamIds: [':_cmc:apps:my-app:campaign-2026'] }
        : null);
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

  describe('[CMCDISP-CRED] the completed trigger carries no usable credential', () => {
    // The trigger lives in the user's own `:_cmc:apps:<app-code>` stream:
    // an app (typically the requester's) can hold `read` on it, and every
    // export of the account carries it. Neither the data-grant endpoint nor
    // the invite URL may be stored there with its token.
    it('[CD17] accept: acceptedBy keeps the host, drops the token, and capabilityUrl is stripped', async () => {
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
      assert.equal(r.status, 'completed');
      const completed = mall.calls.eventsUpdated[mall.calls.eventsUpdated.length - 1].content;
      assert.equal(completed.status, 'completed');
      // The access the fake mall minted is
      // `https://tok-grant@recipient.example.com/` — the host survives, the
      // token does not.
      assert.deepEqual(completed.acceptedBy, { apiEndpoint: 'https://recipient.example.com/' });
      assert.equal(completed.capabilityUrl, 'https://example.com/');
      // The bookkeeping the record actually needs is still there.
      assert.equal(completed.dataGrantAccessId, 'acc-1');
      assert.equal(JSON.stringify(completed).includes('tok-grant'), false);
      assert.equal(JSON.stringify(completed).includes('Tok@'), false);
    });

    it('[CD21] back-channel: the inbox record keeps its routing fields but not the peer token', async () => {
      // The requester POSTs this into the ACCEPTER's :_cmc:inbox, which apps
      // poll by design and an export includes. `apiEndpoint` is the
      // REQUESTER's back-channel token; the handler has already copied it onto
      // the data-grant access clientData, which is the copy everything uses.
      const mall = fakeMall();
      // handleIncomingBackChannel looks up the data-grant access by
      // counterparty, then updates its clientData.
      mall.accesses.get = async () => [{
        id: 'grant-1',
        clientData: {
          cmc: {
            role: 'counterparty',
            counterparty: { username: 'provider-a', host: 'example.com' },
          },
        },
      }];
      const accessUpdates = [];
      mall.accesses.update = async (userId, params) => {
        accessUpdates.push(params);
        return { id: 'grant-1' };
      };

      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-bc',
          type: 'consent/back-channel-cmc',
          streamIds: [':_cmc:inbox'],
          content: {
            from: { username: 'provider-a', host: 'example.com' },
            apiEndpoint: 'https://BackChanTok@provider.example.com/',
            remoteChatStreamId: ':_cmc:apps:my-app:chats:provider-a',
            remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:provider-a',
            appCode: 'my-app',
          },
        },
        deps: makeDeps({ mall }),
      });
      assert.equal(r.status, 'completed', JSON.stringify(r));

      const stored = mall.calls.eventsUpdated[mall.calls.eventsUpdated.length - 1].content;
      assert.equal(stored.apiEndpoint, 'https://provider.example.com/');
      assert.equal(JSON.stringify(stored).includes('BackChanTok'), false,
        'the peer back-channel token leaked into the inbox record: ' + JSON.stringify(stored));
      // The fields the record is actually read for survive.
      assert.equal(stored.remoteChatStreamId, ':_cmc:apps:my-app:chats:provider-a');
      assert.equal(stored.remoteCollectorStreamId, ':_cmc:apps:my-app:collectors:provider-a');
      assert.deepEqual(stored.from, { username: 'provider-a', host: 'example.com' });

      // The ordering this fix depends on: the HANDLER still received the usable
      // token and put it on the data-grant access, which is where chat, system
      // and revoke read it from. Only the stored EVENT loses it.
      const grantUpdate = accessUpdates.find((u) => u.id === 'grant-1');
      assert.ok(grantUpdate != null, 'the handler must update the data-grant access');
      assert.equal(
        grantUpdate.update.clientData.cmc.counterparty.apiEndpoint,
        'https://BackChanTok@provider.example.com/',
        'the access clientData must keep the usable endpoint: ' + JSON.stringify(grantUpdate.update.clientData));

      // No write of this event, at ANY status, may carry the token — the
      // 'delivered' stamp is immediately followed by a change notification.
      for (const u of mall.calls.eventsUpdated) {
        assert.equal(JSON.stringify(u.content).includes('BackChanTok'), false,
          'a status stamp stored the peer token: ' + JSON.stringify(u.content));
      }
    });

    it('[CD20] every status stamp skips versioning, so no history row keeps what was scrubbed', async () => {
      // Under versioning.forceKeepHistory a version row snapshots the
      // PRE-update content. Without skipVersioning the 'delivered' stamp
      // would archive the token the app posted, and the 'completed' stamp
      // would archive it again, putting it back within reach of
      // events.getOne?includeHistory=true.
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      await dispatch({
        userId: 'u1',
        event: {
          id: 'evt-accept',
          type: 'consent/accept-cmc',
          content: { capabilityUrl: 'https://Tok@example.com/' },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.ok(mall.calls.eventsUpdated.length >= 2);
      for (const u of mall.calls.eventsUpdated) {
        assert.equal(u._opts?.skipVersioning, true,
          'trigger status stamp must skip versioning, got: ' + JSON.stringify(u._opts));
      }
    });

    it('[CD18] refuse: the spent capabilityUrl is stripped too', async () => {
      const mall = fakeMall();
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
      const completed = mall.calls.eventsUpdated[mall.calls.eventsUpdated.length - 1].content;
      assert.equal(completed.capabilityUrl, 'https://example.com/');
    });

    it('[CD19] a FAILED trigger is scrubbed too, while the retry keeps the full URL in its own snapshot', async () => {
      // A failure is not a reason to keep the token: a failed single-use
      // accept leaves the requester's capability UNCONSUMED, so the invite URL
      // stored on the trigger is still live. The retry path is unaffected
      // because it re-dispatches from `originalContent` in
      // :_cmc:_internal:retries, snapshotted before this write, never from
      // the stored trigger.
      const mall = fakeMall();
      // Record what the retry queue snapshots (fakeMall's create is generic).
      const created = [];
      const baseCreate = mall.events.create;
      mall.events.create = async (userId, params) => {
        created.push(params);
        return baseCreate(userId, params);
      };
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 500, body: { error: 'peer down' } }, // retryable → enqueues
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
      assert.equal(r.status, 'failed');

      const failed = mall.calls.eventsUpdated[mall.calls.eventsUpdated.length - 1].content;
      assert.equal(failed.status, 'failed');
      assert.equal(failed.capabilityUrl, 'https://example.com/');
      assert.equal(JSON.stringify(failed).includes('Tok@'), false);

      const retry = created.find((e) => e.streamIds?.includes(':_cmc:_internal:retries'));
      assert.ok(retry != null, 'a retryable failure must enqueue a retry: ' + JSON.stringify(created));
      assert.equal(retry.content.originalContent.capabilityUrl, 'https://Tok@example.com/',
        'the retry re-dispatches from this snapshot, so it must keep the usable URL');
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

    it('[CDL01-callerid] skips when createdBy carries a callerId suffix', async () => {
      // MethodContext stamps `<accessId> <callerId>` whenever the caller
      // supplied a callerId. Comparing the whole string against the access id
      // never matches, so the loop-avoidance guard would wave the event
      // through and the two accounts would ping-pong it.
      const mall = mallWithCounterpartyAccess('acc-peer');
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'e-callerid',
          type: 'message/chat-cmc',
          content: { from: { username: 'peer', host: 'peer.example.com' } },
          streamIds: [':_cmc:apps:my-app:chats:peer--peer-example-com'],
          createdBy: 'acc-peer some-caller-id',
        },
        deps: makeDeps({ mall }),
      });
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'cmc-incoming-from-peer');
    });

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

  describe('[CMCDISP-IREV] incoming peer revoke: skipped AND the invite marked revoked', () => {
    // A peer-delivered consent/revoke-cmc must stay a no-outbound skip
    // (loop-safety), but still run the LOCAL work: delete the peer's access
    // and, on the requester side, mark the single-use invite revoked.
    const SUBJECT = { username: 'peer', host: 'peer.example.com' };

    function mallForIncomingRevoke (capId) {
      const m = fakeMall();
      const cpAccess = {
        id: 'acc-peer',
        clientData: { cmc: { role: 'counterparty', capabilityId: capId, inviteEventId: 'invite-' + capId, counterparty: SUBJECT } },
      };
      const list = [cpAccess];
      const invite = { id: 'invite-' + capId, type: 'consent/request-cmc', content: { status: 'accepted' } };
      m.accesses.get = async () => list;
      m.accesses.delete = async (userId, params) => {
        const i = list.findIndex((x) => x.id === params.id);
        if (i >= 0) list.splice(i, 1);
        m.calls.accessesDeleted.push(params.id);
      };
      m.events.getOne = async (userId, id) => (id === invite.id ? invite : null);
      const update = m.events.update;
      m.events.update = async (userId, params) => {
        if (params.id === invite.id) Object.assign(invite, params);
        return update(userId, params);
      };
      m.calls.accessesDeleted = [];
      m._invite = () => invite;
      m._accessIds = () => list.map((a) => a.id);
      return m;
    }

    it('[CD15] still returns skipped:cmc-incoming-from-peer AND marks the invite revoked', async () => {
      const mall = mallForIncomingRevoke('cap-d');
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'e-incoming-revoke',
          type: 'consent/revoke-cmc',
          content: { from: SUBJECT },
          streamIds: [':_cmc:inbox'],
          createdBy: 'acc-peer',
        },
        deps: makeDeps({ mall }),
      });
      assert.equal(r.handled, true);
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'cmc-incoming-from-peer');
      assert.equal(mall._invite().content.status, 'revoked');
      // ... and the peer's access on this account is gone, which is what
      // actually enforces the withdrawal.
      assert.deepEqual(mall.calls.accessesDeleted, ['acc-peer']);
      assert.equal(mall._accessIds().includes('acc-peer'), false);
    });

    it('[CDL06] an inbox revoke keeps taking the incoming path once its createdBy access is gone', async () => {
      // Re-dispatch of the same inbox event after the teardown (retry loop,
      // operator re-processing). `createdBy` no longer resolves, so the
      // peer-delivered test alone would let it fall through to handleRevoke
      // with the peer's foreign content.accessId and mark the withdrawal
      // 'failed' — which an app reads as "the revocation did not work".
      const mall = mallForIncomingRevoke('cap-e');
      await mall.accesses.delete('u1', { id: 'acc-peer' });
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'e-incoming-revoke-again',
          type: 'consent/revoke-cmc',
          content: { from: SUBJECT, accessId: 'peer-side-id-we-do-not-hold' },
          streamIds: [':_cmc:inbox'],
          createdBy: 'acc-peer',
        },
        deps: makeDeps({ mall }),
      });
      assert.equal(r.status, 'skipped');
      assert.equal(r.reason, 'cmc-incoming-from-peer');
      assert.notEqual(r.status, 'failed');
    });

    it('[CDL07] a user-originated revoke on an app-scope stream still reaches handleRevoke', async () => {
      // Regression guard for the inbox routing above: it must not swallow the
      // ordinary case where the account holder revokes through the helper.
      const mall = fakeMall();
      mall.accesses.get = async () => [{ id: 'acc-app', type: 'app', clientData: {} }];
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'e-user-revoke',
          type: 'consent/revoke-cmc',
          content: {},
          streamIds: [':_cmc:apps:my-app:study-a:collectors:peer--peer-com'],
          createdBy: 'acc-app',
        },
        deps: makeDeps({ mall }),
      });
      assert.notEqual(r.reason, 'cmc-incoming-from-peer');
    });
  });

  describe('[CMCDISP-REQ] a request trigger is never written by dispatch', () => {
    it('[CD16] no delivered stamp, so an outcome written on the invite cannot be overwritten', async () => {
      const mall = fakeMall();
      const r = await dispatch({
        userId: 'u1',
        event: { id: 'inv-9', type: 'consent/request-cmc', streamIds: [':_cmc:apps:my-app'], content: { status: 'accepted' } },
        deps: makeDeps({ mall }),
      });
      assert.equal(r.reason, 'request-handled-elsewhere');
      assert.deepEqual(mall.calls.eventsUpdated, []);
    });
  });

  describe('[CMCDISP-IREF] incoming refuse is recorded on the invite', () => {
    function mallWithCapability (mode) {
      const m = fakeMall();
      const invite = { id: 'invite-r', type: 'consent/request-cmc', content: { status: 'delivered', ...(mode ? { capability: { mode } } : {}) } };
      m.accesses.get = async () => [{
        id: 'cap-acc-r',
        clientData: { cmc: { kind: 'capability', capabilityId: 'cap-r', requestEventId: 'invite-r', capability: { mode: mode || 'single-use', state: 'open' } } },
      }];
      m.events.getOne = async (userId, id) => (id === invite.id ? invite : null);
      const update = m.events.update;
      m.events.update = async (userId, params) => {
        if (params.id === invite.id) Object.assign(invite, params);
        return update(userId, params);
      };
      m._invite = () => invite;
      return m;
    }
    const arrival = (content) => ({
      id: 'evt-refuse-in',
      type: 'consent/refuse-cmc',
      streamIds: [':_cmc:_internal:responses:cap-r'],
      createdBy: 'cap-acc-r',
      content: { from: { username: 'bob', host: 'b.example.com' }, capabilityId: 'cap-r', capabilityUrl: 'https://example.com/', ...content },
    });

    it('[CD13] a refuse on a responses stream completes and marks the single-use invite refused', async () => {
      const mall = mallWithCapability();
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await dispatch({ userId: 'u1', event: arrival({ reason: { en: 'no' } }), deps: makeDeps({ mall, fetch }) });
      assert.equal(r.status, 'completed');
      assert.equal(calls.length, 0, 'an incoming refuse issues no outbound call');
      const invite = mall._invite();
      assert.equal(invite.content.status, 'refused');
      assert.equal(invite.content.refusedBy.username, 'bob');
      assert.deepEqual(invite.content.reason, { en: 'no' });
    });

    it('[CD14] an open-link invite is not changed by one refusal; a refuse without capabilityId fails', async () => {
      const mall = mallWithCapability('open-link');
      const r = await dispatch({ userId: 'u1', event: arrival({}), deps: makeDeps({ mall }) });
      assert.equal(r.status, 'completed');
      assert.equal(mall._invite().content.status, 'delivered');

      const bad = await dispatch({
        userId: 'u1', event: arrival({ capabilityId: undefined }), deps: { ...makeDeps({ mall }), enqueueRetries: false },
      });
      assert.equal(bad.status, 'failed');
      assert.equal(bad.reason, 'cmc-incoming-refuse-missing-capability-id');
    });
  });

  describe('[CMCDISP-SR] scope request: the completed trigger carries the id the request got on the peer', () => {
    const STREAM = ':_cmc:apps:my-app:collectors:bob--recipient-example-com';
    function mallWithGrant () {
      const mall = fakeMall();
      mall.accesses.get = async () => [{
        id: 'acc-cp',
        type: 'shared',
        clientData: {
          cmc: {
            role: 'counterparty',
            appCode: 'my-app',
            counterparty: {
              username: 'bob',
              host: 'recipient.example.com',
              apiEndpoint: 'https://tok@recipient.example.com/',
              remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:alice--recipient-example-com',
            },
          },
        },
      }];
      return mall;
    }

    it('[CDSR1] stamps content.remoteEventId from the peer response on completion', async () => {
      const mall = mallWithGrant();
      const { fetch } = fakeFetch({ status: 201, body: { event: { id: 'remote-req-1' } } });
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'req-local',
          type: 'consent/scope-request-cmc',
          streamIds: [STREAM],
          content: { newPermissions: [{ streamId: 'steps', level: 'read' }] },
        },
        deps: makeDeps({ mall, fetch }),
      });
      assert.equal(r.status, 'completed');
      const last = mall.calls.eventsUpdated[mall.calls.eventsUpdated.length - 1];
      assert.equal(last.content.status, 'completed');
      assert.equal(last.content.remoteEventId, 'remote-req-1');
    });

    it('[CDSR3] a scope update applied but not delivered is persisted failed with its applied record', async () => {
      const STREAM_A = STREAM;
      const mall = mallWithGrant();
      const grants = await mall.accesses.get();
      grants[0].permissions = [{ streamId: STREAM_A, level: 'contribute' }];
      mall.accesses.get = async () => grants;
      mall.accesses.update = async () => ({});
      const { fetch } = fakeFetch({ status: 400, body: { error: { id: 'nope' } } });
      const r = await dispatch({
        userId: 'u1',
        event: {
          id: 'su-1',
          type: 'consent/scope-update-cmc',
          streamIds: [STREAM_A],
          content: { accessId: 'acc-cp', newPermissions: [{ streamId: 'steps', level: 'read' }] },
        },
        deps: Object.assign(makeDeps({ mall, fetch }), { enqueueRetries: false }),
      });
      assert.equal(r.status, 'failed');
      const last = mall.calls.eventsUpdated[mall.calls.eventsUpdated.length - 1];
      assert.equal(last.content.status, 'failed');
      assert.equal(last.content.applied, true);
      assert.equal(last.content.accessId, 'acc-cp');
      assert.deepEqual(last.content.newPermissions, [{ streamId: 'steps', level: 'read' }]);
    });

    it('[CDSR2] other system events do not get remoteEventId stamped', async () => {
      const mall = mallWithGrant();
      const { fetch } = fakeFetch({ status: 201, body: { event: { id: 'remote-alert-1' } } });
      await dispatch({
        userId: 'u1',
        event: { id: 'al', type: 'notification/alert-cmc', streamIds: [STREAM], content: { code: 'x' } },
        deps: makeDeps({ mall, fetch }),
      });
      const last = mall.calls.eventsUpdated[mall.calls.eventsUpdated.length - 1];
      assert.equal(last.content.status, 'completed');
      assert.equal(last.content.remoteEventId, undefined);
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
