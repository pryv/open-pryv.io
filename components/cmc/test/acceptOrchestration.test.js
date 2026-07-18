/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — accept / refuse orchestration primitive tests.
 *
 * [CMCAO] covers readOfferViaCapability + permissionsFromOffer +
 * buildDataGrantPayload + deliverAcceptViaCapability +
 * deliverRefuseViaCapability against a fake fetch.
 */

const assert = require('node:assert/strict');
const {
  readOfferViaCapability,
  permissionsFromOffer,
  buildDataGrantPayload,
  deliverAcceptViaCapability,
  deliverRefuseViaCapability,
} = require('../src/acceptOrchestration.ts');
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

const VALID_OFFER = {
  id: 'evt-offer',
  type: 'consent/request-cmc',
  content: {
    to: null,
    request: {
      title: { en: 'Example' },
      description: { en: 'desc' },
      consent: { en: 'I agree' },
      permissions: [
        { streamId: 'fertility', level: 'read' },
        { streamId: 'symptom', level: 'read' },
      ],
    },
    requesterMeta: { displayName: 'Provider A', appId: 'example-app' },
  },
};

// Same offer but with cherry-picking enabled (the DEFAULT is all-or-nothing).
function offerWithChoice (base = VALID_OFFER, extraRequest = {}) {
  return {
    ...base,
    content: {
      ...base.content,
      request: { ...base.content.request, allowUserChoice: true, ...extraRequest },
    },
  };
}

describe('[CMCAO] cmc/acceptOrchestration', () => {
  describe('[CMCAO-RO] readOfferViaCapability', () => {
    it('[AO01] reads the single offer event via the capability URL', async () => {
      const { fetch, calls } = fakeFetch({
        status: 200,
        body: { events: [VALID_OFFER] },
      });
      const offer = await readOfferViaCapability({
        capabilityUrl: 'https://Tok@example.com/',
        deps: { fetch },
      });
      assert.equal(offer.id, 'evt-offer');
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes('events'));
      // We query by event type — capability access permissions limit
      // the response to the single offer event the access can see.
      assert.ok(calls[0].url.includes('types'));
      assert.ok(calls[0].url.includes(encodeURIComponent('consent/request-cmc')));
      assert.equal(calls[0].init.method, 'GET');
      assert.equal(calls[0].init.headers.authorization, 'Tok');
    });

    it('[AO02] throws cmc-capability-empty when no events returned', async () => {
      const { fetch } = fakeFetch({ status: 200, body: { events: [] } });
      await assert.rejects(
        readOfferViaCapability({
          capabilityUrl: 'https://Tok@example.com/',
          deps: { fetch },
        }),
        (err) => err.id === 'cmc-capability-empty'
      );
    });

    it('[AO03] throws cmc-capability-multiple-offers when >1 events returned', async () => {
      const { fetch } = fakeFetch({
        status: 200,
        body: { events: [VALID_OFFER, { ...VALID_OFFER, id: 'evt-offer-2' }] },
      });
      await assert.rejects(
        readOfferViaCapability({
          capabilityUrl: 'https://Tok@example.com/',
          deps: { fetch },
        }),
        (err) => err.id === 'cmc-capability-multiple-offers'
      );
    });

    it('[AO04] throws on HTTP error from the capability connection', async () => {
      const { fetch } = fakeFetch({ status: 403, body: { error: 'forbidden' } });
      await assert.rejects(
        readOfferViaCapability({
          capabilityUrl: 'https://Tok@example.com/',
          deps: { fetch },
        }),
        /capability events.get failed: 403/
      );
    });

    it('[AO04B] stamps typed error.id `cmc-capability-invalid` on 401 (covers never-existed + expired-past-TTL; consumed is a distinct state caught earlier)', async () => {
      const { fetch } = fakeFetch({ status: 401, body: { error: { id: 'invalid-access-token' } } });
      await assert.rejects(
        readOfferViaCapability({
          capabilityUrl: 'https://StaleTok@example.com/',
          deps: { fetch },
        }),
        (err) => err.id === 'cmc-capability-invalid' && err.status === 401
      );
    });

    it('[AO04C] the capability read forbids redirects (redirect: error)', async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: { events: [VALID_OFFER] } });
      await readOfferViaCapability({ capabilityUrl: 'https://Tok@example.com/', deps: { fetch } });
      assert.equal(calls[0].init.redirect, 'error');
    });

    it('[AO04D] rejects an over-large response body with cmc-capability-offer-too-large', async () => {
      // Build a body whose serialized text exceeds the 256 KB cap; the
      // fake exposes it via text(), which the capped reader measures.
      const big = { events: [{ ...VALID_OFFER, content: { ...VALID_OFFER.content, blob: 'x'.repeat(300 * 1024) } }] };
      const { fetch } = fakeFetch({ status: 200, body: big });
      await assert.rejects(
        readOfferViaCapability({ capabilityUrl: 'https://Tok@example.com/', deps: { fetch } }),
        (err) => err.id === 'cmc-capability-offer-too-large'
      );
    });
  });

  describe('[CMCAO-PF] permissionsFromOffer', () => {
    it('[AO05] returns the offer.content.request.permissions array', () => {
      const perms = permissionsFromOffer(VALID_OFFER);
      assert.deepEqual(perms, [
        { streamId: 'fertility', level: 'read' },
        { streamId: 'symptom', level: 'read' },
      ]);
    });

    it('[AO06] throws cmc-offer-empty-permissions when permissions missing or empty', () => {
      assert.throws(
        () => permissionsFromOffer({ id: 'x', type: 'consent/request-cmc', content: {} }),
        (err) => err.id === 'cmc-offer-empty-permissions'
      );
      assert.throws(
        () => permissionsFromOffer({
          id: 'x',
          type: 'consent/request-cmc',
          content: { request: { permissions: [] } },
        }),
        (err) => err.id === 'cmc-offer-empty-permissions'
      );
    });
  });

  describe('[CMCAO-DG] buildDataGrantPayload', () => {
    it('[AO07] builds a shared-access payload with permissions + counterparty marker', () => {
      const payload = buildDataGrantPayload({
        offerEvent: VALID_OFFER,
        counterparty: { username: 'provider-a', host: 'example.com' },
      });
      assert.equal(payload.type, 'shared');
      assert.equal(payload.name, 'cmc:example-app:provider-a@example.com');
      assert.deepEqual(payload.permissions, [
        { streamId: 'fertility', level: 'read' },
        { streamId: 'symptom', level: 'read' },
      ]);
      assert.equal(payload.clientData.cmc.role, 'counterparty');
      assert.deepEqual(payload.clientData.cmc.counterparty, {
        username: 'provider-a',
        host: 'example.com',
      });
      assert.equal(payload.clientData.cmc.offerEventId, 'evt-offer');
      assert.equal(payload.clientData.cmc.backChannelApiEndpoint, null);
    });

    it('[AO-AT1] defaults to a shared data-grant when request.accessType is absent', () => {
      const payload = buildDataGrantPayload({
        offerEvent: VALID_OFFER,
        counterparty: { username: 'provider-a', host: 'example.com' },
      });
      assert.equal(payload.type, 'shared');
    });
    it('[AO-AT2] mints an app (delegable) data-grant when request.accessType is "app"', () => {
      const offer = { ...VALID_OFFER, content: { ...VALID_OFFER.content, request: { ...VALID_OFFER.content.request, accessType: 'app' } } };
      const payload = buildDataGrantPayload({
        offerEvent: offer,
        counterparty: { username: 'provider-a', host: 'example.com' },
      });
      assert.equal(payload.type, 'app');
      // permissions + counterparty marker unchanged by the type.
      assert.equal(payload.clientData.cmc.role, 'counterparty');
    });
    it('[AO-AT3] honors an explicit request.accessType of "shared"', () => {
      const offer = { ...VALID_OFFER, content: { ...VALID_OFFER.content, request: { ...VALID_OFFER.content.request, accessType: 'shared' } } };
      const payload = buildDataGrantPayload({
        offerEvent: offer,
        counterparty: { username: 'provider-a', host: 'example.com' },
      });
      assert.equal(payload.type, 'shared');
    });
    it('[AO-AT4] rejects any other request.accessType (not "shared"/"app")', () => {
      const offer = { ...VALID_OFFER, content: { ...VALID_OFFER.content, request: { ...VALID_OFFER.content.request, accessType: 'personal' } } };
      assert.throws(
        () => buildDataGrantPayload({ offerEvent: offer, counterparty: { username: 'x', host: 'y' } }),
        (err) => err.id === 'cmc-offer-invalid-access-type');
    });

    it('[AO08] honors a custom accessName override', () => {
      const payload = buildDataGrantPayload({
        offerEvent: VALID_OFFER,
        counterparty: { username: 'provider-a', host: 'example.com' },
        accessName: 'Custom Name',
      });
      assert.equal(payload.name, 'Custom Name');
    });

    it('[AO09] passes through optional features', () => {
      const payload = buildDataGrantPayload({
        offerEvent: VALID_OFFER,
        counterparty: { username: 'provider-a', host: 'example.com' },
        features: { chat: true, systemMessaging: false },
      });
      assert.deepEqual(payload.clientData.cmc.features, { chat: true, systemMessaging: false });
    });

    it('[AO09B] stamps acceptEventId on clientData when provided (clients look up the access by the event id they wrote)', () => {
      const payload = buildDataGrantPayload({
        offerEvent: VALID_OFFER,
        counterparty: { username: 'provider-a', host: 'example.com' },
        acceptEventId: 'evt-accept-abc123',
      });
      assert.equal(payload.clientData.cmc.acceptEventId, 'evt-accept-abc123');
    });

    it('[AO09C] defaults acceptEventId to null when omitted (back-compat for callers that don\'t pass it yet)', () => {
      const payload = buildDataGrantPayload({
        offerEvent: VALID_OFFER,
        counterparty: { username: 'provider-a', host: 'example.com' },
      });
      assert.equal(payload.clientData.cmc.acceptEventId, null);
    });

    it('[AO09D] with allowUserChoice, grantedPermissions narrows the data-grant to the accepted subset', () => {
      const payload = buildDataGrantPayload({
        offerEvent: offerWithChoice(),
        counterparty: { username: 'provider-a', host: 'example.com' },
        grantedPermissions: [{ streamId: 'fertility', level: 'read' }],
        extraPermissions: [{ streamId: ':_cmc:inbox', level: 'create-only' }],
      });
      assert.deepEqual(payload.permissions, [
        { streamId: 'fertility', level: 'read' },
        { streamId: ':_cmc:inbox', level: 'create-only' },
      ]);
    });

    it('[AO09E] grantedPermissions outside or widening the offer throws cmc-granted-permissions-not-subset', () => {
      for (const granted of [
        [{ streamId: 'fertility', level: 'manage' }], // widened level
        [{ streamId: 'other', level: 'read' }], // foreign stream
        [], // empty grant — refuse instead
        [{ feature: 'selfRevoke', setting: 'forbidden' }], // not offered
      ]) {
        assert.throws(
          () => buildDataGrantPayload({
            offerEvent: offerWithChoice(),
            counterparty: { username: 'provider-a', host: 'example.com' },
            grantedPermissions: granted,
          }),
          (err) => err.id === 'cmc-granted-permissions-not-subset'
        );
      }
    });

    it('[AO09F] full permission lexicon: a feature permission (selfRevoke) travels offer → grant', () => {
      const offer = {
        id: 'evt-offer-fp',
        type: 'consent/request-cmc',
        content: {
          requesterMeta: { appId: 'example-app' },
          request: {
            permissions: [
              { streamId: 'fertility', level: 'read' },
              { feature: 'selfRevoke', setting: 'forbidden' },
            ],
          },
        },
      };
      const full = buildDataGrantPayload({
        offerEvent: offer,
        counterparty: { username: 'provider-a', host: 'example.com' },
      });
      assert.deepEqual(full.permissions, [
        { streamId: 'fertility', level: 'read' },
        { feature: 'selfRevoke', setting: 'forbidden' },
      ]);
      const kept = buildDataGrantPayload({
        offerEvent: offerWithChoice(offer),
        counterparty: { username: 'provider-a', host: 'example.com' },
        grantedPermissions: [{ feature: 'selfRevoke', setting: 'forbidden' }],
      });
      assert.deepEqual(kept.permissions, [{ feature: 'selfRevoke', setting: 'forbidden' }]);
    });

    it('[AO09H] DEFAULT is all-or-nothing: a partial grant without allowUserChoice throws cmc-consent-user-choice-not-allowed', () => {
      assert.throws(
        () => buildDataGrantPayload({
          offerEvent: VALID_OFFER, // no allowUserChoice
          counterparty: { username: 'provider-a', host: 'example.com' },
          grantedPermissions: [{ streamId: 'fertility', level: 'read' }],
        }),
        (err) => err.id === 'cmc-consent-user-choice-not-allowed'
      );
      // granting the WHOLE set explicitly is fine without the flag
      const payload = buildDataGrantPayload({
        offerEvent: VALID_OFFER,
        counterparty: { username: 'provider-a', host: 'example.com' },
        grantedPermissions: [
          { streamId: 'fertility', level: 'read' },
          { streamId: 'symptom', level: 'read' },
        ],
      });
      assert.equal(payload.permissions.length, 2);
    });

    it('[AO09I] mandatory entries cannot be dropped even with allowUserChoice; annotation never reaches the payload', () => {
      const offer = offerWithChoice(VALID_OFFER, {
        permissions: [
          { streamId: 'fertility', level: 'read', mandatory: true },
          { streamId: 'symptom', level: 'read' },
        ],
      });
      assert.throws(
        () => buildDataGrantPayload({
          offerEvent: offer,
          counterparty: { username: 'provider-a', host: 'example.com' },
          grantedPermissions: [{ streamId: 'symptom', level: 'read' }], // drops the mandatory one
        }),
        (err) => err.id === 'cmc-mandatory-permission-refused'
      );
      const ok = buildDataGrantPayload({
        offerEvent: offer,
        counterparty: { username: 'provider-a', host: 'example.com' },
        grantedPermissions: [{ streamId: 'fertility', level: 'read' }], // keeps mandatory, drops optional
      });
      assert.deepEqual(ok.permissions, [{ streamId: 'fertility', level: 'read' }]);
      // no grantedPermissions → whole offer, with the annotation STRIPPED
      const full = buildDataGrantPayload({
        offerEvent: offer,
        counterparty: { username: 'provider-a', host: 'example.com' },
      });
      assert.deepEqual(full.permissions, [
        { streamId: 'fertility', level: 'read' },
        { streamId: 'symptom', level: 'read' },
      ]);
    });

    it('[AO09G] mangled offer permissions throw cmc-offer-invalid-permissions (not silent coercion)', () => {
      assert.throws(
        () => permissionsFromOffer({
          id: 'x',
          type: 'consent/request-cmc',
          content: { request: { permissions: [{ feature: 'selfRevoke' }] } }, // missing setting
        }),
        (err) => err.id === 'cmc-offer-invalid-permissions'
      );
    });
  });

  describe('[CMCAO-DA] deliverAcceptViaCapability', () => {
    it('[AO10] POSTs consent/accept-cmc to the per-capability responses stream with grantedAccess.apiEndpoint', async () => {
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'r1' } } });
      const r = await deliverAcceptViaCapability({
        capabilityUrl: 'https://Tok@example.com/',
        capabilityId: 'cap-xyz',
        dataGrantApiEndpoint: 'https://X@recipient.example.com/',
        counterparty: { username: 'alice', host: 'example.com' },
        deps: { fetch },
      });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
      const sent = JSON.parse(calls[0].init.body);
      assert.deepEqual(sent.streamIds, [':_cmc:_internal:responses:cap-xyz']);
      assert.equal(sent.type, 'consent/accept-cmc');
      assert.equal(sent.content.grantedAccess.apiEndpoint, 'https://X@recipient.example.com/');
      assert.deepEqual(sent.content.from, { username: 'alice', host: 'example.com' });
      // capabilityId must round-trip on the delivered event so the
      // requester-side handler can locate the capability access and
      // transition its single-use lifecycle (open → consumed) or
      // append to acceptedBy[] for open-link mode. Omitting it makes
      // the state-flip a silent no-op — a second accept on the same
      // URL then succeeds instead of being rejected with
      // `cmc-capability-consumed`.
      assert.equal(sent.content.capabilityId, 'cap-xyz');
    });

    it('[AO11] surfaces 4xx as a non-retryable failure', async () => {
      const { fetch } = fakeFetch({ status: 400, body: { error: 'bad' } });
      const r = await deliverAcceptViaCapability({
        capabilityUrl: 'https://Tok@example.com/',
        capabilityId: 'cap-xyz',
        dataGrantApiEndpoint: 'https://X@recipient.example.com/',
        counterparty: { username: 'alice', host: 'example.com' },
        deps: { fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.response.reason, 'http-4xx');
    });
  });

  describe('[CMCAO-DR] deliverRefuseViaCapability', () => {
    it('[AO12] POSTs consent/refuse-cmc to the per-capability responses stream with optional reason', async () => {
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await deliverRefuseViaCapability({
        capabilityUrl: 'https://Tok@example.com/',
        capabilityId: 'cap-xyz',
        counterparty: { username: 'alice', host: 'example.com' },
        reason: { en: 'Not at this time.' },
        deps: { fetch },
      });
      assert.equal(r.ok, true);
      const sent = JSON.parse(calls[0].init.body);
      assert.deepEqual(sent.streamIds, [':_cmc:_internal:responses:cap-xyz']);
      assert.equal(sent.type, 'consent/refuse-cmc');
      assert.deepEqual(sent.content.reason, { en: 'Not at this time.' });
      // capabilityId must round-trip on refuse for the same reason as accept
      // (see [AO10]) — the requester-side handler needs it to transition
      // capability state on refuse.
      assert.equal(sent.content.capabilityId, 'cap-xyz');
    });

    it('[AO13] passes null reason if not provided', async () => {
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      await deliverRefuseViaCapability({
        capabilityUrl: 'https://Tok@example.com/',
        capabilityId: 'cap-xyz',
        counterparty: { username: 'alice', host: 'example.com' },
        deps: { fetch },
      });
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.content.reason, null);
    });
  });
});
