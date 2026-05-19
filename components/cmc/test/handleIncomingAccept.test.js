/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleIncomingAccept tests.
 *
 * [CMCIA] covers the requester-side flow when a `consent/accept-cmc` lands
 * on :_cmc:inbox: anchor-stream auto-creation + back-channel access mint.
 */

const assert = require('node:assert/strict');
const { handleIncomingAccept, resolveRequestScope } = require('../src/handleIncomingAccept.ts');

function fakeMall (opts = {}) {
  const calls = { streamsCreated: [], accessesCreated: [], eventsGot: 0, eventsCreated: [] };
  const requestEvent = opts.requestEvent;
  return {
    calls,
    accesses: {
      async create (_userId, params) {
        calls.accessesCreated.push(params);
        if (opts.failAccessCreate) throw new Error('access-fail');
        return {
          id: 'acc-back-' + calls.accessesCreated.length,
          apiEndpoint: 'https://back-tok@requester.example.com/',
          ...params,
        };
      },
    },
    events: {
      async get (_userId, _params) {
        calls.eventsGot += 1;
        return requestEvent ? [requestEvent] : [];
      },
      async create (_userId, params) {
        calls.eventsCreated.push(params);
        return { id: 'mirror-' + calls.eventsCreated.length, ...params };
      },
    },
    streams: {
      async create (_userId, params) {
        calls.streamsCreated.push(params);
        if (opts.alreadyExists && opts.alreadyExists.includes(params.id)) {
          const e = new Error('stream-already-exists');
          e.id = 'stream-already-exists';
          throw e;
        }
        if (opts.failStreamCreate && opts.failStreamCreate === params.id) {
          throw new Error('stream-create-fail');
        }
        return { id: params.id };
      },
    },
  };
}

const SELF = { username: 'requester', host: 'example.com' };

const ACCEPT_FROM_INBOX = {
  id: 'evt-accept-in',
  type: 'consent/accept-cmc',
  streamIds: [':_cmc:inbox'],
  content: {
    grantedAccess: { apiEndpoint: 'https://granted-tok@accepter.pryv.me/' },
    from: { username: 'alice', host: 'pryv.me' },
    originalEventId: 'orig-req-1',
  },
};

const ORIGINAL_REQUEST_EVENT = {
  id: 'orig-req-1',
  type: 'consent/request-cmc',
  streamIds: [':_cmc:apps:my-app:campaign-2026'],
  content: { request: {} },
};

describe('[CMCIA] cmc/handleIncomingAccept', () => {
  describe('[CMCIA-OK] happy path', () => {
    it('[IA01] mints a back-channel access + creates 4 anchor streams', async () => {
      const mall = fakeMall({ requestEvent: ORIGINAL_REQUEST_EVENT });
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: ACCEPT_FROM_INBOX,
        selfIdentity: SELF,
        deps: { mall },
      });
      assert.equal(r.ok, true);
      assert.equal(r.backChannelAccessId, 'acc-back-1');
      assert.equal(r.appCode, 'my-app');
      assert.deepEqual(r.counterparty, { username: 'alice', host: 'pryv.me' });
      assert.equal(r.anchorStreamIds.length, 4);
      const streamIds = r.anchorStreamIds;
      assert.ok(streamIds.includes(':_cmc:apps:my-app:campaign-2026:chats'));
      assert.ok(streamIds.includes(':_cmc:apps:my-app:campaign-2026:collectors'));
      assert.ok(streamIds.includes(':_cmc:apps:my-app:campaign-2026:chats:alice--pryv-me'));
      assert.ok(streamIds.includes(':_cmc:apps:my-app:campaign-2026:collectors:alice--pryv-me'));
      // Created access carries the right shape
      const acc = mall.calls.accessesCreated[0];
      assert.equal(acc.type, 'shared');
      assert.equal(acc.clientData.cmc.role, 'counterparty');
      assert.equal(acc.clientData.cmc.appCode, 'my-app');
      assert.deepEqual(acc.clientData.cmc.counterparty, {
        username: 'alice',
        host: 'pryv.me',
        apiEndpoint: 'https://granted-tok@accepter.pryv.me/',
        // Peer mirrors the structure: their chats/collectors stream-ids
        // for OUR slug under the same scope.
        remoteChatStreamId: ':_cmc:apps:my-app:campaign-2026:chats:requester--example-com',
        remoteCollectorStreamId: ':_cmc:apps:my-app:campaign-2026:collectors:requester--example-com',
      });
      // Permissions
      const streamPerms = acc.permissions.map((p) => p.streamId);
      assert.ok(streamPerms.includes(':_cmc:inbox'));
      assert.ok(streamPerms.includes(':_cmc:apps:my-app:campaign-2026:chats:alice--pryv-me'));
      assert.ok(streamPerms.includes(':_cmc:apps:my-app:campaign-2026:collectors:alice--pryv-me'));
    });

    it('[IA02] is idempotent under stream-already-exists', async () => {
      const mall = fakeMall({
        requestEvent: ORIGINAL_REQUEST_EVENT,
        alreadyExists: [
          ':_cmc:apps:my-app:campaign-2026:chats',
          ':_cmc:apps:my-app:campaign-2026:collectors',
        ],
      });
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: ACCEPT_FROM_INBOX,
        selfIdentity: SELF,
        deps: { mall },
      });
      assert.equal(r.ok, true);
      assert.equal(r.anchorStreamIds.length, 4);
    });

    it('[IA02M] mirrors the accept onto :_cmc:inbox with backChannelAccessId + time when arriving from non-inbox stream', async () => {
      // When the accept lands on the per-capability responses stream
      // (`:_cmc:_internal:responses:<capId>` — the path that
      // `deliverAcceptViaCapability` POSTs to from the accepter side),
      // handleIncomingAccept mirrors it onto :_cmc:inbox so the
      // doctor's app sees the accept via the standard inbox
      // subscription. The mirror MUST include:
      //   (a) `backChannelAccessId` — only the requester's plugin
      //       knows this value (it just minted the access). Without
      //       it the doctor's app has no handle to call
      //       `cmc.revokeRelationship({accessId, scopeStreamId})` or
      //       `requestScopeUpdate` later on.
      //   (b) `time` — `mall.events.create` does NOT default time the
      //       way the api-server's events.create method does. An
      //       event with `time: undefined` disappears from
      //       time-ordered queries — including the `sinceTime`
      //       filter `cmc.waitForAccept` uses to find recent accepts.
      const mall = fakeMall({ requestEvent: ORIGINAL_REQUEST_EVENT });
      const acceptFromResponses = {
        ...ACCEPT_FROM_INBOX,
        streamIds: [':_cmc:_internal:responses:cap-xyz'],
        content: {
          ...ACCEPT_FROM_INBOX.content,
          capabilityId: 'cap-xyz',
        },
      };
      const beforeS = Math.floor(Date.now() / 1000) - 1;
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: acceptFromResponses,
        selfIdentity: SELF,
        deps: { mall },
      });
      const afterS = Math.ceil(Date.now() / 1000) + 1;
      assert.equal(r.ok, true);
      assert.equal(mall.calls.eventsCreated.length, 1);
      const mirror = mall.calls.eventsCreated[0];
      assert.deepEqual(mirror.streamIds, [':_cmc:inbox']);
      assert.equal(mirror.type, 'consent/accept-cmc');
      assert.equal(mirror.content.backChannelAccessId, 'acc-back-1');
      // Original content carried through (grantedAccess, from, …)
      assert.deepEqual(mirror.content.from, { username: 'alice', host: 'pryv.me' });
      assert.equal(mirror.content.grantedAccess.apiEndpoint, 'https://granted-tok@accepter.pryv.me/');
      // time is stamped (unix seconds, within a generous window)
      assert.equal(typeof mirror.time, 'number');
      assert.ok(mirror.time >= beforeS && mirror.time <= afterS,
        'mirror.time outside expected window: ' + mirror.time);
    });

    it('[IA02N] does NOT write the mirror when accept already arrives on :_cmc:inbox (e.g. handed off by the inbox write-hook)', async () => {
      const mall = fakeMall({ requestEvent: ORIGINAL_REQUEST_EVENT });
      await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: ACCEPT_FROM_INBOX,
        selfIdentity: SELF,
        deps: { mall },
      });
      assert.equal(mall.calls.eventsCreated.length, 0);
    });

    it('[IA03] falls back to a synthetic scope when request lookup fails', async () => {
      const mall = fakeMall({ requestEvent: null }); // can't find request
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: ACCEPT_FROM_INBOX,
        selfIdentity: SELF,
        deps: { mall },
      });
      assert.equal(r.ok, true);
      assert.equal(r.appCode, 'unknown');
    });
  });

  describe('[CMCIA-FAIL] failure paths', () => {
    it('[IA04] rejects wrong trigger type', async () => {
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: { type: 'message/chat-cmc', content: {}, streamIds: [':_cmc:inbox'] },
        selfIdentity: SELF,
        deps: { mall: fakeMall() },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-incoming-accept-wrong-type');
    });

    it('[IA05] rejects when grantedAccess.apiEndpoint is missing', async () => {
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: { ...ACCEPT_FROM_INBOX, content: { ...ACCEPT_FROM_INBOX.content, grantedAccess: {} } },
        selfIdentity: SELF,
        deps: { mall: fakeMall() },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-incoming-accept-no-granted-apiendpoint');
    });

    it('[IA06] rejects when content.from is missing (would-be-unforgeable identity)', async () => {
      const noFrom = {
        ...ACCEPT_FROM_INBOX,
        content: { grantedAccess: { apiEndpoint: 'https://x@host/' } },
      };
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: noFrom,
        selfIdentity: SELF,
        deps: { mall: fakeMall() },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-incoming-accept-from-missing');
    });

    it('[IA07] surfaces back-channel-create failure', async () => {
      const mall = fakeMall({ requestEvent: ORIGINAL_REQUEST_EVENT, failAccessCreate: true });
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: ACCEPT_FROM_INBOX,
        selfIdentity: SELF,
        deps: { mall },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-incoming-accept-back-channel-create-failed');
    });

    it('[IA08] surfaces anchor-stream-create failure (non-already-exists)', async () => {
      const mall = fakeMall({
        requestEvent: ORIGINAL_REQUEST_EVENT,
        failStreamCreate: ':_cmc:apps:my-app:campaign-2026:chats',
      });
      const r = await handleIncomingAccept({
        userId: 'u1',
        acceptEvent: ACCEPT_FROM_INBOX,
        selfIdentity: SELF,
        deps: { mall },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-incoming-accept-anchor-stream-create-failed');
    });
  });

  describe('[CMCIA-RS] resolveRequestScope', () => {
    it('[IA09] returns appCode + scopeStreamId from the request event', async () => {
      const mall = fakeMall({ requestEvent: ORIGINAL_REQUEST_EVENT });
      const r = await resolveRequestScope({
        userId: 'u1',
        acceptEvent: ACCEPT_FROM_INBOX,
        mall,
      });
      assert.equal(r.appCode, 'my-app');
      assert.equal(r.scopeStreamId, ':_cmc:apps:my-app:campaign-2026');
    });

    it('[IA10] returns nulls when the request event is not findable', async () => {
      const mall = fakeMall({ requestEvent: null });
      const r = await resolveRequestScope({
        userId: 'u1',
        acceptEvent: ACCEPT_FROM_INBOX,
        mall,
      });
      assert.equal(r.appCode, null);
      assert.equal(r.scopeStreamId, null);
    });
  });
});
