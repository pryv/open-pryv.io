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
  createStreamDeleteReservedRootHook,
  createEnsureReservedParentsHook,
  createCounterpartyFromStampingHook,
  createAccessCreateForgePreventionHook,
  createAccessUpdateForgePreventionHook,
  createEventsGetInternalGuardHook,
  createEventGetOneInternalGuardHook,
  createStreamsGetInternalGuardHook,
  streamsParamReferencesCmc,
  _resetEnsuredUsersMemo,
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

  describe('[CMCHOOK-SD] createStreamDeleteReservedRootHook (H6)', () => {
    it('[CSD01] passes through deletes outside :_cmc:', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: 'fertility' }, {});
      assert.equal(err, undefined);
    });

    it('[CSD02] rejects delete of bare :_cmc: root', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: ':_cmc:' }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-reserved-stream-undeletable');
    });

    it('[CSD03] rejects delete of any reserved parent', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      for (const id of [':_cmc:inbox', ':_cmc:apps', ':_cmc:_internal', ':_cmc:_internal:retries']) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.ok(err instanceof Error, 'expected reject for ' + id);
        assert.equal(err.details.id, 'cmc-reserved-stream-undeletable');
      }
    });

    it('[CSD04] rejects delete inside :_cmc:_internal:* (plugin-internal)', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: ':_cmc:_internal:offer:abc' }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-reserved-stream-undeletable');
    });

    it('[CSD05] rejects delete of chats/collectors parents + children under :_cmc:apps:', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      const blocked = [
        ':_cmc:apps:my-app:chats',
        ':_cmc:apps:my-app:collectors',
        ':_cmc:apps:my-app:study-A:chats',
        ':_cmc:apps:my-app:chats:alice--example-com',
        ':_cmc:apps:my-app:study-A:collectors:bob--example-com',
      ];
      for (const id of blocked) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.ok(err instanceof Error, 'expected reject for ' + id);
        assert.equal(err.details.id, 'cmc-reserved-stream-undeletable');
      }
    });

    it('[CSD06] ALLOWS delete of user-creatable :_cmc:apps:<app>:<sub>', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      for (const id of [
        ':_cmc:apps:my-app',
        ':_cmc:apps:my-app:study-A',
        ':_cmc:apps:my-app:study-A:notes',
      ]) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.equal(err, undefined, 'expected passthrough for ' + id);
      }
    });

    it('[CSD07] passes through when no id', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {}, {});
      assert.equal(err, undefined);
    });
  });

  describe('[CMCHOOK-PR] createEnsureReservedParentsHook', () => {
    // The hook memoises already-provisioned user-ids process-wide (it
    // sits on a polling read path, so repeat work must be cheap). Reset
    // between tests, otherwise the first test to provision "u1" makes
    // every later one a no-op.
    beforeEach(() => { _resetEnsuredUsersMemo(); });

    function fakeMall (opts = {}) {
      const calls = { streamsCreated: [], probes: [] };
      const streams = {
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
      };
      // Opt-in existence probe: `opts.probe` is 'exists' | 'absent' |
      // 'throws'. Omitted → no probe on the fake at all (the hook then
      // falls back to the idempotent create path).
      if (opts.probe != null) {
        streams.getOneWithNoChildren = async (_userId, streamId) => {
          calls.probes.push(streamId);
          if (opts.probe === 'throws') throw new Error('probe-boom');
          return opts.probe === 'exists' ? { id: streamId } : null;
        };
      }
      return { calls, streams };
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

    // --- Read paths (open-pryv.io#111) ------------------------------
    //
    // Provisioning used to fire only on writes, so an account whose
    // FIRST cmc operation was a read (an inbox watcher) never got the
    // reserved tree and every poll 404'd forever.

    it('[CH-PR08] provisions on an events.get query naming a :_cmc: stream (string form)', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const ctx = { user: { id: 'u1' } };
      const err = await runMiddleware(mw, ctx, { streams: [':_cmc:inbox'] }, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 5);
    });

    it('[CH-PR09] provisions on the {streamId} object form', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const err = await runMiddleware(mw, { user: { id: 'u1' } },
        { streams: [{ streamId: ':_cmc:apps:my-app' }] }, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 5);
    });

    it('[CH-PR10] provisions on the logical-query form ({any: [...]})', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const err = await runMiddleware(mw, { user: { id: 'u1' } },
        { streams: [{ any: ['fertility', ':_cmc:inbox'] }] }, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 5);
    });

    it('[CH-PR11] does NOT provision on a read that names no :_cmc: stream', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      const err = await runMiddleware(mw, { user: { id: 'u1' } },
        { streams: ['fertility', { streamId: 'steps' }, { any: ['weight'] }] }, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 0);
    });

    // --- Cost guard: this now sits on a polling path ----------------

    it('[CH-PR12] memoises: repeated reads for the same user provision once', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      for (let i = 0; i < 5; i++) {
        await runMiddleware(mw, { user: { id: 'u1' } }, { streams: [':_cmc:inbox'] }, {});
      }
      assert.equal(mall.calls.streamsCreated.length, 5, 'exactly ONE provisioning run (5 streams), not one per poll');
    });

    it('[CH-PR13] memo is per-user — a second user still gets provisioned', async () => {
      const mall = fakeMall();
      const mw = createEnsureReservedParentsHook({ mall });
      await runMiddleware(mw, { user: { id: 'u1' } }, { streams: [':_cmc:inbox'] }, {});
      await runMiddleware(mw, { user: { id: 'u2' } }, { streams: [':_cmc:inbox'] }, {});
      assert.equal(mall.calls.streamsCreated.length, 10);
    });

    it('[CH-PR14] existence probe short-circuits creates when the tree is already there', async () => {
      const mall = fakeMall({ probe: 'exists' });
      const mw = createEnsureReservedParentsHook({ mall });
      const err = await runMiddleware(mw, { user: { id: 'u1' } }, { streams: [':_cmc:inbox'] }, {});
      assert.equal(err, undefined);
      assert.deepEqual(mall.calls.probes, [':_cmc:']);
      assert.equal(mall.calls.streamsCreated.length, 0, 'an existing tree must cost one read, zero creates');
    });

    it('[CH-PR15] probe saying "absent" still provisions', async () => {
      const mall = fakeMall({ probe: 'absent' });
      const mw = createEnsureReservedParentsHook({ mall });
      await runMiddleware(mw, { user: { id: 'u1' } }, { streams: [':_cmc:inbox'] }, {});
      assert.equal(mall.calls.probes.length, 1);
      assert.equal(mall.calls.streamsCreated.length, 5);
    });

    it('[CH-PR16] a throwing probe falls back to provisioning (never skips silently)', async () => {
      const mall = fakeMall({ probe: 'throws' });
      const mw = createEnsureReservedParentsHook({ mall });
      const err = await runMiddleware(mw, { user: { id: 'u1' } }, { streams: [':_cmc:inbox'] }, {});
      assert.equal(err, undefined);
      assert.equal(mall.calls.streamsCreated.length, 5);
    });
  });

  describe('[CMCHOOK-SP] streamsParamReferencesCmc', () => {
    it('[CH-SP01] detects cmc ids across all accepted query forms', () => {
      assert.equal(streamsParamReferencesCmc([':_cmc:inbox']), true);
      assert.equal(streamsParamReferencesCmc([{ streamId: ':_cmc:apps:a' }]), true);
      assert.equal(streamsParamReferencesCmc([{ any: ['x', ':_cmc:inbox'] }]), true);
      assert.equal(streamsParamReferencesCmc([{ all: [':_cmc:apps:a'] }]), true);
      assert.equal(streamsParamReferencesCmc([{ not: [':_cmc:apps:a'] }]), true);
    });

    it('[CH-SP02] false for non-cmc queries and malformed input', () => {
      assert.equal(streamsParamReferencesCmc(['fertility']), false);
      assert.equal(streamsParamReferencesCmc([{ streamId: 'steps' }]), false);
      assert.equal(streamsParamReferencesCmc([{ any: ['a', 'b'] }]), false);
      assert.equal(streamsParamReferencesCmc(undefined), false);
      assert.equal(streamsParamReferencesCmc('not-an-array'), false);
      assert.equal(streamsParamReferencesCmc([null, 42]), false);
    });
  });

  describe('[CMCHOOK-IG] :_cmc:_internal:* read-path guard hooks (H5)', () => {
    describe('[CMCHOOK-EG] createEventsGetInternalGuardHook (events.get)', () => {
      it('[CH-EG01] passes through when params.streams absent', async () => {
        const mw = createEventsGetInternalGuardHook();
        const params = { sortAscending: true };
        const err = await runMiddleware(mw, {}, params, {});
        assert.equal(err, undefined);
        assert.equal(params.streams, undefined);
      });

      it('[CH-EG02] strips :_cmc:_internal:* string ids, keeps others', async () => {
        const mw = createEventsGetInternalGuardHook();
        const params = {
          streams: ['fertility', ':_cmc:_internal:offer:abc', ':_cmc:apps:my-app', ':_cmc:_internal', '*'],
        };
        const err = await runMiddleware(mw, {}, params, {});
        assert.equal(err, undefined);
        assert.deepEqual(params.streams, ['fertility', ':_cmc:apps:my-app', '*']);
      });

      it('[CH-EG03] strips :_cmc:_internal:* object-form streamId queries', async () => {
        const mw = createEventsGetInternalGuardHook();
        const params = {
          streams: [
            { streamId: 'fertility', and: [] },
            { streamId: ':_cmc:_internal:responses:abc' },
            { streamId: ':_cmc:_internal' },
            { streamId: ':_cmc:apps:foo' },
          ],
        };
        const err = await runMiddleware(mw, {}, params, {});
        assert.equal(err, undefined);
        assert.equal(params.streams.length, 2);
        assert.deepEqual(params.streams.map((s) => s.streamId), ['fertility', ':_cmc:apps:foo']);
      });
    });

    describe('[CMCHOOK-EO] createEventGetOneInternalGuardHook (events.getOne)', () => {
      function deps () {
        return {
          errors: {
            unknownResource (resource, id) {
              const e = new Error('unknown ' + resource + ' ' + id);
              e.details = { id: 'unknown-resource', resource, missing: id };
              return e;
            },
            invalidOperation (msg, details) {
              const e = new Error(msg);
              e.details = details;
              return e;
            },
          },
        };
      }

      it('[CH-EO01] passes through when no context.event', async () => {
        const mw = createEventGetOneInternalGuardHook(deps());
        const ctx = {};
        const err = await runMiddleware(mw, ctx, { id: 'e1' }, {});
        assert.equal(err, undefined);
      });

      it('[CH-EO02] passes through when event has only non-internal streamIds', async () => {
        const mw = createEventGetOneInternalGuardHook(deps());
        const ctx = { event: { id: 'e1', streamIds: ['fertility', ':_cmc:apps:foo'] } };
        const err = await runMiddleware(mw, ctx, { id: 'e1' }, {});
        assert.equal(err, undefined);
        assert.ok(ctx.event, 'event should be left on context for next middleware');
      });

      it('[CH-EO03] returns 404 (unknownResource) when event has an internal streamId', async () => {
        const mw = createEventGetOneInternalGuardHook(deps());
        const ctx = { event: { id: 'e1', streamIds: [':_cmc:_internal:offer:abc'] } };
        const err = await runMiddleware(mw, ctx, { id: 'e1' }, {});
        assert.ok(err instanceof Error);
        assert.equal(err.details.id, 'unknown-resource');
        assert.equal(ctx.event, undefined, 'event must be dropped from context');
      });

      it('[CH-EO04] returns 404 even on mixed streamIds (internal presence is fatal)', async () => {
        const mw = createEventGetOneInternalGuardHook(deps());
        const ctx = { event: { id: 'e1', streamIds: ['fertility', ':_cmc:_internal:retries'] } };
        const err = await runMiddleware(mw, ctx, { id: 'e1' }, {});
        assert.ok(err instanceof Error);
        assert.equal(err.details.id, 'unknown-resource');
      });
    });

    describe('[CMCHOOK-SG] createStreamsGetInternalGuardHook (streams.get)', () => {
      it('[CH-SG01] passes through when result.streams absent', async () => {
        const mw = createStreamsGetInternalGuardHook();
        const result = {};
        const err = await runMiddleware(mw, {}, {}, result);
        assert.equal(err, undefined);
      });

      it('[CH-SG02] prunes top-level :_cmc:_internal node', async () => {
        const mw = createStreamsGetInternalGuardHook();
        const result = {
          streams: [
            { id: 'fertility', children: [] },
            { id: ':_cmc:_internal', children: [{ id: ':_cmc:_internal:retries' }] },
            { id: ':_cmc:apps', children: [{ id: ':_cmc:apps:foo' }] },
          ],
        };
        const err = await runMiddleware(mw, {}, {}, result);
        assert.equal(err, undefined);
        assert.deepEqual(result.streams.map((s) => s.id), ['fertility', ':_cmc:apps']);
      });

      it('[CH-SG03] prunes nested :_cmc:_internal:* descendants', async () => {
        const mw = createStreamsGetInternalGuardHook();
        const result = {
          streams: [
            {
              id: ':_cmc:',
              children: [
                { id: ':_cmc:inbox', children: [] },
                {
                  id: ':_cmc:_internal',
                  children: [
                    { id: ':_cmc:_internal:offer:abc' },
                    { id: ':_cmc:_internal:responses:abc' },
                  ],
                },
              ],
            },
          ],
        };
        const err = await runMiddleware(mw, {}, {}, result);
        assert.equal(err, undefined);
        assert.equal(result.streams[0].children.length, 1);
        assert.equal(result.streams[0].children[0].id, ':_cmc:inbox');
      });
    });
  });

  describe('[CMCHOOK-CF] createCounterpartyFromStampingHook (H8)', () => {
    function counterpartyAccess (cp = { username: 'alice', host: 'alice.example.com' }) {
      return { id: 'a1', clientData: { cmc: { role: 'counterparty', counterparty: cp } } };
    }

    it('[CH-CF01] passes through when no newEvent', async () => {
      const { factory } = fakeErrors();
      const mw = createCounterpartyFromStampingHook({ errors: factory });
      const err = await runMiddleware(mw, { access: counterpartyAccess() }, {}, {});
      assert.equal(err, undefined);
    });

    it('[CH-CF02] passes through for non-chat/system event types', async () => {
      const { factory } = fakeErrors();
      const mw = createCounterpartyFromStampingHook({ errors: factory });
      const ctx = {
        access: counterpartyAccess(),
        newEvent: {
          streamIds: [':_cmc:apps:my-app:study-A'],
          type: 'note/txt',
          content: { from: { username: 'forged', host: 'evil.com' }, text: 'hi' },
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      // content.from preserved (we only stamp known cmc message types)
      assert.equal(ctx.newEvent.content.from.username, 'forged');
    });

    it('[CH-CF03] passes through when writer is not a counterparty access', async () => {
      const { factory } = fakeErrors();
      const mw = createCounterpartyFromStampingHook({ errors: factory });
      const ctx = {
        access: { id: 'a1', type: 'personal' },
        newEvent: {
          streamIds: [':_cmc:apps:my-app:chats:alice--alice-example-com'],
          type: 'message/chat-cmc',
          content: { from: { username: 'self-claim', host: 'me.com' }, content: 'hi' },
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      // Local self-writes preserved — not a cross-actor forge vector.
      assert.equal(ctx.newEvent.content.from.username, 'self-claim');
    });

    it('[CH-CF04] passes through writes to :_cmc:inbox (inboxWriteHook owns them)', async () => {
      const { factory } = fakeErrors();
      const mw = createCounterpartyFromStampingHook({ errors: factory });
      const ctx = {
        access: counterpartyAccess({ username: 'alice', host: 'alice.example.com' }),
        newEvent: {
          streamIds: [':_cmc:inbox'],
          type: 'message/chat-cmc',
          content: { from: { username: 'forged', host: 'evil.com' }, content: 'hi' },
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      // Untouched here — inboxWriteHook handles inbox-bound writes.
      assert.equal(ctx.newEvent.content.from.username, 'forged');
    });

    it('[CH-CF05] stamps content.from from access identity on chat to per-app stream', async () => {
      const { factory } = fakeErrors();
      const mw = createCounterpartyFromStampingHook({ errors: factory });
      const ctx = {
        access: counterpartyAccess({ username: 'alice', host: 'alice.example.com' }),
        newEvent: {
          streamIds: [':_cmc:apps:my-app:chats:bob--bob-example-com'],
          type: 'message/chat-cmc',
          content: { from: { username: 'forged', host: 'evil.com' }, content: 'hi' },
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      assert.deepEqual(ctx.newEvent.content.from, {
        username: 'alice', host: 'alice.example.com',
      });
      assert.equal(ctx.newEvent.content.content, 'hi'); // payload preserved
    });

    it('[CH-CF06] stamps on system alert + ack + scope-request + scope-update', async () => {
      const { factory } = fakeErrors();
      const mw = createCounterpartyFromStampingHook({ errors: factory });
      const types = [
        'notification/alert-cmc',
        'notification/ack-cmc',
        'consent/scope-request-cmc',
        'consent/scope-update-cmc',
      ];
      for (const t of types) {
        const ctx = {
          access: counterpartyAccess({ username: 'alice', host: 'alice.example.com' }),
          newEvent: {
            streamIds: [':_cmc:apps:my-app:collectors:bob--bob-example-com'],
            type: t,
            content: { from: { username: 'forged', host: 'evil.com' }, payload: 1 },
          },
        };
        const err = await runMiddleware(mw, ctx, {}, {});
        assert.equal(err, undefined, 'expected no error for ' + t);
        assert.equal(ctx.newEvent.content.from.username, 'alice', 'stamping failed for ' + t);
        assert.equal(ctx.newEvent.content.payload, 1);
      }
    });

    it('[CH-CF07] rejects when counterparty access missing identity (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createCounterpartyFromStampingHook({ errors: factory });
      const ctx = {
        access: { id: 'a1', clientData: { cmc: { role: 'counterparty', counterparty: {} } } },
        newEvent: {
          streamIds: [':_cmc:apps:my-app:chats:bob--bob-example-com'],
          type: 'message/chat-cmc',
          content: { content: 'hi' },
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-counterparty-identity-missing');
    });

    it('[CH-CF08] sets content.from even when caller omits it entirely', async () => {
      const { factory } = fakeErrors();
      const mw = createCounterpartyFromStampingHook({ errors: factory });
      const ctx = {
        access: counterpartyAccess({ username: 'alice', host: 'alice.example.com' }),
        newEvent: {
          streamIds: [':_cmc:apps:my-app:chats:bob--bob-example-com'],
          type: 'message/chat-cmc',
          content: { content: 'no from' },
        },
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined);
      assert.deepEqual(ctx.newEvent.content.from, {
        username: 'alice', host: 'alice.example.com',
      });
    });
  });

  describe('[CMCHOOK-AC] createAccessCreateForgePreventionHook (H7)', () => {
    it('[CH-AC01] passes through when params.clientData is absent', async () => {
      const { factory, captured } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { type: 'shared', permissions: [] }, {});
      assert.equal(err, undefined);
      assert.equal(captured.length, 0);
    });

    it('[CH-AC02] passes through when params.clientData has no cmc key', async () => {
      const { factory, captured } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {
        type: 'shared',
        permissions: [],
        clientData: { appStreamId: 'my-app', custom: 1 },
      }, {});
      assert.equal(err, undefined);
      assert.equal(captured.length, 0);
    });

    it('[CH-AC03] rejects when params.clientData.cmc is set (any nested fields)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {
        type: 'shared',
        permissions: [],
        clientData: { cmc: { role: 'counterparty' } },
      }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-clientdata-cmc-forbidden');
    });

    it('[CH-AC04] rejects even with empty cmc object (any presence forbidden)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {
        type: 'shared',
        permissions: [],
        clientData: { cmc: {} },
      }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-clientdata-cmc-forbidden');
    });

    it('[CH-AC05] passthrough when params is null/undefined (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, null, {});
      assert.equal(err, undefined);
    });
  });

  describe('[CMCHOOK-AU] createAccessUpdateForgePreventionHook (H7)', () => {
    it('[CH-AU01] passes through when params.update has no clientData', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessUpdateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: 'a1', update: { permissions: [] } }, {});
      assert.equal(err, undefined);
    });

    it('[CH-AU02] passes through when update.clientData has no cmc key', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessUpdateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {
        id: 'a1',
        update: { clientData: { appStreamId: 'x' } },
      }, {});
      assert.equal(err, undefined);
    });

    it('[CH-AU03] rejects when update.clientData.cmc is set', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessUpdateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {
        id: 'a1',
        update: { clientData: { cmc: { role: 'counterparty' } } },
      }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'cmc-clientdata-cmc-forbidden');
    });

    it('[CH-AU04] passthrough when params or params.update absent (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessUpdateForgePreventionHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, null, {}), undefined);
      assert.equal(await runMiddleware(mw, {}, { id: 'a1' }, {}), undefined);
    });
  });
});
