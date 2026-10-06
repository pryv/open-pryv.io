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
const { assertEventUpdateShape, assertOutboundUrl } = require('./_fake-assertions.cjs');

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
        assertEventUpdateShape(params);
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
      // requesterIdentity is returned so dispatch can stamp it as
      // `content.from = {username, host}` on the local accept trigger
      // event. Without this, listAcceptedRelationships's mapper on the
      // accepter side falls through to `content.acceptedBy` (the
      // accepter's OWN data-grant apiEndpoint, not the requester's
      // identity), and the patient app can't tell WHICH doctor each
      // relationship row belongs to.
      assert.deepEqual(r.requesterIdentity, { username: 'provider-a', host: 'example.com' });
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

    it('[HA01F] reads negotiated features from triggerEvent.content.features (NOT content.extra) and stamps them on the data-grant', async () => {
      // README "Features negotiation": SDK persists offer-resolved
      // features into content.features at acceptInvite time; plugin
      // forwards them onto the data-grant access's clientData.cmc.features.
      //
      // Bug history (2026-05-21, implementer report):
      // plugin used to read content.extra (the user-supplied pass-through),
      // so the negotiation never reached the data-grant — accepter-side
      // ended up with clientData.cmc.features = null even when the offer
      // specified explicit values. content.extra MUST NOT influence
      // features stamping.
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const triggerWithFeatures = {
        id: 'evt-accept-f',
        type: 'consent/accept-cmc',
        content: {
          capabilityUrl: 'https://Tok@example.com/',
          features: { chat: false, systemMessaging: true },
          extra: { chat: true, systemMessaging: true } // decoy — must NOT be read
        }
      };
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: triggerWithFeatures,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(mall.calls.accessesCreated.length, 1);
      const acc = mall.calls.accessesCreated[0];
      assert.deepEqual(acc.clientData.cmc.features, { chat: false, systemMessaging: true });
    });

    it('[HA01G] data-grant features are the offer\'s when triggerEvent omits content.features (decoy content.extra MUST NOT leak through)', async () => {
      // Companion of [HA01F]: when the SDK doesn't write content.features
      // (legacy SDK pre-fix, or third-party callers), the plugin must NOT
      // fall back to content.extra. The server resolves the features from
      // the offer alone (each one true when the offer does not set it), so
      // the extra's `false` values have no effect.
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const triggerExtraOnly = {
        id: 'evt-accept-extra-only',
        type: 'consent/accept-cmc',
        content: {
          capabilityUrl: 'https://Tok@example.com/',
          extra: { chat: false, systemMessaging: false } // MUST NOT influence features
        }
      };
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: triggerExtraOnly,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true);
      const acc = mall.calls.accessesCreated[0];
      assert.deepEqual(acc.clientData.cmc.features, { chat: true, systemMessaging: true });
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

    it('[HA04] surfaces capability HTTP error from offer-read (403 = unknown/expired capability)', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 403, body: { error: 'forbidden' } });
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-capability-invalid');
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

    it('[HA07B] a capability refusal on delivery is reported with its typed id, detail kept, grant rolled back', async () => {
      for (const id of ['cmc-capability-invalidated', 'cmc-capability-consumed', 'cmc-capability-already-accepted-by-you']) {
        const mall = fakeMall();
        const body = { error: { id: 'invalid-operation', data: { id } } };
        const { fetch } = fakeFetch([
          { status: 200, body: { events: [VALID_OFFER] } },
          { status: 400, body },
        ]);
        const r = await handleAccept({
          userId: 'u1',
          triggerEvent: ACCEPT_TRIGGER,
          selfIdentity: { username: 'alice', host: 'recipient.example.com' },
          deps: { mall, fetch },
        });
        assert.equal(r.ok, false);
        assert.equal(r.reason, id);
        assert.deepEqual(r.detail.body, body);
        assert.equal(mall.calls.accessesDeleted.length, 1);
      }
    });

    it('[HA07C] any other 4xx keeps the generic delivery-rejected reason', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 400, body: { error: { id: 'invalid-operation', data: { id: 'cmc-something-else' } } } },
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: ACCEPT_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.reason, 'cmc-handler-delivery-rejected');
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

  describe('[CMCHA-FEAT] the relationship\'s features: resolved from the offer, decide the chat channel', () => {
    const SCOPE = ':_cmc:apps:my-app:campaign-2026';
    const CHAT_LEAF = SCOPE + ':chats:provider-a--example-com';
    function offerWith (features) {
      const offer = structuredClone(VALID_OFFER);
      if (features !== undefined) offer.content.request.features = features;
      return offer;
    }
    async function accept (offer, triggerFeatures) {
      const mall = fakeMall();
      const { fetch, calls } = fakeFetch([
        { status: 200, body: { events: [offer] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const content = { capabilityUrl: 'https://Tok@example.com/' };
      if (triggerFeatures !== undefined) content.features = triggerFeatures;
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: { id: 'evt-accept-feat', type: 'consent/accept-cmc', streamIds: [SCOPE], content },
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      return { r, mall, delivered: JSON.parse(calls[1].init.body).content };
    }
    const chatPermissions = (acc) => acc.permissions.filter((p) => /:chats/.test(p.streamId));

    it('[HA43] an offer without chat gives no chat leaf and no chat permission, whatever the accept asks', async () => {
      const { r, mall, delivered } = await accept(offerWith({ chat: false }), { chat: true, systemMessaging: true });
      assert.equal(r.ok, true);
      const created = mall.calls.streamsCreated.map((s) => s.id);
      assert.ok(created.includes(SCOPE + ':chats'), 'the chats parent is kept');
      assert.ok(!created.includes(CHAT_LEAF), 'no chat leaf');
      assert.ok(created.includes(SCOPE + ':collectors:provider-a--example-com'));
      assert.ok(!r.anchorStreamIds.includes(CHAT_LEAF));
      const acc = mall.calls.accessesCreated[0];
      assert.deepEqual(chatPermissions(acc), []);
      assert.ok(acc.permissions.some((p) => p.streamId === SCOPE + ':collectors:provider-a--example-com'));
      const expected = { chat: false, systemMessaging: true };
      assert.deepEqual(acc.clientData.cmc.features, expected);
      assert.deepEqual(delivered.features, expected);
      assert.deepEqual(r.features, expected);
    });

    it('[HA44] the accept may narrow: an offer without features and an accept with chat false give no chat', async () => {
      const { r, mall, delivered } = await accept(offerWith(undefined), { chat: false });
      assert.equal(r.ok, true);
      assert.ok(!mall.calls.streamsCreated.map((s) => s.id).includes(CHAT_LEAF));
      assert.deepEqual(chatPermissions(mall.calls.accessesCreated[0]), []);
      assert.deepEqual(r.features, { chat: false, systemMessaging: true });
      assert.deepEqual(delivered.features, { chat: false, systemMessaging: true });
    });

    it('[HA45] an offer with chat and an accept without features keep the chat leaf and permission', async () => {
      const { r, mall } = await accept(offerWith({ chat: true }), undefined);
      assert.equal(r.ok, true);
      assert.ok(mall.calls.streamsCreated.map((s) => s.id).includes(CHAT_LEAF));
      assert.deepEqual(chatPermissions(mall.calls.accessesCreated[0]), [{ streamId: CHAT_LEAF, level: 'contribute' }]);
      assert.deepEqual(r.features, { chat: true, systemMessaging: true });
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

  describe('[CMCHA-DUP] data-grant access-name collision handling', () => {
    // Accesses are unique on (name, type, deviceName); a fixed client-side
    // accessName collides with the access minted by a previous accept.
    const DUP_TRIGGER = {
      id: 'evt-accept',
      type: 'consent/accept-cmc',
      content: { capabilityUrl: 'https://Tok@example.com/', accessName: 'my-app' },
    };

    // fakeMall variant enforcing name uniqueness like the real engines.
    function fakeMallWithNames (takenNames, existingAccesses = []) {
      const mall = fakeMall();
      const taken = new Set(takenNames);
      const baseCreate = mall.accesses.create.bind(mall.accesses);
      mall.calls.createAttemptNames = [];
      mall.accesses.create = async (userId, params) => {
        mall.calls.createAttemptNames.push(params.name);
        if (taken.has(params.name)) {
          const err = new Error('duplicate key value violates unique constraint "idx_access_name_type_deviceName"');
          err.isDuplicate = true;
          throw err;
        }
        taken.add(params.name);
        return baseCreate(userId, params);
      };
      mall.accesses.get = async () => existingAccesses;
      return mall;
    }

    it('[HA40] retries once with a deterministic per-accept suffix when the name is taken', async () => {
      const mall = fakeMallWithNames(['my-app']);
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: DUP_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      // 'evt-accept'.slice(-8) === 't-accept'
      assert.deepEqual(mall.calls.createAttemptNames, ['my-app', 'my-app (t-accept)']);
      assert.equal(mall.calls.accessesCreated.length, 1);
      assert.equal(mall.calls.accessesCreated[0].name, 'my-app (t-accept)');
    });

    it('[HA41] fails permanently with a typed id (no raw DB text) when the suffixed name collides too', async () => {
      const mall = fakeMall();
      // Raw engine message without the isDuplicate flag — covers the
      // message-regex detection path.
      mall.accesses.create = async () => {
        throw new Error('duplicate key value violates unique constraint "idx_access_name_type_deviceName"');
      };
      mall.accesses.get = async () => [];
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: DUP_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-data-grant-name-conflict');
      assert.equal(r.detail.name, 'my-app');
      assert.doesNotMatch(String(r.detail.message), /constraint|duplicate key/i,
        'client-visible detail must not echo the raw DB error');
    });

    it('[HA42] reuses its own prior data-grant on re-dispatch (idempotent; no second create)', async () => {
      const existing = {
        id: 'acc-existing',
        token: 'tok-e',
        apiEndpoint: 'https://tok-e@recipient.example.com/',
        clientData: { cmc: { role: 'counterparty', acceptEventId: 'evt-accept' } },
      };
      const mall = fakeMallWithNames(['my-app'], [existing]);
      const { fetch } = fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: DUP_TRIGGER,
        selfIdentity: { username: 'alice', host: 'recipient.example.com' },
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.dataGrantAccessId, 'acc-existing');
      assert.equal(r.dataGrantApiEndpoint, 'https://tok-e@recipient.example.com/');
      assert.equal(mall.calls.accessesCreated.length, 0);
    });
  });

  describe('[CMCHA-DEL] accept given through an account delegation', () => {
    const DELEGATE = { username: 'parent', hostSlug: 'core-a' };
    const LINEAGE = { kind: 'delegated-child', relId: 'rel1', delegate: DELEGATE, viaAccessId: 'pat1' };
    const PAT_ROW = { id: 'pat1', type: 'personal', clientData: { delegation: { kind: 'delegate-pat', relId: 'rel1', delegate: DELEGATE } } };
    const OWNER_ROW = { id: 'own1', type: 'personal', clientData: null };
    const SELF = { username: 'kid', host: 'recipient.example.com' };

    // Same contract as the delegation plugin's lineageOf.
    function lineageOf (access) {
      const d = access?.clientData?.delegation;
      if (d == null || (d.kind !== 'delegate-pat' && d.kind !== 'delegated-child')) return null;
      return { kind: 'delegated-child', relId: d.relId, delegate: d.delegate, viaAccessId: access.id };
    }
    // AccessLogic stand-in: the stored row plus the chain check.
    const logicOf = (row) => ({ ...row, canCreateAccess: async () => true });

    // A mall whose accesses persist, so re-reads see creates and deletes.
    function storeMall (rows) {
      const mall = fakeMall();
      const list = rows.map((r) => ({ ...r }));
      const baseCreate = mall.accesses.create.bind(mall.accesses);
      mall.list = list;
      mall.calls.accessesUpdated = [];
      mall.accesses.create = async (userId, params) => {
        const a = await baseCreate(userId, params);
        a.id = 'grant-' + mall.calls.accessesCreated.length;
        list.push(a);
        return a;
      };
      mall.accesses.get = async () => list.slice();
      mall.accesses.getOne = async (_u, { id }) => list.find((a) => a.id === id) ?? null;
      mall.accesses.update = async (_u, { id, update }) => {
        mall.calls.accessesUpdated.push({ id, update });
        const a = list.find((x) => x.id === id);
        const { clientData, ...rest } = update;
        Object.assign(a, rest);
        // The storage contract for an object on a JSON field: merged one level
        // into the stored object, a null entry removes the key.
        if (clientData != null) {
          const merged = { ...(a.clientData ?? {}) };
          for (const [k, v] of Object.entries(clientData)) {
            if (v === null) delete merged[k]; else merged[k] = v;
          }
          a.clientData = merged;
        }
        return a;
      };
      mall.accesses.delete = async (userId, { id }) => {
        mall.calls.accessesDeleted.push({ userId, id });
        const i = list.findIndex((a) => a.id === id);
        if (i >= 0) list.splice(i, 1);
      };
      return mall;
    }

    function okFetch () {
      return fakeFetch([
        { status: 200, body: { events: [VALID_OFFER] } },
        { status: 201, body: { event: { id: 'r1' } } },
      ]);
    }

    function relationshipSpy (answers) {
      const calls = [];
      const seq = Array.isArray(answers) ? answers.slice() : null;
      const fn = async (userId, relId) => {
        calls.push({ userId, relId });
        return seq != null ? (seq.length > 1 ? seq.shift() : seq[0]) : answers;
      };
      fn.calls = calls;
      return fn;
    }

    const trigger = (content = {}, extra = {}) => ({
      ...ACCEPT_TRIGGER,
      ...extra,
      content: { ...ACCEPT_TRIGGER.content, ...content },
    });
    const APPROVED = { delegate: DELEGATE, relId: 'rel1' };

    it('[HAL01] the grant carries the lineage of the writing access, beside its cmc record', async () => {
      const mall = storeMall([PAT_ROW]);
      const relationshipExists = relationshipSpy(true);
      const { fetch, calls } = okFetch();
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess: logicOf(PAT_ROW), lineageOf, relationshipExists },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      const created = mall.calls.accessesCreated[0];
      assert.deepEqual(created.clientData.delegation, LINEAGE);
      assert.equal(created.clientData.cmc.role, 'counterparty');
      assert.equal(created.clientData.cmc.acceptEventId, 'evt-accept');
      // checked before the mint and again after it
      assert.deepEqual(relationshipExists.calls, [{ userId: 'u1', relId: 'rel1' }, { userId: 'u1', relId: 'rel1' }]);
      assert.equal(calls.length, 2, 'offer read + accept delivered');
      assert.equal(mall.calls.accessesDeleted.length, 0);
    });

    it('[HAL02] an owner accept: no lineage on the grant, no relationship check', async () => {
      const mall = storeMall([OWNER_ROW]);
      const relationshipExists = relationshipSpy(true);
      const { fetch } = okFetch();
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger(),
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess: logicOf(OWNER_ROW), lineageOf, relationshipExists },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal('delegation' in mall.calls.accessesCreated[0].clientData, false);
      assert.deepEqual(relationshipExists.calls, []);
    });

    it('[HAL03] the delegation ended before the accept is processed: no grant, nothing delivered', async () => {
      const mall = storeMall([PAT_ROW]);
      const { fetch, calls } = okFetch();
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess: logicOf(PAT_ROW), lineageOf, relationshipExists: relationshipSpy(false) },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delegation-ended');
      assert.equal(mall.calls.accessesCreated.length, 0);
      assert.equal(calls.length, 1, 'only the offer was read');
    });

    it('[HAL09] a failing relationship check keeps the storage error out of the failure detail', async () => {
      const mall = storeMall([PAT_ROW]);
      const { fetch } = okFetch();
      const warned = [];
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: {
          mall,
          fetch,
          triggerAccess: logicOf(PAT_ROW),
          lineageOf,
          relationshipExists: async () => { throw new Error('storage-internal-detail 10.0.0.5'); },
          logger: { warn: (msg, meta) => warned.push({ msg, meta }) },
        },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-handler-delegation-ended');
      assert.equal(JSON.stringify(r.detail).includes('storage-internal-detail'), false, JSON.stringify(r.detail));
      assert.equal(mall.calls.accessesCreated.length, 0);
      assert.ok(warned.some((w) => JSON.stringify(w.meta).includes('storage-internal-detail')), 'logged instead');
    });

    it('[HAL04] the delegation ends while the grant is minted: the grant is deleted, nothing delivered', async () => {
      // the relationship is there before the mint, gone right after
      const mall = storeMall([PAT_ROW]);
      const { fetch, calls } = okFetch();
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: { mall, fetch, triggerAccess: logicOf(PAT_ROW), lineageOf, relationshipExists: relationshipSpy([true, false]) },
      });
      assert.equal(r.reason, 'cmc-handler-delegation-ended', JSON.stringify(r));
      assert.equal(mall.calls.accessesCreated.length, 1);
      assert.deepEqual(mall.calls.accessesDeleted.map((d) => d.id), ['grant-1']);
      assert.equal(mall.list.some((a) => a.id === 'grant-1'), false, 'no grant left');
      assert.equal(calls.length, 1, 'the accept is not delivered');

      // same when the approving access is deleted in that window (detach
      // deletes it first), the relationship anchor still being there
      const mall2 = storeMall([PAT_ROW]);
      const baseCreate = mall2.accesses.create;
      mall2.accesses.create = async (u, p) => {
        const a = await baseCreate(u, p);
        mall2.list.splice(mall2.list.findIndex((x) => x.id === 'pat1'), 1);
        return a;
      };
      const r2 = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: { mall: mall2, fetch: okFetch().fetch, triggerAccess: logicOf(PAT_ROW), lineageOf, relationshipExists: relationshipSpy(true) },
      });
      assert.equal(r2.reason, 'cmc-handler-delegation-ended', JSON.stringify(r2));
      assert.equal(mall2.list.some((a) => a.id === 'grant-1'), false, 'no grant left');
    });

    it('[HAL05] the recorded approval must match the writing access: never minted unmarked or on the content\'s word', async () => {
      // approvedBy present, writer resolves to no delegation
      const mall = storeMall([OWNER_ROW]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: { mall, fetch: okFetch().fetch, triggerAccess: logicOf(OWNER_ROW), lineageOf, relationshipExists: relationshipSpy(true) },
      });
      assert.equal(r.reason, 'cmc-handler-delegation-ended');
      assert.equal(mall.calls.accessesCreated.length, 0);
      // approvedBy naming another relationship than the writer's
      const mall2 = storeMall([PAT_ROW]);
      const r2 = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: { delegate: DELEGATE, relId: 'rel-other' } }),
        selfIdentity: SELF,
        deps: { mall: mall2, fetch: okFetch().fetch, triggerAccess: logicOf(PAT_ROW), lineageOf, relationshipExists: relationshipSpy(true) },
      });
      assert.equal(r2.reason, 'cmc-handler-delegation-ended');
      assert.equal(mall2.calls.accessesCreated.length, 0);
    });

    it('[HAL06] a retry (no request context) reads the writer back by createdBy', async () => {
      for (const createdBy of ['pat1', 'pat1 caller-x']) {
        const mall = storeMall([PAT_ROW]);
        const r = await handleAccept({
          userId: 'u1',
          triggerEvent: trigger({ approvedBy: APPROVED }, { createdBy }),
          selfIdentity: SELF,
          deps: { mall, fetch: okFetch().fetch, lineageOf, relationshipExists: relationshipSpy(true) },
        });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(mall.calls.accessesCreated[0].clientData.delegation, LINEAGE, createdBy);
      }
    });

    it('[HAL07] a retry whose approving access is gone fails, and an unwired check never mints', async () => {
      const mall = storeMall([]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }, { createdBy: 'pat1' }),
        selfIdentity: SELF,
        deps: { mall, fetch: okFetch().fetch, lineageOf, relationshipExists: relationshipSpy(true) },
      });
      assert.equal(r.reason, 'cmc-handler-delegation-ended');
      assert.equal(mall.calls.accessesCreated.length, 0);
      // no lineage reader wired at all, approval recorded: refused
      const mall2 = storeMall([PAT_ROW]);
      const r2 = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: { mall: mall2, fetch: okFetch().fetch, triggerAccess: logicOf(PAT_ROW) },
      });
      assert.equal(r2.reason, 'cmc-handler-delegation-ended');
      // lineage readable, relationship check not wired: refused
      const mall3 = storeMall([PAT_ROW]);
      const r3 = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: { mall: mall3, fetch: okFetch().fetch, triggerAccess: logicOf(PAT_ROW), lineageOf },
      });
      assert.equal(r3.reason, 'cmc-handler-delegation-ended');
      assert.equal(mall2.calls.accessesCreated.length + mall3.calls.accessesCreated.length, 0);
    });

    it('[HAL08] a grant reused from an earlier dispatch of the same accept is given the lineage', async () => {
      const prior = {
        id: 'grant-prior',
        token: 'tok-p',
        apiEndpoint: 'https://tok-p@recipient.example.com/',
        clientData: { cmc: { role: 'counterparty', acceptEventId: 'evt-accept' } },
      };
      const mall = storeMall([PAT_ROW, prior]);
      const r = await handleAccept({
        userId: 'u1',
        triggerEvent: trigger({ approvedBy: APPROVED }),
        selfIdentity: SELF,
        deps: { mall, fetch: okFetch().fetch, triggerAccess: logicOf(PAT_ROW), lineageOf, relationshipExists: relationshipSpy(true) },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.dataGrantAccessId, 'grant-prior');
      assert.equal(mall.calls.accessesCreated.length, 0);
      // only the marker is written: the stored cmc record is not re-sent
      assert.deepEqual(mall.calls.accessesUpdated, [{
        id: 'grant-prior',
        update: { clientData: { delegation: LINEAGE } },
      }]);
      assert.deepEqual((await mall.accesses.getOne('u1', { id: 'grant-prior' })).clientData,
        { cmc: { role: 'counterparty', acceptEventId: 'evt-accept' }, delegation: LINEAGE });
    });
  });
});
