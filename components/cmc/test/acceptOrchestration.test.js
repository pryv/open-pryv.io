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
