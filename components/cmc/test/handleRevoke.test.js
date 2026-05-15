/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleRevoke tests.
 *
 * [CMCHR] covers consent/revoke-cmc handling: pre-acceptance (via capability URL)
 * and acceptance-time (dual accesses.delete + peer notify).
 */

const assert = require('node:assert/strict');
const {
  handleRevoke,
  parseChatsOrCollectorsStreamId,
  findCounterpartyAccess,
  findPairedDataGrant,
} = require('../src/handleRevoke.ts');

function fakeMall (accesses) {
  const calls = { deleted: [], gets: 0 };
  return {
    calls,
    accesses: {
      async get () { calls.gets += 1; return accesses; },
      async delete (userId, params) { calls.deleted.push({ userId, ...params }); },
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
const PEER = { username: 'provider-a', host: 'provider.example.org' };

const COUNTERPARTY_ACCESS = {
  id: 'acc-counterparty',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'counterparty',
      appCode: 'my-app',
      peerAccessId: 'acc-data-grant',
      counterparty: {
        username: 'provider-a',
        host: 'provider.example.org',
        apiEndpoint: 'https://peer-tok@provider.example.org/',
      },
    },
  },
};

const DATA_GRANT_ACCESS = {
  id: 'acc-data-grant',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'data-grant',
      appCode: 'my-app',
      counterparty: {
        username: 'provider-a',
        host: 'provider.example.org',
      },
    },
  },
};

describe('[CMCHR] cmc/handleRevoke', () => {
  describe('[CMCHR-P] parseChatsOrCollectorsStreamId', () => {
    it('[HR01] parses chats streams', () => {
      const r = parseChatsOrCollectorsStreamId(':_cmc:apps:my-app:chats:provider-a--provider-example-org');
      assert.equal(r.appCode, 'my-app');
      assert.equal(r.counterparty.username, 'provider-a');
      assert.equal(r.counterparty.hostSlug, 'provider-example-org');
    });
    it('[HR02] parses collectors streams', () => {
      const r = parseChatsOrCollectorsStreamId(':_cmc:apps:my-app:collectors:provider-a--provider-example-org');
      assert.equal(r.appCode, 'my-app');
    });
    it('[HR03] parses nested path', () => {
      const r = parseChatsOrCollectorsStreamId(':_cmc:apps:my-app:campaign-2026:chats:provider-a--provider-example-org');
      assert.equal(r.appCode, 'my-app');
    });
    it('[HR04] returns null for non-chats / non-collectors streams', () => {
      assert.equal(parseChatsOrCollectorsStreamId(':_cmc:inbox'), null);
      assert.equal(parseChatsOrCollectorsStreamId(':_cmc:apps:my-app'), null);
    });
  });

  describe('[CMCHR-LU] access lookup helpers', () => {
    it('[HR05] findCounterpartyAccess matches by username + host + appCode', () => {
      const r = findCounterpartyAccess([COUNTERPARTY_ACCESS], PEER, 'my-app');
      assert.equal(r?.id, 'acc-counterparty');
    });
    it('[HR06] findCounterpartyAccess rejects wrong appCode', () => {
      const r = findCounterpartyAccess([COUNTERPARTY_ACCESS], PEER, 'different-app');
      assert.equal(r, null);
    });
    it('[HR07] findPairedDataGrant follows the peerAccessId pointer first', () => {
      const r = findPairedDataGrant(
        [COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS],
        COUNTERPARTY_ACCESS, PEER, 'my-app'
      );
      assert.equal(r?.id, 'acc-data-grant');
    });
    it('[HR08] findPairedDataGrant falls back to counterparty-tuple match', () => {
      const cpAccess = {
        ...COUNTERPARTY_ACCESS,
        clientData: {
          cmc: { ...COUNTERPARTY_ACCESS.clientData.cmc, peerAccessId: undefined },
        }
      };
      const r = findPairedDataGrant([cpAccess, DATA_GRANT_ACCESS], cpAccess, PEER, 'my-app');
      assert.equal(r?.id, 'acc-data-grant');
    });
  });

  describe('[CMCHR-OK] handleRevoke acceptance-time happy path', () => {
    it('[HR09] deletes both accesses + notifies peer when trigger is on a chats stream', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          id: 'evt-revoke',
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: { reason: 'study ended' },
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.peerNotified, true);
      assert.deepEqual(r.deletedAccessIds.sort(), ['acc-counterparty', 'acc-data-grant'].sort());
      // Outbound POST: revoke notification to peer
      assert.equal(calls.length, 1);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'consent/revoke-cmc');
      assert.deepEqual(sent.streamIds, [':_cmc:inbox']);
      assert.deepEqual(sent.content.from, SELF);
      assert.equal(sent.content.reason, 'study ended');
    });

    it('[HR10] runs even if data-grant is missing (only counterparty access deleted)', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS]); // no data-grant
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: {},
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.deepEqual(r.deletedAccessIds, ['acc-counterparty']);
    });

    it('[HR11] still returns ok=true when peer delivery fails (local revoke is authoritative)', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS]);
      const { fetch } = fakeFetch({ status: 503, body: { error: 'down' } });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: {},
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.peerNotified, false);
      assert.deepEqual(r.deletedAccessIds.sort(), ['acc-counterparty', 'acc-data-grant'].sort());
    });

    it('[HR12] from-collectors-stream routes the same way', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:collectors:provider-a--provider-example-org'],
          content: {},
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
    });
  });

  describe('[CMCHR-PRE] handleRevoke pre-acceptance path (capability URL)', () => {
    it('[HR13] delivers via capabilityUrl, no local deletes', async () => {
      const mall = fakeMall([]); // no local accesses yet
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:inbox'],
          content: {
            capabilityUrl: 'https://cap-tok@provider.example.org/',
            counterparty: PEER,
            reason: 'withdrew',
          },
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.peerNotified, true);
      assert.equal(r.deletedAccessIds.length, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://provider.example.org/events');
    });

    it('[HR14] surfaces delivery-failed when capability-URL delivery 5xxs', async () => {
      const mall = fakeMall([]);
      const { fetch } = fakeFetch({ status: 502, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:inbox'],
          content: {
            capabilityUrl: 'https://cap-tok@provider.example.org/',
            counterparty: PEER,
          },
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-failed');
    });
  });

  describe('[CMCHR-FAIL] handleRevoke failure paths', () => {
    it('[HR15] rejects wrong trigger type', async () => {
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: { type: 'message/chat-cmc', content: {}, streamIds: [] },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-wrong-type');
    });

    it('[HR16] surfaces missing counterparty when no streamIds and no content.counterparty', async () => {
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: { type: 'consent/revoke-cmc', content: {}, streamIds: ['some-other-stream'] },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-revoke-counterparty-missing');
    });

    it('[HR17] surfaces "counterparty access not found" when match fails', async () => {
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: {},
        },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-revoke-counterparty-access-not-found');
    });
  });
});
