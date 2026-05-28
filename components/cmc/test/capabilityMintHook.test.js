/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — capabilityMintHook tests.
 *
 * [CMCMINT] covers the events.create middleware that mints the
 * capability access for consent/request-cmc + capabilityRequested:true.
 */

const assert = require('node:assert/strict');
const {
  createCapabilityMintHook,
  createCapabilityPostCreateHook,
} = require('../src/capabilityMintHook.ts');

function fakeErrors () {
  const captured = [];
  return {
    captured,
    factory: {
      invalidOperation (message, details) {
        const e = new Error(message);
        e.details = details;
        captured.push({ kind: 'invalidOperation', message, details });
        return e;
      },
      unexpectedError (err) {
        const e = new Error('unexpected: ' + (err?.message || String(err)));
        e.inner = err;
        captured.push({ kind: 'unexpectedError', err });
        return e;
      },
    },
  };
}

function fakeMall () {
  const calls = { streamsCreated: [], eventsCreated: [], accessesCreated: [], accessesUpdated: [] };
  const accessesById = new Map();
  return {
    calls,
    streams: { async create (userId, params) { calls.streamsCreated.push({ userId, ...params }); return { id: params.id }; } },
    events: { async create (userId, params) { calls.eventsCreated.push({ userId, ...params }); return { event: { id: 'e-' + calls.eventsCreated.length } }; } },
    accesses: {
      async create (userId, params) {
        const id = 'acc-' + (calls.accessesCreated.length + 1);
        const access = { id, apiEndpoint: 'https://tok-' + id + '@example.com/', ...params };
        accessesById.set(id, access);
        calls.accessesCreated.push({ userId, ...params, id });
        return access;
      },
      async get (_userId, _params) {
        return Array.from(accessesById.values());
      },
      async update (userId, params) {
        calls.accessesUpdated.push({ userId, ...params });
        const existing = accessesById.get(params.id);
        if (existing != null && params.update != null) {
          const merged = { ...existing, ...params.update };
          accessesById.set(params.id, merged);
        }
        return accessesById.get(params.id);
      },
    },
  };
}

function runMiddleware (mw, context, params, result) {
  return new Promise((resolve) => {
    mw(context, params, result, (err) => resolve(err));
  });
}

const VALID_REQUEST_CONTENT = {
  to: null,
  capabilityRequested: true,
  request: {
    title: { en: 'Example' },
    description: { en: 'desc' },
    consent: { en: 'I agree' },
    permissions: [{ streamId: 'fertility', level: 'read' }],
  },
  requesterMeta: { displayName: 'Provider', appId: 'example-app' },
};

describe('[CMCMINT] cmc/capabilityMintHook', () => {
  it('[CM01] passes through non-consent/request-cmc events', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    const mw = createCapabilityMintHook({ mall, errors: errors.factory });
    const ctx = { newEvent: { type: 'message/chat-cmc', content: { content: 'hi' } }, user: { id: 'u1' } };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.equal(err, undefined);
    assert.equal(mall.calls.accessesCreated.length, 0);
    assert.equal(ctx.newEvent.content.content, 'hi');
  });

  it('[CM02] passes through consent/request-cmc events WITHOUT capabilityRequested:true', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    const mw = createCapabilityMintHook({ mall, errors: errors.factory });
    const ctx = {
      newEvent: { type: 'consent/request-cmc', content: { ...VALID_REQUEST_CONTENT, capabilityRequested: false } },
      user: { id: 'u1' },
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.equal(err, undefined);
    assert.equal(mall.calls.accessesCreated.length, 0);
    assert.equal(ctx.newEvent.content.capabilityUrl, undefined);
  });

  it('[CM03] mints capability for consent/request-cmc + capabilityRequested:true; stamps content', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    const mw = createCapabilityMintHook({
      mall,
      errors: errors.factory,
      idGen: () => 'capX',
      now: () => 1000,
    });
    const ctx = {
      newEvent: { type: 'consent/request-cmc', content: { ...VALID_REQUEST_CONTENT } },
      user: { id: 'u1' },
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.equal(err, undefined);
    // Capability streams + offer event + access created
    assert.equal(mall.calls.streamsCreated.length, 2);
    assert.equal(mall.calls.eventsCreated.length, 1);
    assert.equal(mall.calls.accessesCreated.length, 1);
    // Trigger content stamped
    assert.equal(ctx.newEvent.content.capabilityUrl, 'https://tok-acc-1@example.com/');
    assert.equal(ctx.newEvent.content.capabilityId, 'capX');
    assert.equal(ctx.newEvent.content.capabilityAccessId, 'acc-1');
    assert.equal(ctx.newEvent.content.status, 'pending');
    // context.cmc.capabilityMinted records the handles
    assert.deepEqual(ctx.cmc.capabilityMinted, {
      capabilityId: 'capX',
      accessId: 'acc-1',
      offerStreamId: ':_cmc:_internal:offer:capX',
      responsesStreamId: ':_cmc:_internal:responses:capX',
    });
  });

  it('[CM04] preserves other content fields when stamping', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    const mw = createCapabilityMintHook({ mall, errors: errors.factory, idGen: () => 'capY' });
    const ctx = {
      newEvent: {
        type: 'consent/request-cmc',
        content: { ...VALID_REQUEST_CONTENT, customField: 'preserved' },
      },
      user: { id: 'u1' },
    };
    await runMiddleware(mw, ctx, {}, {});
    assert.equal(ctx.newEvent.content.customField, 'preserved');
    assert.deepEqual(ctx.newEvent.content.request, VALID_REQUEST_CONTENT.request);
  });

  it('[CM05] surfaces capability mint failure as an api error', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    // Make accesses.create throw to simulate downstream failure.
    mall.accesses.create = async () => { throw new Error('mall-down'); };
    const mw = createCapabilityMintHook({ mall, errors: errors.factory });
    const ctx = {
      newEvent: { type: 'consent/request-cmc', content: { ...VALID_REQUEST_CONTENT } },
      user: { id: 'u1' },
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    // Either via unexpectedError or invalidOperation depending on errors factory shape.
    assert.ok(errors.captured.length >= 1);
  });

  it('[CM06] rejects when user.id is missing on context', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    const mw = createCapabilityMintHook({ mall, errors: errors.factory });
    const ctx = {
      newEvent: { type: 'consent/request-cmc', content: { ...VALID_REQUEST_CONTENT } },
      // no user
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details?.id, 'cmc-mint-missing-user');
  });

  describe('[CMCMINT-TTL] caller-supplied expiresAt → ttlSeconds', () => {
    // Honor `request.expiresAt` as the source of truth for capability
    // TTL. Bounds [60s, 30d]; out-of-range rejected at mint time with
    // `cmc-capability-ttl-out-of-range`. Absent / non-number →
    // DEFAULT_TTL_SECONDS (7d) preserved.

    it('[CM07] threads request.expiresAt into capability access expiry within bounds', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      // Now = 1000, expiresAt = 1000 + 3600 (1 h from now), within bounds.
      const mw = createCapabilityMintHook({
        mall,
        errors: errors.factory,
        idGen: () => 'capTTL1',
        now: () => 1000,
      });
      const ctx = {
        newEvent: {
          type: 'consent/request-cmc',
          content: {
            ...VALID_REQUEST_CONTENT,
            request: { ...VALID_REQUEST_CONTENT.request, expiresAt: 1000 + 3600 },
          },
        },
        user: { id: 'u1' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      // Capability access should have expires === 1000 + 3600
      const access = mall.calls.accessesCreated[0];
      assert.equal(access.expires, 1000 + 3600);
      // Trigger content gets the stamped capabilityExpiresAt too.
      assert.equal(ctx.newEvent.content.capabilityExpiresAt, 1000 + 3600);
    });

    it('[CM08] rejects expiresAt that resolves to TTL < 60s (boundary)', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      const mw = createCapabilityMintHook({
        mall,
        errors: errors.factory,
        now: () => 1000,
      });
      const ctx = {
        newEvent: {
          type: 'consent/request-cmc',
          content: {
            ...VALID_REQUEST_CONTENT,
            request: { ...VALID_REQUEST_CONTENT.request, expiresAt: 1000 + 30 }, // 30s — too short
          },
        },
        user: { id: 'u1' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details?.id, 'cmc-capability-ttl-out-of-range');
      // No mint happened.
      assert.equal(mall.calls.accessesCreated.length, 0);
    });

    it('[CM09] rejects expiresAt that resolves to TTL > 30d (boundary)', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      const mw = createCapabilityMintHook({
        mall,
        errors: errors.factory,
        now: () => 1000,
      });
      const tooFar = 1000 + 31 * 24 * 60 * 60; // 31 days — past max
      const ctx = {
        newEvent: {
          type: 'consent/request-cmc',
          content: {
            ...VALID_REQUEST_CONTENT,
            request: { ...VALID_REQUEST_CONTENT.request, expiresAt: tooFar },
          },
        },
        user: { id: 'u1' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details?.id, 'cmc-capability-ttl-out-of-range');
      assert.equal(mall.calls.accessesCreated.length, 0);
    });

    it('[CM10] expiresAt in the PAST is rejected (computedTtlSeconds negative)', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      const mw = createCapabilityMintHook({
        mall,
        errors: errors.factory,
        now: () => 1000,
      });
      const ctx = {
        newEvent: {
          type: 'consent/request-cmc',
          content: {
            ...VALID_REQUEST_CONTENT,
            request: { ...VALID_REQUEST_CONTENT.request, expiresAt: 500 }, // in the past
          },
        },
        user: { id: 'u1' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details?.id, 'cmc-capability-ttl-out-of-range');
    });

    it('[CM11] omitted expiresAt falls back to DEFAULT_TTL_SECONDS (7d)', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      const mw = createCapabilityMintHook({
        mall,
        errors: errors.factory,
        idGen: () => 'capDef',
        now: () => 1000,
      });
      const ctx = {
        newEvent: {
          type: 'consent/request-cmc',
          content: { ...VALID_REQUEST_CONTENT }, // no expiresAt
        },
        user: { id: 'u1' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      const access = mall.calls.accessesCreated[0];
      assert.equal(access.expires, 1000 + 7 * 24 * 60 * 60);
    });

    it('[CM12] non-number expiresAt is ignored (defensive — falls back to default)', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      const mw = createCapabilityMintHook({
        mall,
        errors: errors.factory,
        idGen: () => 'capStr',
        now: () => 1000,
      });
      const ctx = {
        newEvent: {
          type: 'consent/request-cmc',
          content: {
            ...VALID_REQUEST_CONTENT,
            request: { ...VALID_REQUEST_CONTENT.request, expiresAt: '3600' }, // string, not number
          },
        },
        user: { id: 'u1' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      const access = mall.calls.accessesCreated[0];
      assert.equal(access.expires, 1000 + 7 * 24 * 60 * 60);
    });
  });

  describe('[CMCMINT-PC] capabilityPostCreateHook', () => {
    // The mint hook initially mints the access with
    // `requestEventId: null` because `context.newEvent.id` is not yet
    // assigned (mall.events.create assigns it later in the chain).
    // After createEvent persists the trigger and the mall assigns the
    // real id, this post-create hook stamps it on the access. Without
    // this, the inviteEventId enrichment on the inbox-mirror degrades
    // silently on real deploys.

    it('[CM13] stamps event.id onto capability access requestEventId after createEvent', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      const mintMw = createCapabilityMintHook({
        mall,
        errors: errors.factory,
        idGen: () => 'capPC',
        now: () => 1000,
      });
      // Step 1: mint hook runs pre-create (no event.id yet).
      const ctx = {
        newEvent: { type: 'consent/request-cmc', content: { ...VALID_REQUEST_CONTENT } },
        user: { id: 'u1' },
      };
      await runMiddleware(mintMw, ctx, {}, {});
      // At this point the capability access exists with requestEventId: null
      // (because triggerEvent.id was undefined at mint time).
      const accessIdAtMint = mall.calls.accessesCreated[0].id;
      assert.equal(mall.calls.accessesCreated[0].clientData?.cmc?.requestEventId, null);

      // Step 2: simulate createEvent assigning the persisted event id.
      ctx.newEvent.id = 'evt-trigger-real-id-42';

      // Step 3: post-create hook stamps requestEventId.
      const pcMw = createCapabilityPostCreateHook({
        mall,
        errors: errors.factory,
        logger: undefined,
      });
      const err = await runMiddleware(pcMw, ctx, {}, {});
      assert.equal(err, undefined);
      // accesses.update was called once with the new requestEventId
      assert.equal(mall.calls.accessesUpdated.length, 1);
      const updated = mall.calls.accessesUpdated[0];
      assert.equal(updated.id, accessIdAtMint);
      assert.equal(updated.update.clientData.cmc.requestEventId, 'evt-trigger-real-id-42');
      // Other clientData.cmc fields preserved (read-modify-write)
      assert.equal(updated.update.clientData.cmc.capabilityId, 'capPC');
      assert.equal(updated.update.clientData.cmc.kind, 'capability');
    });

    it('[CM14] post-create hook is idempotent — re-running on the same event/access is a no-op', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      await runMiddleware(createCapabilityMintHook({
        mall, errors: errors.factory, idGen: () => 'capIdem', now: () => 1000,
      }), {
        newEvent: { type: 'consent/request-cmc', content: { ...VALID_REQUEST_CONTENT } },
        user: { id: 'u1' },
      }, {}, {});
      const ctx = {
        newEvent: {
          id: 'evt-idem',
          type: 'consent/request-cmc',
          content: {
            capabilityRequested: true,
            capabilityAccessId: 'acc-1',
          },
        },
        user: { id: 'u1' },
      };
      const pcMw = createCapabilityPostCreateHook({ mall, errors: errors.factory });
      await runMiddleware(pcMw, ctx, {}, {});
      const updateCountAfterFirst = mall.calls.accessesUpdated.length;
      assert.equal(updateCountAfterFirst, 1);
      // Re-run: requestEventId already === 'evt-idem' → no write
      await runMiddleware(pcMw, ctx, {}, {});
      assert.equal(mall.calls.accessesUpdated.length, updateCountAfterFirst,
        'idempotent re-run must not issue a second update');
    });

    it('[CM15] post-create hook passes through non-consent/request-cmc events', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      const pcMw = createCapabilityPostCreateHook({ mall, errors: errors.factory });
      const ctx = {
        newEvent: { id: 'evt-other', type: 'message/chat-cmc', content: {} },
        user: { id: 'u1' },
      };
      await runMiddleware(pcMw, ctx, {}, {});
      assert.equal(mall.calls.accessesUpdated.length, 0);
    });

    it('[CM16] post-create hook passes through consent/request-cmc WITHOUT capabilityRequested:true', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      const pcMw = createCapabilityPostCreateHook({ mall, errors: errors.factory });
      const ctx = {
        newEvent: {
          id: 'evt-noflag',
          type: 'consent/request-cmc',
          content: { capabilityAccessId: 'acc-1' }, // no capabilityRequested
        },
        user: { id: 'u1' },
      };
      await runMiddleware(pcMw, ctx, {}, {});
      assert.equal(mall.calls.accessesUpdated.length, 0);
    });

    it('[CM17] post-create hook tolerates accesses.update failure (logs warn, doesn\'t fail trigger)', async () => {
      const errors = fakeErrors();
      const mall = fakeMall();
      await runMiddleware(createCapabilityMintHook({
        mall, errors: errors.factory, idGen: () => 'capFail', now: () => 1000,
      }), {
        newEvent: { type: 'consent/request-cmc', content: { ...VALID_REQUEST_CONTENT } },
        user: { id: 'u1' },
      }, {}, {});
      // Make the update throw.
      mall.accesses.update = async () => { throw new Error('mall-down'); };
      const ctx = {
        newEvent: {
          id: 'evt-real',
          type: 'consent/request-cmc',
          content: { capabilityRequested: true, capabilityAccessId: 'acc-1' },
        },
        user: { id: 'u1' },
      };
      let warned = false;
      const pcMw = createCapabilityPostCreateHook({
        mall,
        errors: errors.factory,
        logger: { debug: () => {}, warn: () => { warned = true; } },
      });
      const err = await runMiddleware(pcMw, ctx, {}, {});
      // Non-fatal — middleware continues
      assert.equal(err, undefined);
      assert.equal(warned, true, 'logger.warn must fire on update failure');
    });
  });
});
