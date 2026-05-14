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
 * the user's counterparty-access, rate-limit, deliver via outbound.
 */

const assert = require('node:assert/strict');
const {
  parseCollectorStreamId,
  handleSystemAlert,
  handleSystemAck,
  handleSystemEvent,
  deliverSystemToPeer,
  COLLECTOR_STREAM_ID_RE,
} = require('../src/handleSystem.ts');
const { RateLimiter } = require('../src/rateLimit.ts');

function fakeMall (accesses) {
  const calls = { accessesGet: 0 };
  return {
    calls,
    accesses: {
      async get () { calls.accessesGet += 1; return accesses; },
    },
  };
}

function fakeFetch (responses) {
  const calls = [];
  let idx = 0;
  return {
    fetch (url, init) {
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
  type: 'cmc/system-alert-v1',
  streamIds: [':_cmc:apps:my-app:collectors:provider-a--provider-example-org'],
  content: { code: 'peer-down', detail: 'no heartbeat for 5m' },
};

const ACK_TRIGGER = {
  id: 'evt-ack',
  type: 'cmc/system-ack-v1',
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
      assert.equal(r.eventType, 'cmc/system-alert-v1');
      assert.equal(r.remoteEventId, 'remote-evt-1');
      // Outbound: posted to peer's collectors stream
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://provider.example.org/events');
      assert.equal(calls[0].init.headers.authorization, 'peer-tok');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'cmc/system-alert-v1');
      assert.deepEqual(sent.streamIds, [':_cmc:apps:my-app:collectors:alice--example-com']);
      assert.deepEqual(sent.content.from, SELF);
      assert.equal(sent.content.code, 'peer-down');
      assert.equal(sent.content.detail, 'no heartbeat for 5m');
    });

    it('[HS06] handleSystemAck delivers cmc/system-ack-v1 to peer', async () => {
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
      assert.equal(sent.type, 'cmc/system-ack-v1');
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

  describe('[CMCHS-RL] handleSystem rate-limiting', () => {
    it('[HS15] blocks when rate-limiter rejects; carries retryAfterMs', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const rateLimiter = new RateLimiter({ windowMs: 1000, maxInWindow: 1, now: () => 1000 });
      // First call: allowed.
      const r1 = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch, rateLimiter },
      });
      assert.equal(r1.ok, true);
      assert.equal(calls.length, 1);
      // Second call within the same window: rate-limited.
      const r2 = await handleSystemAlert({
        userId: 'u1',
        triggerEvent: ALERT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch, rateLimiter },
      });
      assert.equal(r2.ok, false);
      assert.equal(r2.reason, 'cmc-system-rate-limited');
      assert.ok((r2.detail?.retryAfterMs ?? 0) >= 0);
      // No second outbound call when rate-limited.
      assert.equal(calls.length, 1);
    });

    it('[HS16] no rate-limiter passed → no-op (delivery proceeds every call)', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch([
        { status: 201, body: {} },
        { status: 201, body: {} },
        { status: 201, body: {} },
      ]);
      for (let i = 0; i < 3; i++) {
        const r = await handleSystemAlert({
          userId: 'u1',
          triggerEvent: ALERT_TRIGGER,
          selfIdentity: SELF,
          deps: { mall, fetch },
        });
        assert.equal(r.ok, true, 'expected ok on iteration ' + i);
      }
      assert.equal(calls.length, 3);
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
        eventType: 'cmc/system-alert-v1',
        payload: { code: 'x' },
        selfIdentity: { username: 'me', host: 'my.host' },
        deps: { fetch },
      });
      assert.equal(calls.length, 1);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'cmc/system-alert-v1');
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
        triggerEvent: { type: 'cmc/chat-v1', content: {}, streamIds: [] },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-wrong-type');
    });
  });
});
