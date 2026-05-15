/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — chat orchestration primitive tests.
 *
 * [CMCCO] covers parseChatStreamId + findCounterpartyAccess (+ for-app variant)
 * + deliverChatToPeer.
 */

const assert = require('node:assert/strict');
const {
  parseChatStreamId,
  findCounterpartyAccess,
  findCounterpartyAccessForApp,
  deliverChatToPeer,
} = require('../src/chatOrchestration.ts');

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

function fakeMall (accesses) {
  return { accesses: { async get () { return accesses; } } };
}

describe('[CMCCO] cmc/chatOrchestration', () => {
  describe('[CMCCO-PS] parseChatStreamId', () => {
    it('[CO01] parses flat-under-app: :_cmc:apps:my-app:chats:alice--example-com', () => {
      const r = parseChatStreamId(':_cmc:apps:my-app:chats:alice--example-com');
      assert.deepEqual(r, {
        appCode: 'my-app',
        scopeStreamId: ':_cmc:apps:my-app',
        counterpartySlug: 'alice--example-com',
        counterparty: { username: 'alice', hostSlug: 'example-com' },
      });
    });

    it('[CO02] parses nested-under-path: :_cmc:apps:my-app:study-A:chats:alice--example-com', () => {
      const r = parseChatStreamId(':_cmc:apps:my-app:study-A:chats:alice--example-com');
      assert.deepEqual(r, {
        appCode: 'my-app',
        scopeStreamId: ':_cmc:apps:my-app:study-A',
        counterpartySlug: 'alice--example-com',
        counterparty: { username: 'alice', hostSlug: 'example-com' },
      });
    });

    it('[CO03] returns null for non-chat ids', () => {
      assert.equal(parseChatStreamId(':_cmc:apps:my-app:study-A'), null);
      assert.equal(parseChatStreamId(':_cmc:apps:my-app:collectors:alice--example-com'), null);
      assert.equal(parseChatStreamId(':_cmc:inbox'), null);
      assert.equal(parseChatStreamId('fertility'), null);
    });

    it('[CO04] returns null for malformed slugs', () => {
      assert.equal(parseChatStreamId(':_cmc:apps:my-app:chats:notaslug'), null);
      assert.equal(parseChatStreamId(':_cmc:apps:my-app:chats:Alice--EXAMPLE.com'), null);
    });
  });

  describe('[CMCCO-FA] findCounterpartyAccess', () => {
    it('[CO05] returns the matching counterparty access', async () => {
      const accesses = [
        { id: 'a1', clientData: { cmc: { role: 'counterparty', counterparty: { username: 'bob', host: 'other.example' } } } },
        { id: 'a2', clientData: { cmc: { role: 'counterparty', counterparty: { username: 'alice', host: 'example.com' } } } },
        { id: 'a3', clientData: { cmc: { role: 'capability' } } },
      ];
      const r = await findCounterpartyAccess({
        userId: 'u1',
        counterparty: { username: 'alice', host: 'example.com' },
        mall: fakeMall(accesses),
      });
      assert.equal(r?.id, 'a2');
    });

    it('[CO06] returns null when no match', async () => {
      const accesses = [
        { id: 'a1', clientData: { cmc: { role: 'counterparty', counterparty: { username: 'bob', host: 'other.example' } } } },
      ];
      const r = await findCounterpartyAccess({
        userId: 'u1',
        counterparty: { username: 'alice', host: 'example.com' },
        mall: fakeMall(accesses),
      });
      assert.equal(r, null);
    });

    it('[CO07] ignores accesses without cmc.role=counterparty', async () => {
      const accesses = [
        { id: 'a1', clientData: { cmc: { role: 'capability', counterparty: { username: 'alice', host: 'example.com' } } } },
        { id: 'a2', clientData: { cmc: { role: 'something-else' } } },
        { id: 'a3' }, // no clientData
      ];
      const r = await findCounterpartyAccess({
        userId: 'u1',
        counterparty: { username: 'alice', host: 'example.com' },
        mall: fakeMall(accesses),
      });
      assert.equal(r, null);
    });
  });

  describe('[CMCCO-FA-APP] findCounterpartyAccessForApp', () => {
    it('[CO08] filters by appCode when set on the access', async () => {
      const accesses = [
        { id: 'a1', clientData: { cmc: { role: 'counterparty', appCode: 'study', counterparty: { username: 'alice', host: 'example.com' } } } },
        { id: 'a2', clientData: { cmc: { role: 'counterparty', appCode: 'care', counterparty: { username: 'alice', host: 'example.com' } } } },
      ];
      const r = await findCounterpartyAccessForApp({
        userId: 'u1',
        counterparty: { username: 'alice', host: 'example.com' },
        mall: fakeMall(accesses),
        appCode: 'care',
      });
      assert.equal(r?.id, 'a2');
    });

    it('[CO09] falls through (returns first match) for accesses without appCode set', async () => {
      const accesses = [
        { id: 'a1', clientData: { cmc: { role: 'counterparty', counterparty: { username: 'alice', host: 'example.com' } } } },
      ];
      const r = await findCounterpartyAccessForApp({
        userId: 'u1',
        counterparty: { username: 'alice', host: 'example.com' },
        mall: fakeMall(accesses),
        appCode: 'whatever',
      });
      assert.equal(r?.id, 'a1');
    });
  });

  describe('[CMCCO-DC] deliverChatToPeer', () => {
    it('[CO10] POSTs message/chat-cmc to the remote chat stream with content + from', async () => {
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'r1' } } });
      const r = await deliverChatToPeer({
        remoteApiEndpoint: 'https://Tok@peer.example/',
        remoteChatStreamId: ':_cmc:apps:peer-app:chats:alice--my-host',
        content: 'Hello!',
        selfIdentity: { username: 'alice', host: 'my-host.example' },
        deps: { fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(calls[0].init.method, 'POST');
      const sent = JSON.parse(calls[0].init.body);
      assert.deepEqual(sent.streamIds, [':_cmc:apps:peer-app:chats:alice--my-host']);
      assert.equal(sent.type, 'message/chat-cmc');
      assert.equal(sent.content.content, 'Hello!');
      assert.deepEqual(sent.content.from, { username: 'alice', host: 'my-host.example' });
    });

    it('[CO11] surfaces 4xx as non-retryable', async () => {
      const { fetch } = fakeFetch({ status: 403, body: { error: 'forbidden' } });
      const r = await deliverChatToPeer({
        remoteApiEndpoint: 'https://Tok@peer.example/',
        remoteChatStreamId: ':_cmc:apps:peer-app:chats:alice--my-host',
        content: 'Hello!',
        selfIdentity: { username: 'alice', host: 'my-host.example' },
        deps: { fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'http-4xx');
    });
  });
});
