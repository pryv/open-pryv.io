/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-OFR] OAuth2 — cmc offer resolution.
 *
 * Covers the short-lived resolution cache (outbound-amplification blunt)
 * and the embed bounds that keep an over-large offer out of the signed
 * state (permission-entry count + embedded text volume).
 */

const assert = require('node:assert/strict');
const { resolveOffer, clearOfferCache, OfferResolveError } = require('../src/offerResolver.ts');

const CAP_URL = 'https://CapTok@myapp.example.com/';

function offerFetch (offerEvent) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ events: [offerEvent] }) };
  };
  fn.calls = calls;
  return fn;
}

function baseOffer (overrides = {}) {
  return {
    id: 'ev-offer-1',
    type: 'consent/request-cmc',
    content: {
      capabilityId: 'cap-1',
      request: {
        title: { en: 'A study' },
        consent: { en: 'I agree.' },
        permissions: [{ streamId: 'health', level: 'read' }],
        ...overrides.request,
      },
      ...overrides.content,
    },
  };
}

describe('[OAUTH-OFR] offer resolution', () => {
  beforeEach(() => clearOfferCache());

  describe('[OAUTH-OFR-CACHE] short-lived resolution cache', () => {
    it('[OFR-C1] two resolves of the same offer collapse to ONE outbound read', async () => {
      const fetchFn = offerFetch(baseOffer());
      const a = await resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } });
      const b = await resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } });
      assert.equal(fetchFn.calls.length, 1, 'second resolve must be served from cache');
      assert.deepEqual(a.permissions, b.permissions);
      assert.equal(b.offerEventId, 'ev-offer-1');
    });

    it('[OFR-C2] clearOfferCache forces a fresh outbound read', async () => {
      const fetchFn = offerFetch(baseOffer());
      await resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } });
      clearOfferCache();
      await resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } });
      assert.equal(fetchFn.calls.length, 2);
    });

    it('[OFR-C3] a different offer name is a distinct cache key', async () => {
      const fetchFn = offerFetch(baseOffer());
      await resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } });
      await resolveOffer({ offerName: 'study-B', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } });
      assert.equal(fetchFn.calls.length, 2);
    });
  });

  describe('[OAUTH-OFR-BOUND] embed bounds', () => {
    it('[OFR-B1] too many permission entries → OfferResolveError (invalid_scope at edge)', async () => {
      const perms = [];
      for (let i = 0; i < 101; i++) perms.push({ streamId: 'stream-' + i, level: 'read' });
      const fetchFn = offerFetch(baseOffer({ request: { title: { en: 'x' }, permissions: perms } }));
      await assert.rejects(
        resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } }),
        (err) => err instanceof OfferResolveError && /too many permission entries/.test(err.message)
      );
    });

    it('[OFR-B2] exactly 100 permission entries is accepted', async () => {
      const perms = [];
      for (let i = 0; i < 100; i++) perms.push({ streamId: 'stream-' + i, level: 'read' });
      const fetchFn = offerFetch(baseOffer({ request: { title: { en: 'x' }, permissions: perms } }));
      const r = await resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } });
      assert.equal(r.permissions.length, 100);
    });

    it('[OFR-B3] oversize embedded text → OfferResolveError', async () => {
      const huge = 'x'.repeat(9 * 1024);
      const fetchFn = offerFetch(baseOffer({ request: { title: { en: 'x' }, description: { en: huge }, permissions: [{ streamId: 'health', level: 'read' }] } }));
      await assert.rejects(
        resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } }),
        (err) => err instanceof OfferResolveError && /embeds too much text/.test(err.message)
      );
    });
  });

  describe('[OAUTH-OFR-MASK] exclusion masks (level:none) are rejected at the edge', () => {
    // An offered `level:none` entry is an exclusion mask: dropping it at the
    // consent screen WIDENS access past the offer (it inverts the "granted ⊆
    // offered, dropping = narrowing" rule). Reject such offers at resolution,
    // before a signed state is ever minted.
    it('[OFR-M1] an offer masking a stream (broad read + medical:none) → OfferResolveError', async () => {
      const perms = [{ streamId: '*', level: 'read' }, { streamId: 'medical-private', level: 'none' }];
      const fetchFn = offerFetch(baseOffer({ request: { title: { en: 'x' }, permissions: perms } }));
      await assert.rejects(
        resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } }),
        (err) => err instanceof OfferResolveError && /not allowed in a consent offer/.test(err.message)
      );
    });

    it('[OFR-M2] a positive-only offer still resolves', async () => {
      const perms = [{ streamId: 'health', level: 'read' }, { streamId: 'diary', level: 'contribute' }];
      const fetchFn = offerFetch(baseOffer({ request: { title: { en: 'x' }, permissions: perms } }));
      const r = await resolveOffer({ offerName: 'study-A', capabilityUrl: CAP_URL, deps: { fetch: fetchFn } });
      assert.equal(r.permissions.length, 2);
    });
  });
});
