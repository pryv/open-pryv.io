/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleAccept / handleRefuse entry-point tests.
 *
 * [CMCHA] covers the full end-to-end accept / refuse handler flows
 * with fake mall + fake fetch.
 */

const assert = require('node:assert/strict');
const { handleAccept, handleRefuse, inferCounterparty, pickScopeFromTrigger } = require('../src/handleAccept.ts');

function fakeMall (opts = {}) {
  const calls = { accessesCreated: [], accessesDeleted: [], eventsUpdated: [], streamsCreated: [] };
  return {
    calls,
    accesses: {
      async create (userId, params) {
        calls.accessesCreated.push({ userId, ...params });
        if (opts.failAccessCreate) throw new Error('mall-down');
        return {
          id: 'acc-' + (calls.accessesCreated.length),
          token: 'tok',
          apiEndpoint: opts.noApiEndpoint
            ? undefined
            : 'https://tok-grant@recipient.example.com/',
          ...params,
        };
      },
      async delete (userId, params) {
        calls.accessesDeleted.push({ userId, ...params });
      },
    },
    events: {
      async update (userId, params) {
        calls.eventsUpdated.push({ userId, ...params });
      },
    },
    streams: {
      async create (userId, params) {
        calls.streamsCreated.push({ userId, ...params });
        return { id: params.id };
      },
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
    requesterMeta: { displayName: 'Provider A', appId: 'example-app', username: 'provider-a' },
    capabilityId: 'cap-xyz',
  },
};

const ACCEPT_TRIGGER = {
  id: 'evt-accept',
  type: 'consent/accept-cmc',
  content: { capabilityUrl: 'https://Tok@example.com/', extra: { chat: true } },
};

const REFUSE_TRIGGER = {
  id: 'evt-refuse',
  type: 'consent/refuse-cmc',
  content: { capabilityUrl: 'https://Tok@example.com/', reason: { en: 'no thanks' } },
};

describe('[CMCHA] cmc/handleAccept', () => {
  describe('[CMCHA-OK] handleAccept happy path', () => {
    it('[HA01] reads offer, creates data-grant, delivers accept; returns ok with handles', async () => {
      const mall = fakeMall();
      const { fetch, calls } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },        // GET offer
        { status: 201, body: { event: { id: 'r1' } } },           // POST accept
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.dataGrantAccessId, 'acc-1');
      assert.equal(r.dataGrantApiEndpoint, 'https://tok-grant@recipient.example.com/');
      assert.equal(r.offerEventId, 'evt-offer');
      assert.equal(r.capabilityId, 'cap-xyz');
      // Mall: one access created
      assert.equal(mall.calls.accessesCreated.length, 1);
      const acc = mall.calls.accessesCreated[0];
      assert.equal(acc.type, 'shared');
      assert.equal(acc.clientData.cmc.role, 'counterparty');
      assert.deepEqual(acc.clientData.cmc.counterparty, { username: 'provider-a', host: 'example.com' });
      // No rollback delete
      assert.equal(mall.calls.accessesDeleted.length, 0);
      // Fetch: one GET (offer), one POST (accept)
      assert.equal(calls.length, 2);
      assert.equal(calls[0].init.method, 'GET');
      assert.equal(calls[1].init.method, 'POST');
      const sentBody = JSON.parse(calls[1].init.body);
      assert.equal(sentBody.type, 'consent/accept-cmc');
      assert.equal(sentBody.content.grantedAccess.apiEndpoint, 'https://tok-grant@recipient.example.com/');
      assert.deepEqual(sentBody.content.from, { username: 'alice', host: 'recipient.example.com' });
    });
  });

  describe('[CMCHA-FAIL] handleAccept failure paths', () => {
    it('[HA02] rejects wrong trigger type', async () => {
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: { type: 'message/chat-cmc', content: {} },
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall: fakeMall(), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-wrong-type');
    });

    it('[HA03] rejects when capabilityUrl is missing', async () => {
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: { id: 'x', type: 'consent/accept-cmc', content: {} },
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall: fakeMall(), fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-missing-capability-url');
    });

    it('[HA04] surfaces capability HTTP error from offer-read', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 403, body: { error: 'forbidden' } });
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.ok(r.reason === 'cmc-capability-empty' ||
                r.reason === 'cmc-handler-offer-read-failed');
      // No data-grant created
      assert.equal(mall.calls.accessesCreated.length, 0);
    });

    it('[HA05] surfaces counterparty-unknown when offer lacks requesterMeta.username', async () => {
      const mall = fakeMall();
      const offerNoUsername = {
        ...VALID_OFFER,
        content: { ...VALID_OFFER.content, requesterMeta: { displayName: 'X' } },
      };
      const { fetch } = fakeFetch({ status: 200, body: { events: [offerNoUsername] } });
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-counterparty-unknown');
      assert.equal(mall.calls.accessesCreated.length, 0);
    });

    it('[HA06] surfaces empty-permissions when offer.request.permissions is missing', async () => {
      const mall = fakeMall();
      const offerNoPerms = {
        ...VALID_OFFER,
        content: { ...VALID_OFFER.content, request: { ...VALID_OFFER.content.request, permissions: [] } },
      };
      const { fetch } = fakeFetch({ status: 200, body: { events: [offerNoPerms] } });
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-offer-empty-permissions');
    });

    it('[HA07] rolls back data-grant when delivery rejects 4xx', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },                      // offer
        { status: 400, body: { error: 'bad' } },                                // accept rejected
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-rejected');
      // Rollback: data-grant deleted
      assert.equal(mall.calls.accessesDeleted.length, 1);
      assert.equal(mall.calls.accessesDeleted[0].id, 'acc-1');
    });

    it('[HA08] does NOT roll back data-grant on 5xx (retryable; orchestration loop will retry)', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 503, body: { error: 'down' } },
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-failed');
      // No rollback — access stays for retry
      assert.equal(mall.calls.accessesDeleted.length, 0);
    });

    it('[HA09] surfaces mall.accesses.create failure', async () => {
      const mall = fakeMall({ failAccessCreate: true });
      const { fetch } = fakeFetch([{ status: 200, body: { events: [VALID_OFFER] } }]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-data-grant-create-failed');
    });

    it('[HA10] surfaces missing apiEndpoint on the created data-grant', async () => {
      const mall = fakeMall({ noApiEndpoint: true });
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: {} },
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-data-grant-no-apiendpoint');
    });
  });

  describe('[CMCHA-RF] handleRefuse', () => {
    it('[HA11] delivers consent/refuse-cmc with reason; returns ok', async () => {
      // handleRefuse reads the offer first (to recover capabilityId
      // for the per-capability responses streamId) — so fakeFetch
      // returns two responses: offer GET + refuse POST.
      const { fetch, calls } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } }, // offer read
        { status: 201, body: {} },                          // refuse POST
      ]);
      const r = await handleRefuse({
        userId: 'u1',
        triggerEvent: REFUSE_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { fetch },
      });
      assert.equal(r.ok, true);
      // Last call is the POST.
      const sent = JSON.parse(calls[calls.length - 1].init.body);
      assert.equal(sent.type, 'consent/refuse-cmc');
      assert.deepEqual(sent.content.reason, { en: 'no thanks' });
      assert.deepEqual(sent.streamIds, [':_cmc:_internal:responses:cap-xyz']);
    });

    it('[HA12] surfaces non-2xx delivery as failure', async () => {
      // Offer read succeeds; refuse POST returns 500.
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 500, body: { error: 'down' } },
      ]);
      const r = await handleRefuse({
        userId: 'u1',
        triggerEvent: REFUSE_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delivery-failed');
    });

    it('[HA13] rejects wrong trigger type', async () => {
      const r = await handleRefuse({
        userId: 'u1',
        triggerEvent: { type: 'consent/accept-cmc', content: {} },
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { fetch: fakeFetch({}).fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-wrong-type');
    });
  });

  describe('[CMCHA-IC] inferCounterparty', () => {
    it('[HA14] picks requesterMeta.username + URL host', () => {
      const r = inferCounterparty(
        { content: { requesterMeta: { username: 'provider-a' } } },
        'https://Tok@example.com:8443/'
      );
      assert.deepEqual(r, { username: 'provider-a', host: 'example.com:8443' });
    });

    it('[HA15] returns null when username can\'t be determined', () => {
      assert.equal(inferCounterparty({ content: {} }, 'https://Tok@example.com/'), null);
    });
  });

  describe('[CMCHA-AN] anchor-stream auto-creation at acceptance', () => {
    it('[HA16] creates 4 anchor streams under the trigger scope on success', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: {
          ...ACCEPT_TRIGGER,
          streamIds: [':_cmc:apps:my-app:campaign-2026'],
        },
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(r.anchorStreamIds.length, 4);
      const created = mall.calls.streamsCreated.map((s) => s.id);
      assert.ok(created.includes(':_cmc:apps:my-app:campaign-2026:chats'));
      assert.ok(created.includes(':_cmc:apps:my-app:campaign-2026:collectors'));
      assert.ok(created.includes(':_cmc:apps:my-app:campaign-2026:chats:provider-a--example-com'));
      assert.ok(created.includes(':_cmc:apps:my-app:campaign-2026:collectors:provider-a--example-com'));
    });

    it('[HA17] no anchor streams created when trigger has no :_cmc:apps:* scope', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER, // no streamIds
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.deepEqual(r.anchorStreamIds, []);
      assert.equal(mall.calls.streamsCreated.length, 0);
    });
  });

  describe('[CMCHA-PS] pickScopeFromTrigger', () => {
    it('[HA18] picks the first :_cmc:apps:* stream-id', () => {
      assert.equal(
        pickScopeFromTrigger({ streamIds: [':_cmc:inbox', ':_cmc:apps:my-app'] }),
        ':_cmc:apps:my-app'
      );
    });
    it('[HA19] preserves nested path under the app scope', () => {
      assert.equal(
        pickScopeFromTrigger({ streamIds: [':_cmc:apps:my-app:campaign-2026'] }),
        ':_cmc:apps:my-app:campaign-2026'
      );
    });
    it('[HA20] strips :chats / :collectors suffix to yield the parent scope', () => {
      assert.equal(
        pickScopeFromTrigger({ streamIds: [':_cmc:apps:my-app:campaign-2026:chats'] }),
        ':_cmc:apps:my-app:campaign-2026'
      );
      assert.equal(
        pickScopeFromTrigger({ streamIds: [':_cmc:apps:my-app:collectors:alice--example-com'] }),
        ':_cmc:apps:my-app'
      );
    });
    it('[HA21] returns null when no :_cmc:apps:* is present', () => {
      assert.equal(pickScopeFromTrigger({ streamIds: [':_cmc:inbox', 'other-stream'] }), null);
      assert.equal(pickScopeFromTrigger({}), null);
    });
  });
});
