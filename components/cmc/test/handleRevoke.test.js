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
 * [CMCHR] covers consent/revoke-cmc handling: acceptance-time teardown
 * (LOCAL accesses.delete + peer notify — the peer's own half is not
 * deleted by us; the receiving side skips peer-delivered revokes),
 * explicit accessId targeting, and failure paths.
 */

const assert = require('node:assert/strict');
const {
  handleRevoke,
  parseChatsOrCollectorsStreamId,
  findCounterpartyAccess,
  findPairedDataGrant,
} = require('../src/handleRevoke.ts');
const { assertOutboundUrl } = require('./_fake-assertions.cjs');

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
          // reason mirrors a REAL trigger: localizable map (a plain
          // string would have been rejected by validateRevoke upstream).
          content: { reason: { en: 'study ended' } },
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
      assert.deepEqual(sent.content.reason, { en: 'study ended' });
      // The peer's validateRevoke REQUIRES content.accessId — without it
      // the receiving side 400s the inbox write and the revocation is
      // never observable there. Pin the id + schema-validity.
      assert.equal(sent.content.accessId, 'acc-counterparty');
      assert.equal(sent.content.appCode, 'my-app');
      const v = require('../src/validators.ts').validateRevoke(sent.content);
      assert.equal(v.valid, true, 'peer-side validateRevoke must accept the payload: ' + JSON.stringify(v.errors));
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

    it('[HR-AUTH-PT] passes when triggerAccess is personal (canDeleteAccess → true)', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS]);
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const triggerAccess = { canDeleteAccess: () => true };
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: {},
        },
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess },
      });
      assert.equal(r.ok, true);
      assert.deepEqual(r.deletedAccessIds.sort(), ['acc-counterparty', 'acc-data-grant'].sort());
    });

    it('[HR-AUTH-SELF] passes when triggerAccess can self-revoke the target', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS]);
      const { fetch } = fakeFetch({ status: 201, body: {} });
      // Sim a shared token that IS the data-grant access self-revoking:
      // canDeleteAccess({id: acc-data-grant, ...}) → true.
      const triggerAccess = {
        canDeleteAccess: (target) => target.id === 'acc-data-grant' || target.id === 'acc-counterparty',
      };
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: {},
        },
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess },
      });
      assert.equal(r.ok, true);
    });

    it('[HR-AUTH-NO] rejects with cmc-revoke-forbidden when triggerAccess cannot delete the data-grant', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const triggerAccess = { canDeleteAccess: () => false };
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: {},
        },
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-revoke-forbidden');
      // No outbound delivery + no deletes when the permission check fails.
      assert.equal(calls.length, 0);
    });

    it('[HR-AUTH-PARTIAL] rejects when the counterparty access cannot be deleted (data-grant ok, counterparty no)', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const triggerAccess = {
        canDeleteAccess: (target) => target.id === 'acc-data-grant',
      };
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: {},
        },
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-revoke-forbidden');
      // Both checks happen before any delete or outbound; nothing fired.
      assert.equal(calls.length, 0);
    });

    it('[HR-AUTH-SKIP] passes through when triggerAccess is absent (unit-test mocked deps)', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, DATA_GRANT_ACCESS]);
      const { fetch } = fakeFetch({ status: 201, body: {} });
      // No triggerAccess in deps — the chain check skips.
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

  describe('[CMCHR-ID] explicit content.accessId targeting', () => {
    // A second relationship to the SAME counterparty (another study
    // under the same app) — the tuple match alone cannot tell them
    // apart, the explicit id must.
    const SECOND_COUNTERPARTY_ACCESS = {
      id: 'acc-counterparty-2',
      type: 'shared',
      clientData: {
        cmc: {
          role: 'counterparty',
          appCode: 'my-app',
          counterparty: {
            username: 'provider-a',
            host: 'provider.example.org',
            apiEndpoint: 'https://peer-tok-2@provider.example.org/',
          },
        },
      },
    };

    it('[HR18] content.accessId selects the exact relationship among several to the same counterparty', async () => {
      const mall = fakeMall([COUNTERPARTY_ACCESS, SECOND_COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: { accessId: 'acc-counterparty-2' },
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      // The SECOND access (the explicit target) is torn down — not the
      // first tuple match.
      assert.ok(r.deletedAccessIds.includes('acc-counterparty-2'));
      assert.ok(!r.deletedAccessIds.includes('acc-counterparty'));
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.content.accessId, 'acc-counterparty-2');
    });

    it('[HR19] unresolvable content.accessId fails without falling back to the tuple match', async () => {
      // Duplicate-revoke safety: after a raw accesses.delete removed the
      // target, a fallback would tear down a DIFFERENT relationship to
      // the same counterparty.
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:chats:provider-a--provider-example-org'],
          content: { accessId: 'acc-already-deleted' },
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-revoke-counterparty-access-not-found');
      assert.equal(mall.calls.deleted.length, 0);
      assert.equal(calls.length, 0);
    });

    it('[HR20] trigger on a plain app-scope stream works via accessId (counterparty derived from the access)', async () => {
      // The client helpers default the trigger stream to the invite's
      // own app-scope stream — neither chats nor collectors, so no
      // counterparty can be parsed from the stream id.
      const mall = fakeMall([COUNTERPARTY_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:apps:my-app:study-1'],
          content: { accessId: 'acc-counterparty' },
        },
        selfIdentity: SELF,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.peerNotified, true);
      assert.ok(r.deletedAccessIds.includes('acc-counterparty'));
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.content.accessId, 'acc-counterparty');
    });
  });

  describe('[CMCHR-FAIL] handleRevoke failure paths', () => {
    it('[HR13] content.capabilityUrl is inert — no pre-acceptance delivery branch', async () => {
      // The former pre-acceptance branch (deliver via the capability
      // URL) was removed: no client ever emitted such triggers (invite
      // cancellation is consent/invalidate-link-cmc) and the capability
      // access could not have delivered to the peer inbox anyway. A
      // trigger still carrying capabilityUrl now takes the normal
      // acceptance-time path and fails cleanly when nothing matches —
      // with NO outbound call to the capability URL.
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'u1',
        triggerEvent: {
          type: 'consent/revoke-cmc',
          streamIds: [':_cmc:inbox'],
          content: {
            capabilityUrl: 'https://cap-tok@provider.example.org/',
            counterparty: PEER,
            reason: { en: 'withdrew' },
          },
        },
        selfIdentity: SELF,
        deps: { mall: fakeMall([]), fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-revoke-counterparty-access-not-found');
      assert.equal(calls.length, 0);
    });

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
