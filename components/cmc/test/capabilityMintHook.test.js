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
 * capability access for cmc/request-v1 + capabilityRequested:true.
 */

const assert = require('node:assert/strict');
const { createCapabilityMintHook } = require('../src/capabilityMintHook.ts');

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
  const calls = { streamsCreated: [], eventsCreated: [], accessesCreated: [] };
  return {
    calls,
    streams: { async create (userId, params) { calls.streamsCreated.push({ userId, ...params }); return { id: params.id }; } },
    events: { async create (userId, params) { calls.eventsCreated.push({ userId, ...params }); return { event: { id: 'e-' + calls.eventsCreated.length } }; } },
    accesses: {
      async create (userId, params) {
        const id = 'acc-' + (calls.accessesCreated.length + 1);
        calls.accessesCreated.push({ userId, ...params, id });
        return { id, apiEndpoint: 'https://tok-' + id + '@example.com/', ...params };
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
  it('[CM01] passes through non-cmc/request-v1 events', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    const mw = createCapabilityMintHook({ mall, errors: errors.factory });
    const ctx = { newEvent: { type: 'cmc/chat-v1', content: { content: 'hi' } }, user: { id: 'u1' } };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.equal(err, undefined);
    assert.equal(mall.calls.accessesCreated.length, 0);
    assert.equal(ctx.newEvent.content.content, 'hi');
  });

  it('[CM02] passes through cmc/request-v1 events WITHOUT capabilityRequested:true', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    const mw = createCapabilityMintHook({ mall, errors: errors.factory });
    const ctx = {
      newEvent: { type: 'cmc/request-v1', content: { ...VALID_REQUEST_CONTENT, capabilityRequested: false } },
      user: { id: 'u1' },
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.equal(err, undefined);
    assert.equal(mall.calls.accessesCreated.length, 0);
    assert.equal(ctx.newEvent.content.capabilityUrl, undefined);
  });

  it('[CM03] mints capability for cmc/request-v1 + capabilityRequested:true; stamps content', async () => {
    const errors = fakeErrors();
    const mall = fakeMall();
    const mw = createCapabilityMintHook({
      mall,
      errors: errors.factory,
      idGen: () => 'capX',
      now: () => 1000,
    });
    const ctx = {
      newEvent: { type: 'cmc/request-v1', content: { ...VALID_REQUEST_CONTENT } },
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
        type: 'cmc/request-v1',
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
      newEvent: { type: 'cmc/request-v1', content: { ...VALID_REQUEST_CONTENT } },
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
      newEvent: { type: 'cmc/request-v1', content: { ...VALID_REQUEST_CONTENT } },
      // no user
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details?.id, 'cmc-mint-missing-user');
  });
});
