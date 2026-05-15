/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleIncomingBackChannel tests.
 *
 * [CMCBC] covers the accepter-side handler for `cmc/back-channel-v1`
 * events arriving on `:_cmc:inbox`. The handler updates the data-grant
 * access's clientData with the requester's apiEndpoint + remote
 * stream-ids so accepter-side chat / system handlers can resolve a
 * remote endpoint to POST to.
 */

const assert = require('node:assert/strict');
const { handleIncomingBackChannel } = require('../src/handleIncomingBackChannel.ts');

function fakeMall (initialAccesses, capture = {}) {
  capture.updates = capture.updates || [];
  return {
    accesses: {
      async get () { return initialAccesses; },
      async update (_userId, params) {
        capture.updates.push(params);
        return { id: params.id, ...params.update };
      },
    },
  };
}

describe('[CMCBC] cmc/handleIncomingBackChannel', () => {
  it('[BC01] updates the data-grant matching the from-counterparty', async () => {
    const accesses = [
      {
        id: 'unrelated',
        clientData: { cmc: { role: 'capability' } },
      },
      {
        id: 'data-grant-1',
        clientData: {
          cmc: {
            role: 'counterparty',
            counterparty: { username: 'alice', host: 'pryv.me' },
            offerEventId: 'offer-1',
            backChannelApiEndpoint: null,
          },
        },
      },
    ];
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'cmc/back-channel-v1',
        content: {
          from: { username: 'alice', host: 'pryv.me' },
          apiEndpoint: 'https://tok@pryv.me/alice/',
          remoteChatStreamId: ':_cmc:apps:my-app:chats:bob--example-com',
          remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:bob--example-com',
          appCode: 'my-app',
        },
      },
      deps: { mall: fakeMall(accesses, capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'data-grant-1');
    assert.equal(capture.updates.length, 1);
    const upd = capture.updates[0].update.clientData.cmc;
    assert.equal(upd.counterparty.apiEndpoint, 'https://tok@pryv.me/alice/');
    assert.equal(upd.counterparty.remoteChatStreamId,
      ':_cmc:apps:my-app:chats:bob--example-com');
    assert.equal(upd.counterparty.remoteCollectorStreamId,
      ':_cmc:apps:my-app:collectors:bob--example-com');
    assert.equal(upd.backChannelApiEndpoint, 'https://tok@pryv.me/alice/');
    // Existing fields like offerEventId are preserved.
    assert.equal(upd.offerEventId, 'offer-1');
  });

  it('[BC02] matches host by slug (port + dots normalised)', async () => {
    const accesses = [
      {
        id: 'data-grant-1',
        clientData: {
          cmc: {
            role: 'counterparty',
            // host stored without port
            counterparty: { username: 'alice', host: 'pryv.me' },
          },
        },
      },
    ];
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'cmc/back-channel-v1',
        content: {
          // from carries the same host with a port — slugifyHost strips it
          from: { username: 'alice', host: 'pryv.me:443' },
          apiEndpoint: 'https://tok@pryv.me/alice/',
        },
      },
      deps: { mall: fakeMall(accesses, capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(capture.updates.length, 1);
  });

  it('[BC03] when appCode is supplied, only matches accesses with same appCode', async () => {
    const accesses = [
      {
        id: 'wrong-app',
        clientData: {
          cmc: {
            role: 'counterparty',
            appCode: 'other-app',
            counterparty: { username: 'alice', host: 'pryv.me' },
          },
        },
      },
      {
        id: 'right-app',
        clientData: {
          cmc: {
            role: 'counterparty',
            appCode: 'my-app',
            counterparty: { username: 'alice', host: 'pryv.me' },
          },
        },
      },
    ];
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'cmc/back-channel-v1',
        content: {
          from: { username: 'alice', host: 'pryv.me' },
          apiEndpoint: 'https://tok@pryv.me/alice/',
          appCode: 'my-app',
        },
      },
      deps: { mall: fakeMall(accesses, capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'right-app');
  });

  it('[BC04] returns ok:false when no matching data-grant is found', async () => {
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'cmc/back-channel-v1',
        content: {
          from: { username: 'unknown', host: 'pryv.me' },
          apiEndpoint: 'https://tok@pryv.me/alice/',
        },
      },
      deps: { mall: fakeMall([]) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-data-grant-not-found');
  });

  it('[BC05] returns ok:false when content.from is missing', async () => {
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: { type: 'cmc/back-channel-v1', content: { apiEndpoint: 'x' } },
      deps: { mall: fakeMall([]) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-from-missing');
  });

  it('[BC06] returns ok:false when content.apiEndpoint is missing', async () => {
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'cmc/back-channel-v1',
        content: { from: { username: 'alice', host: 'pryv.me' } },
      },
      deps: { mall: fakeMall([]) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-no-apiendpoint');
  });

  it('[BC07] rejects non-back-channel event types', async () => {
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: { type: 'cmc/accept-v1', content: {} },
      deps: { mall: fakeMall([]) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-wrong-type');
  });
});
