/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — accessesDeleteHook tests.
 *
 * [CMCDH] covers the accesses.delete post-hook: when a CMC relationship
 * access is removed via the api-server route (generic "connected apps"
 * UI, admin cleanup, …), the hook forwards a `consent/revoke-cmc` to
 * the counterparty's :_cmc:inbox so the revocation is observable
 * regardless of the path that performed it.
 */

const assert = require('node:assert/strict');
const { createAccessesDeletePostHook } = require('../src/accessesDeleteHook.ts');
const { validateRevoke } = require('../src/validators.ts');
const { assertOutboundUrl } = require('./_fake-assertions.cjs');

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

// Requester-side relationship access (back-channel): peer path stored
// on counterparty.apiEndpoint.
const REQUESTER_SIDE_ACCESS = {
  id: 'acc-back-channel',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'counterparty',
      appCode: 'my-app',
      counterparty: {
        username: 'bob',
        host: 'peer.example.org',
        apiEndpoint: 'https://peer-tok@peer.example.org/',
      },
    },
  },
};

// Accepter-side relationship access (data-grant) minted before the
// back-channel mirror existed: peer path only on backChannelApiEndpoint.
const ACCEPTER_SIDE_LEGACY_ACCESS = {
  id: 'acc-data-grant',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'counterparty',
      appCode: 'my-app',
      counterparty: { username: 'alice', host: 'peer.example.org' },
      offerEventId: 'evt-offer-1',
      acceptEventId: 'evt-accept-1',
      backChannelApiEndpoint: 'https://bc-tok@peer.example.org/',
    },
  },
};

const PLAIN_ACCESS = { id: 'acc-plain', type: 'shared', clientData: {} };

describe('[CMCDH] cmc/accessesDeleteHook', () => {
  it('[DH01] forwards consent/revoke-cmc to the peer inbox for a deleted relationship access', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(results.length, 1);
    assert.equal(results[0].attempted, true);
    assert.equal(results[0].peerNotified, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/peer\.example\.org\/events$/);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.type, 'consent/revoke-cmc');
    assert.deepEqual(sent.streamIds, [':_cmc:inbox']);
    assert.equal(sent.content.accessId, 'acc-back-channel');
    assert.equal(sent.content.appCode, 'my-app');
  });

  it('[DH02] delivered content passes the receiving side\'s revoke schema', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    await hook('u1', [REQUESTER_SIDE_ACCESS]);
    const sent = JSON.parse(calls[0].init.body);
    const v = validateRevoke(sent.content);
    assert.equal(v.valid, true, 'peer-side validateRevoke must accept the payload: ' + JSON.stringify(v.errors));
  });

  it('[DH03] falls back to backChannelApiEndpoint and carries correlation event ids', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);

    assert.equal(results[0].peerNotified, true);
    assert.match(calls[0].url, /^https:\/\/peer\.example\.org\/events$/);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.content.accessId, 'acc-data-grant');
    assert.equal(sent.content.offerEventId, 'evt-offer-1');
    assert.equal(sent.content.acceptEventId, 'evt-accept-1');
  });

  it('[DH04] skips non-CMC accesses without any outbound call', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [PLAIN_ACCESS]);

    assert.equal(results.length, 1);
    assert.equal(results[0].attempted, false);
    assert.equal(results[0].reason, 'not-a-cmc-relationship-access');
    assert.equal(calls.length, 0);
  });

  it('[DH05] skips (with warn) when no peer apiEndpoint is stored', async () => {
    const warned = [];
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({
      fetch,
      logger: { warn: (msg) => warned.push(msg) },
    });
    const noEndpoint = {
      id: 'acc-incomplete',
      clientData: { cmc: { role: 'counterparty', counterparty: { username: 'x', host: 'y.example.org' } } },
    };
    const results = await hook('u1', [noEndpoint]);

    assert.equal(results[0].attempted, false);
    assert.equal(results[0].reason, 'no-peer-apiendpoint');
    assert.equal(calls.length, 0);
    assert.equal(warned.length, 1);
  });

  it('[DH06] processes a mixed batch (cascade): notifies for each relationship access only', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [PLAIN_ACCESS, REQUESTER_SIDE_ACCESS, ACCEPTER_SIDE_LEGACY_ACCESS]);

    assert.equal(results.length, 3);
    assert.equal(calls.length, 2);
    const sentIds = calls.map((c) => JSON.parse(c.init.body).content.accessId).sort();
    assert.deepEqual(sentIds, ['acc-back-channel', 'acc-data-grant']);
  });

  it('[DH07] reports peerNotified=false on delivery failure without throwing', async () => {
    const { fetch } = fakeFetch({ status: 503, body: { error: 'down' } });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(results[0].attempted, true);
    assert.equal(results[0].peerNotified, false);
    assert.equal(results[0].peerDeliveryStatus, 503);
  });

  it('[DH08] survives a network error (fetch rejects) without throwing', async () => {
    const { fetch } = fakeFetch(new Error('ECONNREFUSED'));
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(results[0].attempted, true);
    assert.equal(results[0].peerNotified, false);
  });
});
