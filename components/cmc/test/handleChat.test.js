/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleChat tests.
 *
 * [CMCHC] covers the message/chat-cmc trigger pipeline: parse chat stream-id,
 * resolve counterparty-access, deliver to peer.
 */

const assert = require('node:assert/strict');
const { handleChat } = require('../src/handleChat.ts');
const { assertOutboundUrl } = require('./_fake-assertions.cjs');

function fakeMall (accesses) {
  return {
    accesses: {
      async get () { return accesses; },
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
        remoteChatStreamId: ':_cmc:apps:my-app:chats:alice--example-com',
      },
    },
  },
};

const CHAT_TRIGGER = {
  id: 'evt-chat',
  type: 'message/chat-cmc',
  streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
  content: { content: 'hello there' },
};

describe('[CMCHC] cmc/handleChat', () => {
  describe('[CMCHC-OK] handleChat happy path', () => {
    it('[HC01] resolves counterparty-access and POSTs message/chat-cmc to peer', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'r1' } } });
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.eventType, 'message/chat-cmc');
      assert.equal(r.remoteEventId, 'r1');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://provider.example.org/events');
      assert.equal(calls[0].init.headers.authorization, 'peer-tok');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'message/chat-cmc');
      assert.deepEqual(sent.streamIds, [':_cmc:apps:my-app:chats:alice--example-com']);
      assert.equal(sent.content.content, 'hello there');
      assert.deepEqual(sent.content.from, SELF);
    });
  });

  describe('[CMCHC-FAIL] handleChat failure paths', () => {
    it('[HC02] rejects wrong trigger type', async () => {
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: { type: 'notification/alert-cmc', content: {}, streamIds: [] },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-wrong-type');
    });

    it('[HC03] surfaces "not a chat stream" when streamIds carry no chat id', async () => {
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: { ...CHAT_TRIGGER, streamIds: [':_cmc:apps:my-app:collectors:provider-a--provider-example-org'] },
        selfIdentity: SELF,
        deps: { mall: fakeMall([COUNTERPARTY_ACCESS]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-chat-stream-not-chat');
    });

    it('[HC04] surfaces counterparty-access-not-found', async () => {
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-chat-counterparty-access-not-found');
    });

    it('[HC05] surfaces counterparty-access-not-found when appCode mismatches', async () => {
      const wrong = {
        ...COUNTERPARTY_ACCESS,
        clientData: { cmc: { ...COUNTERPARTY_ACCESS.clientData.cmc, appCode: 'different' } },
      };
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([wrong]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-chat-counterparty-access-not-found');
    });

    it('[HC06] surfaces "no-remote-apiendpoint" when missing on the access', async () => {
      const acc = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            counterparty: {
              ...COUNTERPARTY_ACCESS.clientData.cmc.counterparty,
              apiEndpoint: undefined,
            },
          }
        },
      };
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([acc]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-chat-no-remote-apiendpoint');
    });

    it('[HC07] surfaces "no-remote-chat-stream" when missing on the access', async () => {
      const acc = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            counterparty: {
              ...COUNTERPARTY_ACCESS.clientData.cmc.counterparty,
              remoteChatStreamId: undefined,
            },
          }
        },
      };
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([acc]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-chat-no-remote-chat-stream');
    });

    it('[HC08] surfaces delivery-failed on peer 5xx', async () => {
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: {
          mall: fakeMall([COUNTERPARTY_ACCESS]),
          fetch: fakeFetch({ status: 503, body: { error: 'down' } }).fetch,
        },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-failed');
      assert.equal(r.detail.status, 503);
    });
  });

  describe('[CMCHC-FEAT] Phase 2.2 features gating', () => {
    // Plan 68 Phase 2.2: `features.chat: false` on the counterparty
    // access is binding. handleChat rejects the send so the offer's
    // negotiated feature contract isn't a silent no-op.

    it('[HC09] rejects send with cmc-chat-disabled when access.clientData.cmc.features.chat === false', async () => {
      const chatDisabledAccess = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            features: { chat: false, systemMessaging: true },
          },
        },
      };
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([chatDisabledAccess]), fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-chat-disabled');
      assert.equal(r.detail.accessId, 'acc-back-channel');
      // No outbound POST when feature is gated.
      assert.equal(calls.length, 0);
    });

    it('[HC10] permits send when features.chat === true (binding contract is honored)', async () => {
      const chatEnabledAccess = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...COUNTERPARTY_ACCESS.clientData.cmc,
            features: { chat: true, systemMessaging: false },
          },
        },
      };
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'r-permit' } } });
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([chatEnabledAccess]), fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
    });

    it('[HC11] permits send when features field is absent on the access (default-permit)', async () => {
      // Backward-compat: pre-Phase-2.2 accesses don't carry features.
      // Default to permissive so existing relationships continue to work.
      // (The locked design says "enforce on ALL relationships" but
      // null/undefined features means "no flag was set" — distinct from
      // explicit `false`.)
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'r-permit' } } });
      const r = await handleChat({
        userId: 'u1',
        triggerEvent: CHAT_TRIGGER,
        selfIdentity: SELF,
        deps: { mall: fakeMall([COUNTERPARTY_ACCESS]), fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
    });
  });
});
