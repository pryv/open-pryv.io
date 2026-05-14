/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — capability access mint + GC tests.
 *
 * [CMCCAP] covers mintCapability + gcCapability against a fake mall.
 */

const assert = require('node:assert/strict');
const {
  mintCapability,
  gcCapability,
  buildApiEndpoint,
  DEFAULT_TTL_SECONDS,
} = require('../src/capability.ts');

function fakeMall () {
  const calls = { streamsCreated: [], eventsCreated: [], accessesCreated: [], deletes: [] };
  let nextAccessIdx = 0;
  return {
    calls,
    streams: {
      async create (userId, params) {
        calls.streamsCreated.push({ userId, ...params });
        return { id: params.id };
      },
      async delete (userId, params) {
        calls.deletes.push({ kind: 'stream', userId, id: params.id });
      },
    },
    events: {
      async create (userId, params) {
        calls.eventsCreated.push({ userId, ...params });
        return { event: { id: 'evt-' + calls.eventsCreated.length, ...params } };
      },
    },
    accesses: {
      async create (userId, params) {
        const id = 'acc-' + (++nextAccessIdx);
        const access = {
          id,
          token: 'tok-' + id,
          apiEndpoint: 'https://tok-' + id + '@example.com/',
          ...params,
        };
        calls.accessesCreated.push({ userId, ...params, id });
        return access;
      },
      async delete (userId, params) {
        calls.deletes.push({ kind: 'access', userId, id: params.id });
      },
    },
  };
}

const VALID_REQUEST_TRIGGER = {
  id: 'evt-trigger-1',
  type: 'cmc/request-v1',
  content: {
    to: null,
    capabilityRequested: true,
    request: {
      title: { en: 'Example consent' },
      description: { en: 'description' },
      consent: { en: 'I agree.' },
      permissions: [{ streamId: 'fertility', level: 'read' }],
    },
    requesterMeta: { displayName: 'Provider A' },
  },
};

describe('[CMCCAP] cmc/capability', () => {
  describe('[CMCCAP-MINT] mintCapability', () => {
    it('[CC01] creates two per-capability streams + one offer event + one shared access', async () => {
      const mall = fakeMall();
      const result = await mintCapability({
        userId: 'u1',
        triggerEvent: VALID_REQUEST_TRIGGER,
        deps: { mall, idGen: () => 'cap123', now: () => 1000 },
      });
      assert.equal(result.capabilityId, 'cap123');
      assert.equal(result.offerStreamId, ':_cmc:_internal:offer:cap123');
      assert.equal(result.responsesStreamId, ':_cmc:_internal:responses:cap123');
      assert.equal(result.expiresAt, 1000 + DEFAULT_TTL_SECONDS);
      assert.equal(result.accessId, 'acc-1');
      assert.equal(result.capabilityUrl, 'https://tok-acc-1@example.com/');
      // Streams: offer + responses, in that order
      assert.equal(mall.calls.streamsCreated.length, 2);
      assert.equal(mall.calls.streamsCreated[0].id, ':_cmc:_internal:offer:cap123');
      assert.equal(mall.calls.streamsCreated[1].id, ':_cmc:_internal:responses:cap123');
      // Both under :_cmc:_internal
      for (const s of mall.calls.streamsCreated) {
        assert.equal(s.parentId, ':_cmc:_internal');
      }
      // Offer event populated
      assert.equal(mall.calls.eventsCreated.length, 1);
      assert.deepEqual(mall.calls.eventsCreated[0].streamIds, [':_cmc:_internal:offer:cap123']);
      assert.equal(mall.calls.eventsCreated[0].type, 'cmc/request-v1');
      // Access shape
      assert.equal(mall.calls.accessesCreated.length, 1);
      const acc = mall.calls.accessesCreated[0];
      assert.equal(acc.type, 'shared');
      assert.ok(acc.name.startsWith('__cmc-cap-'));
      assert.deepEqual(acc.permissions, [
        { streamId: ':_cmc:_internal:offer:cap123', level: 'read' },
        { streamId: ':_cmc:_internal:responses:cap123', level: 'create-only' },
      ]);
      assert.equal(acc.clientData.cmc.kind, 'capability');
      assert.equal(acc.clientData.cmc.capabilityId, 'cap123');
      assert.equal(acc.clientData.cmc.requestEventId, 'evt-trigger-1');
      assert.equal(acc.clientData.cmc.singleUse, true);
      assert.equal(acc.expires, 1000 + DEFAULT_TTL_SECONDS);
    });

    it('[CC02] strips capabilityRequested + plugin-stamped fields from the offer event content', async () => {
      const mall = fakeMall();
      await mintCapability({
        userId: 'u1',
        triggerEvent: {
          ...VALID_REQUEST_TRIGGER,
          content: {
            ...VALID_REQUEST_TRIGGER.content,
            capabilityRequested: true,
            capabilityUrl: 'should-not-leak',
            capabilityExpiresAt: 1234,
            status: 'pending',
            failure: { reason: 'should-not-leak' },
          },
        },
        deps: { mall, idGen: () => 'cap2', now: () => 1000 },
      });
      const offer = mall.calls.eventsCreated[0];
      assert.equal(offer.content.capabilityRequested, undefined);
      assert.equal(offer.content.capabilityUrl, undefined);
      assert.equal(offer.content.capabilityExpiresAt, undefined);
      assert.equal(offer.content.status, undefined);
      assert.equal(offer.content.failure, undefined);
      // But the actual request payload survives
      assert.deepEqual(offer.content.request, VALID_REQUEST_TRIGGER.content.request);
    });

    it('[CC03] honors a custom ttlSeconds', async () => {
      const mall = fakeMall();
      const r = await mintCapability({
        userId: 'u1',
        triggerEvent: VALID_REQUEST_TRIGGER,
        ttlSeconds: 60,
        deps: { mall, idGen: () => 'cap3', now: () => 1000 },
      });
      assert.equal(r.expiresAt, 1060);
      assert.equal(mall.calls.accessesCreated[0].expires, 1060);
    });

    it('[CC04] rejects when triggerEvent is not cmc/request-v1', async () => {
      const mall = fakeMall();
      await assert.rejects(
        mintCapability({
          userId: 'u1',
          triggerEvent: { type: 'cmc/chat-v1', content: {} },
          deps: { mall },
        }),
        /must be cmc\/request-v1/
      );
      assert.equal(mall.calls.streamsCreated.length, 0);
      assert.equal(mall.calls.accessesCreated.length, 0);
    });

    it('[CC05] uses serviceUrlBase fallback when access lacks apiEndpoint', async () => {
      // Override the fake to return an access without apiEndpoint.
      const mall = fakeMall();
      mall.accesses.create = async (userId, params) => ({
        id: 'acc-x',
        token: 'TOK',
        ...params,
      });
      const r = await mintCapability({
        userId: 'u1',
        triggerEvent: VALID_REQUEST_TRIGGER,
        deps: { mall, idGen: () => 'cap5', now: () => 1000, serviceUrlBase: 'https://example.com' },
      });
      assert.equal(r.capabilityUrl, 'https://TOK@example.com/');
    });

    it('[CC06] throws when access has no apiEndpoint AND no serviceUrlBase given', async () => {
      const mall = fakeMall();
      mall.accesses.create = async (userId, params) => ({ id: 'acc-x', token: 'TOK', ...params });
      await assert.rejects(
        mintCapability({
          userId: 'u1',
          triggerEvent: VALID_REQUEST_TRIGGER,
          deps: { mall },
        }),
        /no apiEndpoint and no serviceUrlBase/
      );
    });
  });

  describe('[CMCCAP-GC] gcCapability', () => {
    it('[CC07] deletes the access + both per-capability streams', async () => {
      const mall = fakeMall();
      await gcCapability({
        userId: 'u1',
        capabilityId: 'cap-gc',
        accessId: 'acc-gc',
        deps: { mall },
      });
      // Order: access first, then streams
      assert.deepEqual(mall.calls.deletes, [
        { kind: 'access', userId: 'u1', id: 'acc-gc' },
        { kind: 'stream', userId: 'u1', id: ':_cmc:_internal:offer:cap-gc' },
        { kind: 'stream', userId: 'u1', id: ':_cmc:_internal:responses:cap-gc' },
      ]);
    });

    it('[CC08] is idempotent — tolerates "not found" on access or streams', async () => {
      const mall = fakeMall();
      mall.accesses.delete = async () => { const e = new Error('access not found'); e.id = 'unknown-resource'; throw e; };
      mall.streams.delete = async () => { const e = new Error('stream not found'); e.id = 'unknown-resource'; throw e; };
      await gcCapability({
        userId: 'u1',
        capabilityId: 'cap-gc-2',
        accessId: 'acc-gc-2',
        deps: { mall },
      });
      // No throw — already-cleaned capability handled gracefully.
    });

    it('[CC09] re-throws unexpected errors (not "not found")', async () => {
      const mall = fakeMall();
      mall.accesses.delete = async () => { throw new Error('database unreachable'); };
      await assert.rejects(
        gcCapability({
          userId: 'u1',
          capabilityId: 'cap-gc-3',
          accessId: 'acc-gc-3',
          deps: { mall },
        }),
        /database unreachable/
      );
    });
  });

  describe('[CMCCAP-AE] buildApiEndpoint', () => {
    it('[CC10] inserts the token as URL username with a trailing slash', () => {
      assert.equal(
        buildApiEndpoint('https://example.com', 'AbC'),
        'https://AbC@example.com/'
      );
    });

    it('[CC11] supports a port', () => {
      assert.equal(
        buildApiEndpoint('https://example.com:8443/', 'AbC'),
        'https://AbC@example.com:8443/'
      );
    });

    it('[CC12] rejects non-absolute base', () => {
      assert.throws(() => buildApiEndpoint('example.com', 'AbC'), /absolute URL/);
    });

    it('[CC13] rejects empty token', () => {
      assert.throws(() => buildApiEndpoint('https://example.com', ''), /missing access token/);
    });
  });
});
