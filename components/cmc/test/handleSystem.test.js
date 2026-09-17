/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleSystemAlert / handleSystemAck handler tests.
 *
 * [CMCHS] covers system-channel routing: parse collector stream-id, find
 * the user's counterparty-access, deliver via outbound.
 */

const assert = require('node:assert/strict');
const {
  parseCollectorStreamId,
  handleSystemAlert,
  handleSystemAck,
  handleSystemScopeRequest,
  handleSystemScopeUpdate,
  handleSystemEvent,
  deliverSystemToPeer,
  COLLECTOR_STREAM_ID_RE,
} = require('../src/handleSystem.ts');
const { assertOutboundUrl } = require('./_fake-assertions.cjs');

function fakeMall (accesses) {
  const calls = { accessesGet: 0, accessesUpdated: [] };
  return {
    calls,
    accesses: {
      async get () { calls.accessesGet += 1; return accesses; },
      async update (userId, params) {
        calls.accessesUpdated.push({ userId, ...params });
        return { id: params.id, ...params.update };
      },
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

const SELF = { username: 'alice', host: 'example.com' };

// Stored access for counterparty "provider-a" on peer "provider.example.org".
const COUNTERPARTY_ACCESS = {
  id: 'acc-back-channel',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'counterparty',
      appCode: 'my-app',
      counterparty: {
        username: 'provider-a',
        host: 'provider.example.org',
        apiEndpoint: 'https://peer-tok@provider.example.org/',
        remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:alice--example-com',
      },
    },
  },
};

const ALERT_TRIGGER = {
  id: 'evt-alert',
  type: 'notification/alert-cmc',
  streamIds: [':_cmc:apps:my-app:collectors:provider-a--provider-example-org'],
  content: { code: 'peer-down', detail: 'no heartbeat for 5m' },
};

const ACK_TRIGGER = {
  id: 'evt-ack',
  type: 'notification/ack-cmc',
  streamIds: [':_cmc:apps:my-app:collectors:provider-a--provider-example-org'],
  content: { ackOf: 'evt-prev-alert' },
};

describe('[CMCHS] cmc/handleSystem', () => {
  describe('[CMCHS-PS] parseCollectorStreamId', () => {
    it('[HS01] parses flat :_cmc:apps:<app>:collectors:<slug>', () => {
      const r = parseCollectorStreamId(':_cmc:apps:my-app:collectors:provider-a--provider-example-org');
      assert.equal(r.appCode, 'my-app');
      assert.equal(r.scopeStreamId, ':_cmc:apps:my-app');
      assert.equal(r.counterpartySlug, 'provider-a--provider-example-org');
      assert.deepEqual(r.counterparty, { username: 'provider-a', hostSlug: 'provider-example-org' });
    });

    it('[HS02] parses nested path :_cmc:apps:<app>:<path>:collectors:<slug>', () => {
      const r = parseCollectorStreamId(':_cmc:apps:my-app:campaign-2026:collectors:provider-a--provider-example-org');
      assert.equal(r.appCode, 'my-app');
      assert.equal(r.scopeStreamId, ':_cmc:apps:my-app:campaign-2026');
    });

    it('[HS03] returns null for non-collector streams', () => {
      assert.equal(parseCollectorStreamId(':_cmc:apps:my-app:chats:foo--bar'), null);
      assert.equal(parseCollectorStreamId(':_cmc:inbox'), null);
      assert.equal(parseCollectorStreamId('arbitrary-stream'), null);
    });

    it('[HS04] returns null for malformed counterparty slug', () => {
      assert.equal(parseCollectorStreamId(':_cmc:apps:my-app:collectors:no-separator'), null);
    });
  });

  describe('[CMCHS-OK] handleSystemAlert / handleSystemAck happy paths', () => {
    it('[HS05] handleSystemAlert delivers to peer collectors stream with from-stamp', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'remote-evt-1' } } });
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.eventType, 'notification/alert-cmc');
      assert.equal(r.remoteEventId, 'remote-evt-1');
      // Outbound: posted to peer's collectors stream
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://provider.example.org/events');
      assert.equal(calls[0].init.headers.authorization, 'peer-tok');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'notification/alert-cmc');
      assert.deepEqual(sent.streamIds, [':_cmc:apps:my-app:collectors:alice--example-com']);
      assert.deepEqual(sent.content.from, SELF);
      assert.equal(sent.content.code, 'peer-down');
      assert.equal(sent.content.detail, 'no heartbeat for 5m');
    });

    it('[HS06] handleSystemAck delivers notification/ack-cmc to peer', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'remote-evt-2' } } });
      const r = await handleSystemAck({
        userId: 'u1',
        triggerEvent: ACK_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'notification/ack-cmc');
      assert.equal(sent.content.ackOf, 'evt-prev-alert');
    });
  });

  describe('[CMCHS-FAIL] handleSystem failure paths', () => {
    it('[HS07] rejects wrong trigger type from each entrypoint', async () => {
      const r1 = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: { ...ACK_TRIGGER },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r1.ok, false);
      assert.equal(r1.reason, 'cmc-handler-wrong-type');
      const r2 = await handleSystemAck({
        userId: 'u1',
        triggerEvent: { ...ALERT_TRIGGER },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r2.ok, false);
      assert.equal(r2.reason, 'cmc-handler-wrong-type');
    });

    it('[HS08] surfaces "not a collector stream" when streamIds carry no collector id', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch } = fakeFetch({});
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: { ...ALERT_TRIGGER, streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'] },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-system-stream-not-collector');
    });

    it('[HS09] surfaces "counterparty access not found" when no match', async () => {
      const mall = fakeMall([]); // no accesses
      const { fetch } = fakeFetch({});
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-system-counterparty-access-not-found');
    });

    it('[HS10] surfaces "counterparty access not found" when appCode mismatches', async () => {
      const wrongAppAccess = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            appCode: 'different-app',
          },
        },
      };
      const mall = fakeMall([wrongAppAccess]);
      const { fetch } = fakeFetch({});
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-system-counterparty-access-not-found');
    });

    it('[HS11] surfaces "no-remote-apiendpoint" when the access lacks the back-channel URL', async () => {
      const acc = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            counterparty: {
              ...COUNTERPARTY_ACCESS.clientData.cmc.counterparty,
              apiEndpoint: undefined,
            },
          },
        },
      };
      const mall = fakeMall([acc]);
      const { fetch } = fakeFetch({});
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-system-no-remote-apiendpoint');
    });

    it('[HS12] surfaces "no-remote-collector-stream" when the access lacks the peer stream-id', async () => {
      const acc = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            counterparty: {
              ...COUNTERPARTY_ACCESS.clientData.cmc.counterparty,
              remoteCollectorStreamId: undefined,
            },
          },
        },
      };
      const mall = fakeMall([acc]);
      const { fetch } = fakeFetch({});
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-system-no-remote-collector-stream');
    });

    it('[HS13] surfaces "delivery-failed" on peer 5xx', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch } = fakeFetch({ status: 503, body: { error: 'down' } });
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-failed');
      assert.equal(r.detail.status, 503);
      assert.equal(r.detail.peerReason, 'http-5xx');
    });

    it('[HS14] surfaces "delivery-threw" when fetch rejects', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch } = fakeFetch(new Error('boom'));
      // outbound.postToPeer catches and returns reason='network' rather than
      // throwing; the handler's own throw-catch isn't exercised here. So
      // surface as a delivery-failed not delivery-threw — verify we got a
      // non-ok result with a network reason.
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-failed');
      assert.equal(r.detail.peerReason, 'network');
    });
  });

  describe('[CMCHS-NPE] nested paths', () => {
    it('[HS17] routes through a per-request-scoped collector stream', async () => {
      const nestedTrigger = {
        ...ALERT_TRIGGER,
        streamIds: [':_cmc:apps:my-app:campaign-2026:collectors:provider-a--provider-example-org'],
      };
      // Access stores remoteCollectorStreamId; the requester's scope just
      // controls outbound routing — peer's stream-id is whatever was
      // recorded at acceptance.
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'r' } } });
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: nestedTrigger,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
    });
  });

  describe('[CMCHS-DSP] deliverSystemToPeer', () => {
    it('[HS18] builds the outbound POST body with from stamp', async () => {
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      await deliverSystemToPeer({
        remoteApiEndpoint: 'https://t@peer.example.com/',
        remoteCollectorStreamId: ':_cmc:apps:p:collectors:me--my-host',
        eventType: 'notification/alert-cmc',
        payload: { code: 'x' },
        selfIdentity: { username: 'me', host: 'my.host' },
        deps: { fetch },
      });
      assert.equal(calls.length, 1);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'notification/alert-cmc');
      assert.equal(sent.content.code, 'x');
      assert.deepEqual(sent.content.from, { username: 'me', host: 'my.host' });
    });
  });

  describe('[CMCHS-RE] regex sanity', () => {
    it('[HS19] regex matches double-hyphen-separated slug', () => {
      assert.ok(COLLECTOR_STREAM_ID_RE.test(':_cmc:apps:a:collectors:foo--bar'));
    });
    it('[HS20] regex rejects ids without the "--" separator', () => {
      // The slug pattern requires a literal `--` between username and host-slug.
      assert.equal(COLLECTOR_STREAM_ID_RE.test(':_cmc:apps:a:collectors:foo-bar'), false);
      assert.equal(COLLECTOR_STREAM_ID_RE.test(':_cmc:apps:a:collectors:noseparator'), false);
    });
  });

  describe('[CMCHS-CORE] handleSystemEvent shared core wrong-type', () => {
    it('[HS21] handleSystemEvent rejects non-system trigger types', async () => {
      const r = await handleSystemEvent({
        userId: 'u1',
        triggerEvent: { type: 'message/chat-cmc', content: {}, streamIds: [] },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-wrong-type');
    });
  });

  describe('[CMCHS-SC] scope-request + scope-update handlers', () => {
    const SCOPE_REQUEST_TRIGGER = {
      id: 'evt-sr',
      type: 'consent/scope-request-cmc',
      streamIds: [':_cmc:apps:my-app:collectors:provider-a--provider-example-org'],
      content: {
        requestedPermissions: [{ streamId: 'fertility', level: 'read' }],
        reason: 'extending study to include fertility tracking',
      },
    };

    const SCOPE_UPDATE_TRIGGER = {
      id: 'evt-su',
      type: 'consent/scope-update-cmc',
      streamIds: [':_cmc:apps:my-app:collectors:provider-a--provider-example-org'],
      content: {
        permissions: [{ streamId: 'fertility', level: 'read' }],
        compositeId: 'acc-back-channel:v2',
        previousCompositeId: 'acc-back-channel:v1',
      },
    };

    // An explicit `accessId` must name the grant serving the trigger's stream.
    const CHANNEL_ACCESS = {
      ...COUNTERPARTY_ACCESS,
      permissions: [{ streamId: SCOPE_UPDATE_TRIGGER.streamIds[0], level: 'contribute' }],
    };

    it('[HS22] handleSystemScopeRequest delivers consent/scope-request-cmc to peer', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'r-sr' } } });
      const r = await handleSystemScopeRequest({
        userId: 'u1',
        triggerEvent: SCOPE_REQUEST_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.eventType, 'consent/scope-request-cmc');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'consent/scope-request-cmc');
      assert.deepEqual(sent.content.from, SELF);
      assert.deepEqual(sent.content.requestedPermissions, [{ streamId: 'fertility', level: 'read' }]);
      assert.equal(sent.content.reason, 'extending study to include fertility tracking');
    });

    it('[HS24] handleSystemScopeRequest rejects mismatched trigger type', async () => {
      const r = await handleSystemScopeRequest({
        userId: 'u1',
        triggerEvent: { ...SCOPE_UPDATE_TRIGGER },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-wrong-type');
    });

    it('[HS25] handleSystemScopeUpdate rejects mismatched trigger type', async () => {
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: { ...SCOPE_REQUEST_TRIGGER },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-wrong-type');
    });

    it('[HS26] local-apply: trigger with accessId+newPermissions calls accesses.update before peer delivery', async () => {
      const mall = fakeMall([CHANNEL_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-back-channel',
          newPermissions: [{ streamId: 'fertility', level: 'read' }],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: trigger,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.applied, true);
      assert.equal(trigger.content.applied, true);
      // Local update fired
      assert.equal(mall.calls.accessesUpdated.length, 1);
      assert.equal(mall.calls.accessesUpdated[0].id, 'acc-back-channel');
      assert.deepEqual(mall.calls.accessesUpdated[0].update.permissions, [
        { streamId: 'fertility', level: 'read' },
        ...CHANNEL_ACCESS.permissions,
      ]);
      // Peer delivery still happened
      assert.equal(calls.length, 1);
    });

    it('[HS27] fails with cmc-scope-update-nothing-to-apply when the trigger names nothing to apply, and notifies no one', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: structuredClone(SCOPE_UPDATE_TRIGGER), // no request ref, no newPermissions
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-scope-update-nothing-to-apply');
      assert.equal(mall.calls.accessesUpdated.length, 0);
      assert.equal(calls.length, 0);
    });

    it('[HS28a] auto-merges CMC-machinery permissions back when caller omits them', async () => {
      // Access with the typical CMC-machinery + one user-facing perm.
      const accessWithMachinery = {
        ...COUNTERPARTY_ACCESS,
        id: 'acc-with-machinery',
        permissions: [
          // User-facing
          { streamId: 'fertility', level: 'read' },
          // CMC machinery (plugin-owned)
          { streamId: ':_cmc:inbox', level: 'create-only' },
          { streamId: ':_cmc:apps:my-app:chats:provider-a--provider-example-org', level: 'contribute' },
          { streamId: ':_cmc:apps:my-app:collectors:provider-a--provider-example-org', level: 'contribute' },
        ],
      };
      const mall = fakeMall([accessWithMachinery]);
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-with-machinery',
          // Caller passes ONLY user-facing perms — omits all :_cmc:* streams.
          // The plugin should auto-merge the machinery back so chat/system
          // delivery doesn't break.
          newPermissions: [
            { streamId: 'fertility', level: 'read' },
            { streamId: 'symptom', level: 'read' }, // new user-facing perm
          ],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1', triggerEvent: trigger, selfIdentity: SELF, deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(mall.calls.accessesUpdated.length, 1);
      const applied = mall.calls.accessesUpdated[0].update.permissions;
      // User-facing perms preserved (caller's new shape)
      const userFacing = applied.filter((p) => !p.streamId.startsWith(':_cmc:'));
      assert.deepEqual(userFacing, [
        { streamId: 'fertility', level: 'read' },
        { streamId: 'symptom', level: 'read' },
      ]);
      // Every machinery perm survives
      const machinery = applied.filter((p) => p.streamId.startsWith(':_cmc:'));
      assert.equal(machinery.length, 3, 'expected all 3 :_cmc:* machinery perms preserved');
      assert.ok(machinery.some((p) => p.streamId === ':_cmc:inbox'));
      assert.ok(machinery.some((p) => p.streamId.endsWith(':chats:provider-a--provider-example-org')));
      assert.ok(machinery.some((p) => p.streamId.endsWith(':collectors:provider-a--provider-example-org')));
    });

    it('[HS28b] caller-supplied :_cmc:* perms are filtered out and replaced with the access\'s current machinery (plugin owns it)', async () => {
      const accessWithMachinery = {
        ...COUNTERPARTY_ACCESS,
        id: 'acc-wm-2',
        permissions: [
          { streamId: ':_cmc:inbox', level: 'create-only' },
          { streamId: ':_cmc:apps:my-app:chats:provider-a--provider-example-org', level: 'contribute' },
          { streamId: ':_cmc:apps:my-app:collectors:provider-a--provider-example-org', level: 'contribute' },
        ],
      };
      const mall = fakeMall([accessWithMachinery]);
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-wm-2',
          newPermissions: [
            { streamId: 'fertility', level: 'read' },
            // Caller tries to TIGHTEN the inbox to read — should be ignored
            { streamId: ':_cmc:inbox', level: 'read' },
          ],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1', triggerEvent: trigger, selfIdentity: SELF, deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      const applied = mall.calls.accessesUpdated[0].update.permissions;
      // The caller-supplied :_cmc:inbox perm at 'read' is dropped; the
      // access's existing 'create-only' is the survivor.
      const inboxPerm = applied.find((p) => p.streamId === ':_cmc:inbox');
      assert.deepEqual(inboxPerm, { streamId: ':_cmc:inbox', level: 'create-only' });
    });

    it('[HS28c] suppression flag is set during mall.accesses.update (post-hook would see isSuppressed===true)', async () => {
      // Verification: when handleSystemScopeUpdate's local-apply
      // runs mall.accesses.update, the post-hook (`accessesUpdateHook`)
      // would also fire and would issue a SECOND outbound notification
      // to the counterparty. To prevent the double-fire, the handler
      // wraps the update in runWithSuppression() — the post-hook then
      // observes isSuppressed() === true and returns {ran:false,
      // reason:'suppressed-by-cmc-handler'} without delivering.
      //
      // We assert this end-to-end here by:
      //  (a) wiring the fake mall.accesses.update to OBSERVE isSuppressed()
      //      at the time of the call,
      //  (b) asserting the observed value was true (handler did wrap),
      //  (c) confirming the handler still issued exactly ONE outbound
      //      delivery (its own — not duplicated by the post-hook path).
      const { isSuppressed } = require('../src/accessesUpdateHook.ts');
      let observedSuppression = null;
      const mall = fakeMall([CHANNEL_ACCESS]);
      const origUpdate = mall.accesses.update;
      mall.accesses.update = async function (userId, params) {
        observedSuppression = isSuppressed();
        return origUpdate(userId, params);
      };
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-back-channel',
          newPermissions: [{ streamId: 'fertility', level: 'read' }],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: trigger,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(observedSuppression, true,
        'mall.accesses.update should observe isSuppressed()===true during handler local-apply');
      // Exactly one outbound POST — the handler's own notification.
      // (The post-hook would have made a second one if not suppressed.)
      assert.equal(calls.length, 1);
    });

    it('[HS-AUTH-PT] passes the chain check when triggerAccess is personal', async () => {
      const mall = fakeMall([CHANNEL_ACCESS]);
      let updated = false;
      mall.accesses.update = async () => { updated = true; };
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const triggerAccess = { canUpdateAccess: () => true, canCreateAccess: () => true };
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-back-channel',
          newPermissions: [{ streamId: 'fertility', level: 'read' }],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: trigger,
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess },
      });
      assert.equal(r.ok, true);
      assert.equal(updated, true);
    });

    it('[HS-AUTH-NUP] rejects with cmc-insufficient-permissions when canUpdateAccess is false', async () => {
      const mall = fakeMall([CHANNEL_ACCESS]);
      let updated = false;
      mall.accesses.update = async () => { updated = true; };
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const triggerAccess = { canUpdateAccess: () => false, canCreateAccess: () => true };
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-back-channel',
          newPermissions: [{ streamId: 'fertility', level: 'read' }],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: trigger,
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-insufficient-permissions');
      assert.equal(r.detail.canUpdate, false);
      assert.equal(updated, false);
    });

    it('[HS-AUTH-NCR] rejects with cmc-insufficient-permissions when canCreateAccess is false (cannot grant the proposed perms)', async () => {
      const mall = fakeMall([CHANNEL_ACCESS]);
      let updated = false;
      mall.accesses.update = async () => { updated = true; };
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const triggerAccess = { canUpdateAccess: () => true, canCreateAccess: () => false };
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-back-channel',
          newPermissions: [{ streamId: 'fertility', level: 'read' }],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: trigger,
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-insufficient-permissions');
      assert.equal(r.detail.canGrant, false);
      assert.equal(updated, false);
    });

    it('[HS-AUTH-SKIP] passes through when triggerAccess is absent (unit-test mocked deps)', async () => {
      const mall = fakeMall([CHANNEL_ACCESS]);
      let updated = false;
      mall.accesses.update = async () => { updated = true; };
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-back-channel',
          newPermissions: [{ streamId: 'fertility', level: 'read' }],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: trigger,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(updated, true);
    });

    it('[HS28] local-apply failure surfaces as cmc-scope-update-local-apply-failed', async () => {
      const mall = fakeMall([CHANNEL_ACCESS]);
      mall.accesses.update = async () => { throw new Error('access-update-fail'); };
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const trigger = {
        ...SCOPE_UPDATE_TRIGGER,
        content: {
          ...SCOPE_UPDATE_TRIGGER.content,
          accessId: 'acc-back-channel',
          newPermissions: [{ streamId: 'x', level: 'read' }],
        },
      };
      const r = await handleSystemScopeUpdate({
        userId: 'u1',
        triggerEvent: trigger,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-scope-update-local-apply-failed');
      assert.equal(r.detail.accessId, 'acc-back-channel');
      assert.equal(trigger.content.applied, undefined, 'a failed apply must not be recorded as applied');
    });
  });

  describe('[CMCHS-SR] scope-update answering a collector request', () => {
    const STREAM_A = ':_cmc:apps:my-app:collectors:provider-a--provider-example-org';
    const STREAM_B = ':_cmc:apps:my-app:collectors:provider-b--provider-example-org';
    const MACHINERY_A = [
      { streamId: ':_cmc:inbox', level: 'create-only' },
      { streamId: ':_cmc:apps:my-app:chats:provider-a--provider-example-org', level: 'contribute' },
      { streamId: STREAM_A, level: 'contribute' },
    ];

    function grant (id, username, collectorStream, machinery) {
      return {
        id,
        type: 'shared',
        permissions: [{ streamId: 'fertility', level: 'read' }, ...machinery],
        clientData: {
          cmc: {
            role: 'counterparty',
            appCode: 'my-app',
            scopeStreamId: ':_cmc:apps:my-app',
            counterparty: {
              username,
              host: 'provider.example.org',
              apiEndpoint: 'https://peer-tok@provider.example.org/',
              remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:alice--example-com',
            },
          },
        },
      };
    }
    const GRANT_A = grant('acc-grant-a', 'provider-a', STREAM_A, MACHINERY_A);
    const GRANT_B = grant('acc-grant-b', 'provider-b', STREAM_B, [{ streamId: STREAM_B, level: 'contribute' }]);
    const PERSONAL = { id: 'acc-personal', type: 'personal', permissions: [] };

    function request (overrides = {}) {
      return {
        id: 'req-1',
        type: 'consent/scope-request-cmc',
        streamIds: [STREAM_A],
        createdBy: 'acc-grant-a caller-x',
        content: {
          newPermissions: [{ streamId: 'fertility', level: 'read' }, { streamId: 'steps', level: 'read' }],
        },
        ...overrides,
      };
    }

    function answer (content, streamIds = [STREAM_A]) {
      return { id: 'ans-1', type: 'consent/scope-update-cmc', streamIds, content };
    }

    function mallWith (accesses, events) {
      const mall = fakeMall(accesses);
      mall.calls.eventsUpdated = [];
      mall.events = {
        async getOne (_userId, id) { return events.find((e) => e.id === id) ?? null; },
        async update (_userId, event) { mall.calls.eventsUpdated.push(event); return event; },
      };
      return mall;
    }

    async function run (trigger, mall, fetchSpec = { status: 201, body: { event: { id: 'r-1' } } }) {
      const { fetch, calls } = fakeFetch(fetchSpec);
      const r = await handleSystemScopeUpdate({ userId: 'u1', triggerEvent: trigger, selfIdentity: SELF, deps: { mall, fetch } });
      return { r, calls };
    }

    it('[HS32] applies the request\'s permission set to the grant that sent it, keeps machinery, records the outcome', async () => {
      const mall = mallWith([GRANT_A, GRANT_B], [request()]);
      const trigger = answer({ scopeRequestEventId: 'req-1', accept: true });
      const { r, calls } = await run(trigger, mall);
      assert.equal(r.ok, true);
      assert.equal(r.applied, true);
      assert.equal(mall.calls.accessesUpdated.length, 1);
      const upd = mall.calls.accessesUpdated[0];
      assert.equal(upd.id, 'acc-grant-a');
      assert.deepEqual(upd.update.permissions, [
        { streamId: 'fertility', level: 'read' },
        { streamId: 'steps', level: 'read' },
        ...MACHINERY_A,
      ]);
      assert.equal(trigger.content.applied, true);
      assert.equal(trigger.content.accessId, 'acc-grant-a');
      assert.deepEqual(trigger.content.newPermissions.map((p) => p.streamId), ['fertility', 'steps']);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.content.accept, true);
      assert.equal(sent.content.applied, true);
      assert.deepEqual(sent.content.newPermissions.map((p) => p.streamId), ['fertility', 'steps']);
      const requestWrites = mall.calls.eventsUpdated.filter((e) => e.id === 'req-1');
      assert.equal(requestWrites.length, 1);
      assert.equal(requestWrites[0].content.status, 'accepted');
      assert.equal(requestWrites[0].content.responseEventId, 'ans-1');
    });

    it('[HS33] refuses a request written by a non-counterparty access (e.g. the user) with cmc-scope-request-not-from-peer', async () => {
      const mall = mallWith([GRANT_A, PERSONAL], [request({ createdBy: 'acc-personal' })]);
      const { r, calls } = await run(answer({ scopeRequestEventId: 'req-1', accept: true }), mall);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-scope-request-not-from-peer');
      assert.equal(mall.calls.accessesUpdated.length, 0);
      assert.equal(calls.length, 0);
    });

    it('[HS34] refuses a request whose creator grant serves another relationship (no cross-peer widening)', async () => {
      // Written by B's grant but sitting on A's collectors stream.
      const mall = mallWith([GRANT_A, GRANT_B], [request({ createdBy: 'acc-grant-b' })]);
      const { r, calls } = await run(answer({ scopeRequestEventId: 'req-1', accept: true }), mall);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-scope-request-not-from-peer');
      assert.equal(mall.calls.accessesUpdated.length, 0);
      assert.equal(calls.length, 0);
    });

    it('[HS35] refuses an answer written on a different collectors stream than the request', async () => {
      const mall = mallWith([GRANT_A, GRANT_B], [request()]);
      const { r } = await run(answer({ scopeRequestEventId: 'req-1', accept: true }, [STREAM_B]), mall);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-scope-request-stream-mismatch');
      assert.equal(mall.calls.accessesUpdated.length, 0);
    });

    it('[HS36] unknown id, trashed request, or an id naming another event type: cmc-scope-request-not-found', async () => {
      const events = [
        request({ id: 'chat-1', type: 'message/chat-cmc' }),
        request({ id: 'trashed-1', trashed: true }),
      ];
      for (const id of ['nope', 'chat-1', 'trashed-1']) {
        const mall = mallWith([GRANT_A], events);
        const { r } = await run(answer({ scopeRequestEventId: id, accept: true }), mall);
        assert.equal(r.ok, false, id);
        assert.equal(r.reason, 'cmc-scope-request-not-found', id);
        assert.equal(mall.calls.accessesUpdated.length, 0, id);
      }
    });

    it('[HS37] refuses an expired request; an unexpired one proceeds', async () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const future = Math.floor(Date.now() / 1000) + 3600;
      const expired = mallWith([GRANT_A], [request({ content: { ...request().content, expires: past } })]);
      const r1 = await run(answer({ scopeRequestEventId: 'req-1', accept: true }), expired);
      assert.equal(r1.r.reason, 'cmc-scope-request-expired');
      assert.equal(expired.calls.accessesUpdated.length, 0);
      const live = mallWith([GRANT_A], [request({ content: { ...request().content, expires: future } })]);
      const r2 = await run(answer({ scopeRequestEventId: 'req-1', accept: true }), live);
      assert.equal(r2.r.ok, true);
    });

    it('[HS38] refuses a request answered by another trigger; a re-dispatch of the same trigger proceeds', async () => {
      const answered = mallWith([GRANT_A], [request({ content: { ...request().content, responseEventId: 'other' } })]);
      const r1 = await run(answer({ scopeRequestEventId: 'req-1', accept: true }), answered);
      assert.equal(r1.r.reason, 'cmc-scope-request-already-answered');
      assert.equal(answered.calls.accessesUpdated.length, 0);
      const retry = mallWith([GRANT_A], [request({ content: { ...request().content, responseEventId: 'ans-1' } })]);
      const r2 = await run(answer({ scopeRequestEventId: 'req-1', accept: true }), retry);
      assert.equal(r2.r.ok, true);
      assert.equal(retry.calls.accessesUpdated.length, 1);
    });

    it('[HS39] refusal binds the request, applies nothing, records it and tells the collector', async () => {
      const mall = mallWith([GRANT_A], [request()]);
      const trigger = answer({ scopeRequestEventId: 'req-1', accept: false, reason: { en: 'no' } });
      const { r, calls } = await run(trigger, mall);
      assert.equal(r.ok, true);
      assert.equal(mall.calls.accessesUpdated.length, 0);
      assert.equal(trigger.content.applied, false);
      assert.equal(mall.calls.eventsUpdated[0].content.status, 'refused');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.content.accept, false);
      // A refusal of a request from another relationship is refused too.
      const foreign = mallWith([GRANT_A, GRANT_B], [request({ createdBy: 'acc-grant-b' })]);
      const r2 = await run(answer({ scopeRequestEventId: 'req-1', accept: false }), foreign);
      assert.equal(r2.r.reason, 'cmc-scope-request-not-from-peer');
      assert.equal(r2.calls.length, 0);
    });

    it('[HS40] an answer without an explicit accept applies nothing', async () => {
      const mall = mallWith([GRANT_A], [request()]);
      const { r, calls } = await run(answer({ scopeRequestEventId: 'req-1' }), mall);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-scope-update-nothing-to-apply');
      assert.equal(mall.calls.accessesUpdated.length, 0);
      assert.equal(calls.length, 0);
    });

    it('[HS41] newPermissions without accessId applies to the relationship grant of the trigger stream', async () => {
      const mall = mallWith([GRANT_B, GRANT_A], []);
      const trigger = answer({ newPermissions: [{ streamId: 'sleep', level: 'read' }] });
      const { r } = await run(trigger, mall);
      assert.equal(r.ok, true);
      assert.equal(mall.calls.accessesUpdated.length, 1);
      assert.equal(mall.calls.accessesUpdated[0].id, 'acc-grant-a');
      assert.equal(trigger.content.accessId, 'acc-grant-a');
    });

    it('[HS42] an explicit accessId naming a non-counterparty access is refused', async () => {
      const mall = mallWith([GRANT_A, PERSONAL], []);
      const { r, calls } = await run(answer({ accessId: 'acc-personal', newPermissions: [{ streamId: '*', level: 'manage' }] }), mall);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-scope-update-target-not-counterparty');
      assert.equal(mall.calls.accessesUpdated.length, 0);
      assert.equal(calls.length, 0);
    });

    it('[HS44] the applied record is written to the trigger before the peer is contacted', async () => {
      const mall = mallWith([GRANT_A], [request()]);
      let updatesAtPost = null;
      const { fetch } = fakeFetch({ status: 201, body: { event: { id: 'r' } } });
      const spyFetch = (url, init) => {
        updatesAtPost = mall.calls.eventsUpdated.slice();
        return fetch(url, init);
      };
      const trigger = answer({ scopeRequestEventId: 'req-1', accept: true });
      const r = await handleSystemScopeUpdate({ userId: 'u1', triggerEvent: trigger, selfIdentity: SELF, deps: { mall, fetch: spyFetch } });
      assert.equal(r.ok, true);
      const triggerWrite = updatesAtPost.find((e) => e.id === 'ans-1');
      assert.ok(triggerWrite != null, 'trigger must be written before delivery');
      assert.equal(triggerWrite.content.applied, true);
      assert.equal(triggerWrite.content.accessId, 'acc-grant-a');
    });

    it('[HS45] an explicit accessId must be the grant serving the trigger stream', async () => {
      const mall = mallWith([GRANT_A, GRANT_B], []);
      const { r, calls } = await run(answer({ accessId: 'acc-grant-b', newPermissions: [{ streamId: 'steps', level: 'read' }] }), mall);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-scope-update-target-stream-mismatch');
      assert.equal(mall.calls.accessesUpdated.length, 0);
      assert.equal(calls.length, 0);
    });

    it('[HS46] answering a request ignores accessId / newPermissions supplied by the client', async () => {
      const mall = mallWith([GRANT_A, GRANT_B], [request()]);
      const trigger = answer({
        scopeRequestEventId: 'req-1',
        accept: true,
        accessId: 'acc-grant-b',
        newPermissions: [{ streamId: '*', level: 'manage' }],
      });
      const { r } = await run(trigger, mall);
      assert.equal(r.ok, true);
      assert.equal(mall.calls.accessesUpdated.length, 1);
      assert.equal(mall.calls.accessesUpdated[0].id, 'acc-grant-a');
      assert.ok(!mall.calls.accessesUpdated[0].update.permissions.some((p) => p.streamId === '*'));
      assert.equal(trigger.content.accessId, 'acc-grant-a');
    });

    it('[HS47] a refusal whose delivery fails keeps applied false and the request refused', async () => {
      const mall = mallWith([GRANT_A], [request()]);
      const trigger = answer({ scopeRequestEventId: 'req-1', accept: false });
      const { r } = await run(trigger, mall, { status: 400, body: { error: { id: 'x' } } });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-failed');
      assert.equal(trigger.content.applied, false);
      assert.equal(mall.calls.accessesUpdated.length, 0);
      assert.ok(mall.calls.eventsUpdated.some((e) => e.id === 'req-1' && e.content.status === 'refused'));
    });

    it('[HS43] delivery failure after apply fails the trigger but keeps a truthful applied record', async () => {
      const mall = mallWith([GRANT_A], [request()]);
      const trigger = answer({ scopeRequestEventId: 'req-1', accept: true });
      const { r } = await run(trigger, mall, { status: 400, body: { error: { id: 'x' } } });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-failed');
      assert.equal(mall.calls.accessesUpdated.length, 1);
      assert.equal(trigger.content.applied, true);
      assert.equal(trigger.content.accessId, 'acc-grant-a');
    });
  });

  describe('[CMCHS-FEAT] features.systemMessaging gating', () => {
    // `features.systemMessaging: false` on the counterparty access is
    // binding for user-level system events (alert + ack). Protocol-
    // level events (scope-request, scope-update) are NOT subject to
    // this gate — they govern the relationship itself, not user
    // messaging.

    it('[HS29] rejects notification/alert-cmc with cmc-system-messaging-disabled when features.systemMessaging === false', async () => {
      const smDisabledAccess = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            features: { chat: true, systemMessaging: false },
          },
        },
      };
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([smDisabledAccess]), fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-system-messaging-disabled');
      assert.equal(r.detail.accessId, 'acc-back-channel');
      assert.equal(r.detail.eventType, 'notification/alert-cmc');
      assert.equal(calls.length, 0);
    });

    it('[HS30] rejects notification/ack-cmc with cmc-system-messaging-disabled when features.systemMessaging === false', async () => {
      const smDisabledAccess = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            features: { chat: true, systemMessaging: false },
          },
        },
      };
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleSystemAck({
        userId: 'u1',
        triggerEvent: ACK_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([smDisabledAccess]), fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-system-messaging-disabled');
      assert.equal(r.detail.eventType, 'notification/ack-cmc');
      assert.equal(calls.length, 0);
    });

    it('[HS31] scope-request / scope-update events are NOT gated by features.systemMessaging', async () => {
      // Protocol-level: governance, not user messaging. The relationship
      // can still be updated/revoked even if user-messaging is disabled.
      const smDisabledAccess = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            features: { chat: false, systemMessaging: false },
          },
        },
      };
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'r-permit' } } });
      const scopeRequestTrigger = {
        id: 'evt-scope-req',
        type: 'consent/scope-request-cmc',
        streamIds: [':_cmc:apps:my-app:collectors:provider-a--provider-example-org'],
        content: { newPermissions: [{ streamId: 'fertility', level: 'read' }] },
      };
      const r = await handleSystemScopeRequest({
        userId: 'u1',
        triggerEvent: scopeRequestTrigger,
        selfIdentity: SELF,
        deps: { mall: fakeMall([smDisabledAccess]), fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
    });
  });
});
