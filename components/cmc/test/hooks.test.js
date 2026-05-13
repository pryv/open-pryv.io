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

    it('[CH03] validates a well-formed cmc/request-v1 and records eventType', async () => {
      const { factory, captured } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = {
        newEvent: {
          streamIds: [':_cmc:apps:my-app:study-A'],
          type: 'cmc/request-v1',
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
      assert.equal(ctx.cmc.eventType, 'cmc/request-v1');
    });

    it('[CH04] rejects an unknown cmc/* event type with cmc-unknown-event-type', async () => {
      const { factory, captured } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = {
        newEvent: {
          streamIds: [':_cmc:apps:foo'],
          type: 'cmc/nonsense-v1',
          content: {},
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-unknown-event-type');
      assert.equal(captured.length, 1);
    });

    it('[CH05] rejects malformed cmc/chat-v1 with cmc-invalid-event-content + errors list', async () => {
      const { factory } = fakeErrors();
      const mw = createCmcContentValidationHook({ errors: factory });
      const ctx = {
        newEvent: {
          streamIds: [':_cmc:apps:my-app:chats:alice--example-com'],
          type: 'cmc/chat-v1',
          content: { content: '' }, // empty content — invalid
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-invalid-event-content');
      assert.equal(err.details.eventType, 'cmc/chat-v1');
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
});
