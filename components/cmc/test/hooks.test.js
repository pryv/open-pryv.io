/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — middleware factory tests.
 *
 * [CMCHOOK] suite covers the two write-hooks the CMC plugin contributes:
 * - createCmcContentValidationHook   → events.create chain
 * - createStreamCreateReservedRootHook → streams.create chain
 *
 * The factories are pure (no api-server deps), so tests inject fake
 * errors factory + minimal context.
 */

const assert = require('node:assert/strict');
const {
  createCmcContentValidationHook,
  createStreamCreateReservedRootHook,
  createEnsureReservedParentsHook,
} = require('../src/hooks.ts');

function fakeErrors () {
  const captured = [];
  return {
    captured,
    factory: {
      invalidOperation (message, details) {
        const e = new Error(message);
        e.details = details;
        e.cmcKind = 'invalidOperation';
        captured.push({ message, details });
        return e;
      },
    },
  };
}

function runMiddleware (mw, context, params, result) {
  return new Promise((resolve) => {
    mw(context, params, result, (err) => resolve(err));
  });
}

describe('[CMCHOOK] cmc/hooks', () => {
  describe('[CMCHOOK-EV] createCmcContentValidationHook', () => {
    it('[CH01] passes through non-:_cmc: events unchanged', async () => {
      const { factory, captured } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = { newEvent: { streamIds: ['fertility'], type: 'note/txt', content: 'x' } };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      assert.equal(captured.length, 0);
      assert.equal(ctx.cmc, undefined);
    });

    it('[CH02] marks context for any :_cmc:* stream regardless of event type', async () => {
      const { factory } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = {
        newEvent: {
          streamIds: [':_cmc:apps:my-app:study-A'],
          type: 'note/txt',
          content: 'just a note app-side metadata',
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      assert.deepEqual(ctx.cmc, {
        isCmcEvent: true,
        streamIds: [':_cmc:apps:my-app:study-A'],
      });
    });

    it('[CH03] validates a well-formed consent/request-cmc and records eventType', async () => {
      const { factory, captured } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = {
        newEvent: {
          streamIds: [':_cmc:apps:my-app:study-A'],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            request: {
              title: { en: 'Example' },
              description: { en: 'symptom tracking' },
              consent: { en: 'I agree' },
              permissions: [{ streamId: 'fertility', level: 'read' }],
            },
          },
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      assert.equal(captured.length, 0);
      assert.equal(ctx.cmc.isCmcEvent, true);
      assert.equal(ctx.cmc.eventType, 'consent/request-cmc');
    });

    it('[CH04] passes through unrecognised types under shared classes (no longer rejects)', async () => {
      // After the rename to class/format-style names, the CMC plugin
      // shares its class namespaces (consent, message, notification)
      // with potentially app-defined formats. We can't claim every
      // event in those classes — only the exact set of CMC-known
      // types triggers content validation. Other types pass through.
      const { factory, captured } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = {
        newEvent: {
          streamIds: [':_cmc:apps:foo'],
          type: 'consent/something-app-defined',
          content: {},
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      assert.equal(captured.length, 0);
    });

    it('[CH05] rejects malformed message/chat-cmc with cmc-invalid-event-content + errors list', async () => {
      const { factory } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = {
        newEvent: {
          streamIds: [':_cmc:apps:my-app:chats:alice--example-com'],
          type: 'message/chat-cmc',
          content: { content: '' }, // empty content — invalid
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-invalid-event-content');
      assert.equal(err.details.eventType, 'message/chat-cmc');
      assert.ok(Array.isArray(err.details.errors));
      assert.ok(err.details.errors[0].includes('content.content'));
    });

    it('[CH06] passes through events without context.newEvent', async () => {
      const { factory } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = {};
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
    });
  });

  describe('[CMCHOOK-ST] createStreamCreateReservedRootHook', () => {
    it('[CS01] passes through creates outside :_cmc:', async () => {
      const { factory, captured } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: 'fertility' }, {});
      assert.equal(err, undefined);
      assert.equal(captured.length, 0);
    });

    it('[CS02] rejects creating the bare reserved root :_cmc:', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: ':_cmc:' }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-reserved-stream');
      assert.equal(err.details.streamId, ':_cmc:');
    });

    it('[CS03] rejects creating reserved parents (:_cmc:inbox, :_cmc:apps, :_cmc:_internal, :_cmc:_internal:retries)', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      const reservedIds = [
        ':_cmc:inbox',
        ':_cmc:apps',
        ':_cmc:_internal',
        ':_cmc:_internal:retries',
      ];
      for (const id of reservedIds) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.ok(err instanceof Error, 'expected reject for ' + id);
        assert.equal(err.details.id, 'cmc-reserved-stream');
        assert.equal(err.details.streamId, id);
      }
    });

    it('[CS04] allows creates under :_cmc:apps:<app-code> outside plugin-reserved segments', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      for (const id of [
        ':_cmc:apps:my-app',
        ':_cmc:apps:my-app:study-A',
        ':_cmc:apps:my-app:study-A:notes',
        ':_cmc:apps:patient:incoming',
      ]) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.equal(err, undefined, 'expected passthrough for ' + id);
      }
    });

    it('[CS05] rejects creates of plugin-reserved sub-segments (chats / collectors) under :_cmc:apps:', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      const blocked = [
        // The parents themselves (plugin auto-creates)
        ':_cmc:apps:my-app:chats',
        ':_cmc:apps:my-app:collectors',
        ':_cmc:apps:my-app:study-A:chats',
        ':_cmc:apps:my-app:study-A:collectors',
        // And children of those parents
        ':_cmc:apps:my-app:chats:alice--example-com',
        ':_cmc:apps:my-app:study-A:chats:alice--example-com',
        ':_cmc:apps:my-app:study-A:collectors:bob--other-org',
      ];
      for (const id of blocked) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.ok(err instanceof Error, 'expected reject for ' + id);
        assert.equal(err.details.id, 'cmc-reserved-stream');
      }
    });

    it('[CS06] rejects creates inside :_cmc:_internal:* (plugin-internal region)', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      for (const id of [
        ':_cmc:_internal:offer:abc',
        ':_cmc:_internal:responses:abc',
        ':_cmc:_internal:foo',
      ]) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.ok(err instanceof Error, 'expected reject for ' + id);
        assert.equal(err.details.id, 'cmc-reserved-stream');
      }
    });

    it('[CS07] handles { update: {...} } wrapper used by streams.update flows', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { update: { id: ':_cmc:inbox' } }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-reserved-stream');
    });

    it('[CS08] passes through when no id is given (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {}, {});
      assert.equal(err, undefined);
    });
  });

  describe('[CMCHOOK-PR] createEnsureReservedParentsHook', () => {
    function fakeMall (opts = {}) {
      const calls = { streamsCreated: [] };
      return {
        calls,
        streams: {
          async create (_userId, params) {
            calls.streamsCreated.push(params);
            if (opts.alreadyExistAll) {
              const e = new Error('item-already-exists');
              e.id = 'item-already-exists';
              throw e;
            }
            if (opts.throwOn === params.id) {
              throw new Error('boom-' + params.id);
            }
            return { id: params.id };
          },
        },
      };
    }

    it('[CH-PR01] passes through when no user.id in context', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const err = await runMiddleware(mw, {}, {}, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 0);
    });

    it('[CH-PR02] passes through when event is not CMC-related', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const ctx = {
        user: { id: 'u1' },
        newEvent: { streamIds: ['fertility'], type: 'note/txt' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 0);
    });

    it('[CH-PR03] provisions reserved parents when event streamIds reference :_cmc:*', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const ctx = {
        user: { id: 'u1' },
        newEvent: { streamIds: [':_cmc:apps:my-app:campaign-2026'], type: 'consent/request-cmc' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      // 5 reserved parents auto-created
      assert.equal(mall.calls.streamsCreated.length, 5);
      const ids = mall.calls.streamsCreated.map((s) => s.id);
      assert.deepEqual(ids, [
        ':_cmc:',
        ':_cmc:inbox',
        ':_cmc:apps',
        ':_cmc:_internal',
        ':_cmc:_internal:retries',
      ]);
    });

    it('[CH-PR04] provisions when event.type is a known CMC type even if streamIds is empty', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const ctx = { user: { id: 'u1' }, newEvent: { streamIds: [], type: 'message/chat-cmc' } };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 5);
    });

    it('[CH-PR05] provisions on streams.create with :_cmc:* params.id', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const ctx = { user: { id: 'u1' } };
      const err = await runMiddleware(mw, ctx, { id: ':_cmc:apps:my-app' }, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 5);
    });

    it('[CH-PR06] idempotent: item-already-exists is swallowed; middleware continues', async () => {
      const mall = fakeMall({ alreadyExistAll: true });
      const mw = createEnsureReservedParentsHook({ mall });
      const ctx = {
        user: { id: 'u1' },
        newEvent: { streamIds: [':_cmc:inbox'], type: 'consent/accept-cmc' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      // 5 attempts; all "already exist" — middleware treats as success
      assert.equal(mall.calls.streamsCreated.length, 5);
    });

    it('[CH-PR07] non-fatal: unexpected provisioning failure logs + continues', async () => {
      const mall = fakeMall({ throwOn: ':_cmc:apps' });
      const warns = [];
      const mw = createEnsureReservedParentsHook({
        mall,
        logger: { debug: () => {}, warn: (msg) => warns.push(msg) },
      });
      const ctx = {
        user: { id: 'u1' },
        newEvent: { streamIds: [':_cmc:apps:foo'], type: 'consent/request-cmc' },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      // Middleware itself doesn't fail
      assert.equal(err, undefined);
      // At least one warning was logged (provisionUserStreams + our catch)
      assert.ok(warns.length >= 1, 'expected at least one warn; got ' + warns.length);
    });
  });
});
