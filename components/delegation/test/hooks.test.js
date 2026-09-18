/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Account-delegation plugin — guard-hook factory tests.
 *
 * The factories are pure (no api-server deps), so tests inject a fake errors
 * factory + minimal context/params and a next spy.
 */

const assert = require('node:assert/strict');
const {
  createAccessCreateForgePreventionHook,
  createAccessUpdateForgePreventionHook,
  createAccessesDeleteGuardHook,
  createAccessesUpdateGuardHook,
  createAccessesUpdateMarkerPreserveHook,
  createAccessCreateLineageHook,
  createDelegatedGrantGuardHook,
  isDelegationDerivedAccess,
  createStreamCreateReservedRootHook,
  createStreamDeleteReservedRootHook,
  createEventsWriteGuardHook,
  createEventsDeleteGuardHook,
  createEventsUpdateGuardHook,
  createEventsGetInternalGuardHook,
  createEventGetOneInternalGuardHook,
  createStreamsGetInternalGuardHook,
} = require('../src/hooks.ts');

function fakeErrors () {
  const captured = [];
  return {
    captured,
    factory: {
      invalidOperation (message, details) {
        const e = new Error(message);
        e.details = details;
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

const marker = { kind: 'control', relId: 'rel1' };
const childMarker = { kind: 'delegated-child', relId: 'rel1', delegate: { username: 'parent', hostSlug: 'core-a' }, viaAccessId: 'pat1' };
const OWNED_KINDS = ['control', 'delegate-pat', 'invite-capability', 'notify', 'some-future-kind'];

describe('[DELHOOK] delegation/hooks', () => {
  describe('[DELHOOK-AC] createAccessCreateForgePreventionHook', () => {
    it('[DAC01] passthrough when no clientData', async () => {
      const { factory, captured } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { type: 'shared', permissions: [] }, {});
      assert.equal(err, undefined);
      assert.equal(captured.length, 0);
    });

    it('[DAC02] passthrough when clientData has no delegation key', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { clientData: { appStreamId: 'x', custom: 1 } }, {});
      assert.equal(err, undefined);
    });

    it('[DAC03] rejects when clientData.delegation is present', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { clientData: { delegation: marker } }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-clientdata-forbidden');
    });

    it('[DAC04] rejects even with empty delegation object', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { clientData: { delegation: {} } }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-clientdata-forbidden');
    });

    it('[DAC05] passthrough when params is null (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessCreateForgePreventionHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, null, {}), undefined);
    });
  });

  describe('[DELHOOK-AU] createAccessUpdateForgePreventionHook', () => {
    it('[DAU01] passthrough when update has no clientData', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessUpdateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: 'a1', update: { permissions: [] } }, {});
      assert.equal(err, undefined);
    });

    it('[DAU02] passthrough when update.clientData has no delegation key', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessUpdateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: 'a1', update: { clientData: { x: 1 } } }, {});
      assert.equal(err, undefined);
    });

    it('[DAU03] rejects when update.clientData.delegation is present', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessUpdateForgePreventionHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { id: 'a1', update: { clientData: { delegation: marker } } }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-clientdata-forbidden');
    });

    it('[DAU04] passthrough when params/update absent (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessUpdateForgePreventionHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, null, {}), undefined);
      assert.equal(await runMiddleware(mw, {}, { id: 'a1' }, {}), undefined);
    });
  });

  describe('[DELHOOK-AD] createAccessesDeleteGuardHook', () => {
    it('[DAD01] passthrough for a non-delegation access', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesDeleteGuardHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { accessToDelete: { id: 'a1', clientData: { x: 1 } } }, {});
      assert.equal(err, undefined);
    });

    it('[DAD02] rejects deleting a delegation-marker access (primary target)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesDeleteGuardHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { accessToDelete: { id: 'a1', clientData: { delegation: marker } } }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-managed-resource');
    });

    it('[DAD03] rejects when a delegation-marker access is among related cascade targets', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesDeleteGuardHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {
        accessToDelete: { id: 'a1', clientData: { x: 1 } },
        relatedAccessesToDelete: [
          { id: 'a2', clientData: null },
          { id: 'a3', clientData: { delegation: marker } },
        ],
      }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-managed-resource');
    });

    it('[DAD04] passthrough when no targets present (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesDeleteGuardHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, {}, {}), undefined);
      assert.equal(await runMiddleware(mw, {}, null, {}), undefined);
    });
  });

  describe('[DELHOOK-UG] createAccessesUpdateGuardHook', () => {
    it('[DUG01] passthrough when target access has no delegation marker', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesUpdateGuardHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { targetAccess: { id: 'a1', clientData: { x: 1 } } }, {});
      assert.equal(err, undefined);
    });

    it('[DUG02] rejects updating a delegation-marker access', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesUpdateGuardHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { targetAccess: { id: 'a1', clientData: { delegation: marker } } }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-managed-resource');
    });

    it('[DUG03] passthrough when no targetAccess (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesUpdateGuardHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, {}, {}), undefined);
    });

    it('[DUG04] passthrough for a delegated-child access (updatable like any grant)', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesUpdateGuardHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { targetAccess: { id: 'a1', clientData: { delegation: childMarker } } }, {});
      assert.equal(err, undefined);
    });

    it('[DUG05] still rejects every plugin-owned kind, and an unknown kind', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesUpdateGuardHook({ errors: factory });
      for (const kind of OWNED_KINDS) {
        const err = await runMiddleware(mw, {}, { targetAccess: { id: 'a1', clientData: { delegation: { kind, relId: 'rel1' } } } }, {});
        assert.ok(err instanceof Error, kind);
        assert.equal(err.details.id, 'delegation-managed-resource');
      }
    });
  });

  describe('[DELHOOK-AD2] createAccessesDeleteGuardHook and delegated-child accesses', () => {
    it('[DAD05] passthrough for a delegated-child primary target', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesDeleteGuardHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { accessToDelete: { id: 'a1', clientData: { delegation: childMarker } } }, {});
      assert.equal(err, undefined);
    });

    it('[DAD06] passthrough when delegated-child accesses are among related cascade targets', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesDeleteGuardHook({ errors: factory });
      const err = await runMiddleware(mw, {}, {
        accessToDelete: { id: 'a1', clientData: { delegation: childMarker } },
        relatedAccessesToDelete: [{ id: 'a2', clientData: { delegation: { ...childMarker, viaAccessId: 'a1' } } }],
      }, {});
      assert.equal(err, undefined);
    });

    it('[DAD07] still rejects every plugin-owned kind, and an unknown kind', async () => {
      const { factory } = fakeErrors();
      const mw = createAccessesDeleteGuardHook({ errors: factory });
      for (const kind of OWNED_KINDS) {
        const owned = { id: 'a3', clientData: { delegation: { kind, relId: 'rel1' } } };
        for (const params of [
          { accessToDelete: owned },
          { accessToDelete: { id: 'a1', clientData: { delegation: childMarker } }, relatedAccessesToDelete: [owned] },
        ]) {
          const err = await runMiddleware(mw, {}, params, {});
          assert.ok(err instanceof Error, kind);
          assert.equal(err.details.id, 'delegation-managed-resource');
        }
      }
    });
  });

  describe('[DELHOOK-UP] createAccessesUpdateMarkerPreserveHook', () => {
    const child = () => ({ id: 'a1', clientData: { delegation: childMarker, x: 1 } });

    it('[DUP01] re-injects the marker when the update replaces clientData', async () => {
      const params = { targetAccess: child(), update: { clientData: { y: 2 } } };
      assert.equal(await runMiddleware(createAccessesUpdateMarkerPreserveHook(), {}, params, {}), undefined);
      assert.deepEqual(params.update.clientData, { y: 2, delegation: childMarker });
    });

    it('[DUP02] a null clientData removes the app keys and keeps the marker', async () => {
      const params = { targetAccess: child(), update: { clientData: null } };
      await runMiddleware(createAccessesUpdateMarkerPreserveHook(), {}, params, {});
      assert.deepEqual(params.update.clientData, { x: null, delegation: childMarker });
    });

    it('[DUP03] an update without clientData is left untouched', async () => {
      const params = { targetAccess: child(), update: { name: 'renamed' } };
      await runMiddleware(createAccessesUpdateMarkerPreserveHook(), {}, params, {});
      assert.deepEqual(params.update, { name: 'renamed' });
    });

    it('[DUP04] an access without a delegated-child marker is left untouched', async () => {
      for (const clientData of [{ x: 1 }, null, { delegation: { kind: 'control', relId: 'rel1' } }]) {
        const params = { targetAccess: { id: 'a1', clientData }, update: { clientData: { y: 2 } } };
        await runMiddleware(createAccessesUpdateMarkerPreserveHook(), {}, params, {});
        assert.deepEqual(params.update.clientData, { y: 2 });
      }
    });
  });

  describe('[DELHOOK-DG] createDelegatedGrantGuardHook', () => {
    const GATED = new Set(['consent/accept-cmc']);
    const pat = { id: 'pat1', clientData: { delegation: { kind: 'delegate-pat', relId: 'rel1' } } };
    const run = (access, type) => {
      const { factory } = fakeErrors();
      return runMiddleware(createDelegatedGrantGuardHook({ errors: factory }, GATED), { access, newEvent: { type } }, {}, {});
    };

    it('[DDG01] refuses a gated type written with the delegate token or an access it granted', async () => {
      for (const access of [pat, { id: 'c1', clientData: { delegation: childMarker } }]) {
        const err = await run(access, 'consent/accept-cmc');
        assert.ok(err instanceof Error);
        assert.equal(err.details.id, 'delegation-grant-requires-owner');
      }
    });

    it('[DDG02] lets other types, and any other access, through', async () => {
      assert.equal(await run(pat, 'note/txt'), undefined);
      for (const access of [{ id: 'p', type: 'personal', clientData: null }, { id: 'c', clientData: { delegation: marker } }, null]) {
        assert.equal(await run(access, 'consent/accept-cmc'), undefined);
      }
    });

    it('[DDG03] isDelegationDerivedAccess names exactly the delegate token and delegated children', () => {
      assert.equal(isDelegationDerivedAccess(pat), true);
      assert.equal(isDelegationDerivedAccess({ clientData: { delegation: childMarker } }), true);
      for (const kind of ['control', 'notify', 'invite-capability']) {
        assert.equal(isDelegationDerivedAccess({ clientData: { delegation: { kind } } }), false, kind);
      }
      assert.equal(isDelegationDerivedAccess({ clientData: { x: 1 } }), false);
      assert.equal(isDelegationDerivedAccess(null), false);
    });
  });

  describe('[DELHOOK-LN] createAccessCreateLineageHook', () => {
    const delegate = { username: 'parent', hostSlug: 'core-a' };

    it('[DLN01] an access created by a delegate PAT is stamped delegated-child', async () => {
      const context = { access: { id: 'pat1', clientData: { delegation: { kind: 'delegate-pat', relId: 'rel1', delegate } } } };
      const params = { name: 'app', clientData: { app: 'data' } };
      assert.equal(await runMiddleware(createAccessCreateLineageHook(), context, params, {}), undefined);
      assert.deepEqual(params.clientData, {
        app: 'data',
        delegation: { kind: 'delegated-child', relId: 'rel1', delegate, viaAccessId: 'pat1' },
      });
    });

    it('[DLN02] an access created by a delegated child carries the same relationship, via the child', async () => {
      const context = { access: { id: 'child1', clientData: { delegation: { kind: 'delegated-child', relId: 'rel1', delegate, viaAccessId: 'pat1' } } } };
      const params = { name: 'shared' };
      await runMiddleware(createAccessCreateLineageHook(), context, params, {});
      assert.deepEqual(params.clientData, {
        delegation: { kind: 'delegated-child', relId: 'rel1', delegate, viaAccessId: 'child1' },
      });
    });

    it('[DLN03] accesses without a marker do not stamp', async () => {
      for (const access of [{ id: 'p1', type: 'personal', clientData: null }, { id: 'app1', clientData: { x: 1 } }, null]) {
        const params = { name: 'x', clientData: { x: 1 } };
        await runMiddleware(createAccessCreateLineageHook(), { access }, params, {});
        assert.deepEqual(params.clientData, { x: 1 });
      }
    });

    it('[DLN04] control, notify and invite-capability markers do not stamp', async () => {
      for (const kind of ['control', 'notify', 'invite-capability']) {
        const params = { name: 'x' };
        await runMiddleware(createAccessCreateLineageHook(), { access: { id: 'm1', clientData: { delegation: { kind, relId: 'rel1' } } } }, params, {});
        assert.equal(params.clientData, undefined, kind);
      }
    });
  });

  describe('[DELHOOK-SC] createStreamCreateReservedRootHook', () => {
    it('[DSC01] passthrough for streams outside :_delegation:', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, { id: 'fertility' }, {}), undefined);
    });

    it('[DSC02] rejects creating any :_delegation:* stream', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      for (const id of [
        ':_delegation:',
        ':_delegation:_internal',
        ':_delegation:_internal:delegates',
        ':_delegation:_internal:controlled',
        ':_delegation:_internal:responses:rel1',
      ]) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.ok(err instanceof Error, 'expected reject for ' + id);
        assert.equal(err.details.id, 'delegation-reserved-stream');
        assert.equal(err.details.streamId, id);
      }
    });

    it('[DSC03] handles the { update: {...} } wrapper', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      const err = await runMiddleware(mw, {}, { update: { id: ':_delegation:_internal' } }, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-reserved-stream');
    });

    it('[DSC04] passthrough when no id (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamCreateReservedRootHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, {}, {}), undefined);
    });
  });

  describe('[DELHOOK-SD] createStreamDeleteReservedRootHook', () => {
    it('[DSD01] passthrough for streams outside :_delegation:', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, { id: 'fertility' }, {}), undefined);
    });

    it('[DSD02] rejects deleting any :_delegation:* stream', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      for (const id of [':_delegation:', ':_delegation:_internal', ':_delegation:_internal:delegates']) {
        const err = await runMiddleware(mw, {}, { id }, {});
        assert.ok(err instanceof Error, 'expected reject for ' + id);
        assert.equal(err.details.id, 'delegation-reserved-stream');
      }
    });

    it('[DSD03] passthrough when no id (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createStreamDeleteReservedRootHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, {}, {}), undefined);
    });
  });

  describe('[DELHOOK-EW] createEventsWriteGuardHook', () => {
    it('[DEW01] passthrough for a normal event', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsWriteGuardHook({ errors: factory });
      const ctx = { newEvent: { streamIds: ['fertility'], type: 'note/txt', content: 'x' } };
      assert.equal(await runMiddleware(mw, ctx, {}, {}), undefined);
    });

    it('[DEW02] rejects an event targeting a :_delegation:* stream', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsWriteGuardHook({ errors: factory });
      const ctx = { newEvent: { streamIds: [':_delegation:_internal:delegates'], type: 'note/txt' } };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-reserved-stream');
    });

    it('[DEW03] rejects an event with a delegation/* type even on a normal stream', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsWriteGuardHook({ errors: factory });
      const ctx = { newEvent: { streamIds: ['fertility'], type: 'delegation/delegate' } };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-reserved-stream');
    });

    it('[DEW04] passthrough when no newEvent (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsWriteGuardHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, {}, {}), undefined);
    });
  });

  describe('[DELHOOK-ED] createEventsDeleteGuardHook', () => {
    it('[DED01] passthrough deleting a non-delegation event', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsDeleteGuardHook({ errors: factory });
      const ctx = { oldEvent: { streamIds: ['fertility'], type: 'note/txt' } };
      assert.equal(await runMiddleware(mw, ctx, {}, {}), undefined);
    });

    it('[DED02] rejects deleting an event in a :_delegation:* stream', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsDeleteGuardHook({ errors: factory });
      const ctx = { oldEvent: { streamIds: ['fertility', ':_delegation:_internal:delegates'] } };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-managed-resource');
    });

    it('[DED03] passthrough when no oldEvent (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsDeleteGuardHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, {}, {}), undefined);
    });
  });

  describe('[DELHOOK-EU] createEventsUpdateGuardHook', () => {
    it('[DEU01] passthrough updating a non-delegation event', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsUpdateGuardHook({ errors: factory });
      const ctx = { oldEvent: { streamIds: ['fertility'], type: 'note/txt' } };
      assert.equal(await runMiddleware(mw, ctx, {}, {}), undefined);
    });

    it('[DEU02] rejects updating an event in a :_delegation:* stream', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsUpdateGuardHook({ errors: factory });
      const ctx = { oldEvent: { streamIds: [':_delegation:_internal:controlled'] } };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error);
      assert.equal(err.details.id, 'delegation-managed-resource');
    });

    it('[DEU03] passthrough when no oldEvent (defensive)', async () => {
      const { factory } = fakeErrors();
      const mw = createEventsUpdateGuardHook({ errors: factory });
      assert.equal(await runMiddleware(mw, {}, {}, {}), undefined);
    });
  });

  // Defense-in-depth read guards for the hidden `:_delegation:_internal:*`
  // subtree — mirror the cross-account-messaging plugin's internal-read guards.
  describe('[DELHOOK-IG] :_delegation:_internal:* read-path guard hooks', () => {
    describe('[DELHOOK-EG] createEventsGetInternalGuardHook (events.get)', () => {
      it('[DEG01] passes through when params.streams absent', async () => {
        const mw = createEventsGetInternalGuardHook();
        const params = { sortAscending: true };
        const err = await runMiddleware(mw, {}, params, {});
        assert.equal(err, undefined);
        assert.equal(params.streams, undefined);
      });

      it('[DEG02] strips :_delegation:_internal:* string ids, keeps others', async () => {
        const mw = createEventsGetInternalGuardHook();
        const params = {
          streams: ['fertility', ':_delegation:_internal:controlled', 'health', ':_delegation:_internal', '*'],
        };
        const err = await runMiddleware(mw, {}, params, {});
        assert.equal(err, undefined);
        assert.deepEqual(params.streams, ['fertility', 'health', '*']);
      });

      it('[DEG03] strips :_delegation:_internal:* object-form streamId queries', async () => {
        const mw = createEventsGetInternalGuardHook();
        const params = {
          streams: [
            { streamId: 'fertility', and: [] },
            { streamId: ':_delegation:_internal:delegates' },
            { streamId: ':_delegation:_internal' },
            { streamId: 'health' },
          ],
        };
        const err = await runMiddleware(mw, {}, params, {});
        assert.equal(err, undefined);
        assert.equal(params.streams.length, 2);
        assert.deepEqual(params.streams.map((s) => s.streamId), ['fertility', 'health']);
      });

      it('[DEG04] scrubs internal ids out of logical any/all/not query lists', async () => {
        const mw = createEventsGetInternalGuardHook();
        const params = {
          streams: [
            {
              any: ['fertility', ':_delegation:_internal:controlled'],
              all: [':_delegation:_internal'],
              not: ['health', ':_delegation:_internal:delegates'],
            },
          ],
        };
        const err = await runMiddleware(mw, {}, params, {});
        assert.equal(err, undefined);
        const q = params.streams[0];
        assert.deepEqual(q.any, ['fertility']);
        assert.deepEqual(q.all, []);
        assert.deepEqual(q.not, ['health']);
      });
    });

    describe('[DELHOOK-EO] createEventGetOneInternalGuardHook (events.getOne)', () => {
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

      it('[DEO01] passes through when no context.event', async () => {
        const mw = createEventGetOneInternalGuardHook(deps());
        const err = await runMiddleware(mw, {}, { id: 'e1' }, {});
        assert.equal(err, undefined);
      });

      it('[DEO02] passes through when event has only non-internal streamIds', async () => {
        const mw = createEventGetOneInternalGuardHook(deps());
        const ctx = { event: { id: 'e1', streamIds: ['fertility', 'health'] } };
        const err = await runMiddleware(mw, ctx, { id: 'e1' }, {});
        assert.equal(err, undefined);
        assert.ok(ctx.event, 'event should be left on context for next middleware');
      });

      it('[DEO03] returns 404 (unknownResource) when event has an internal streamId', async () => {
        const mw = createEventGetOneInternalGuardHook(deps());
        const ctx = { event: { id: 'e1', streamIds: [':_delegation:_internal:controlled'] } };
        const err = await runMiddleware(mw, ctx, { id: 'e1' }, {});
        assert.ok(err instanceof Error);
        assert.equal(err.details.id, 'unknown-resource');
        assert.equal(ctx.event, undefined, 'event must be dropped from context');
      });

      it('[DEO04] returns 404 even on mixed streamIds (internal presence is fatal)', async () => {
        const mw = createEventGetOneInternalGuardHook(deps());
        const ctx = { event: { id: 'e1', streamIds: ['fertility', ':_delegation:_internal:delegates'] } };
        const err = await runMiddleware(mw, ctx, { id: 'e1' }, {});
        assert.ok(err instanceof Error);
        assert.equal(err.details.id, 'unknown-resource');
      });
    });

    describe('[DELHOOK-SG] createStreamsGetInternalGuardHook (streams.get)', () => {
      it('[DSG01] passes through when result.streams absent', async () => {
        const mw = createStreamsGetInternalGuardHook();
        const result = {};
        const err = await runMiddleware(mw, {}, {}, result);
        assert.equal(err, undefined);
      });

      it('[DSG02] prunes top-level :_delegation:_internal node', async () => {
        const mw = createStreamsGetInternalGuardHook();
        const result = {
          streams: [
            { id: 'fertility', children: [] },
            { id: ':_delegation:_internal', children: [{ id: ':_delegation:_internal:controlled' }] },
            { id: 'health', children: [] },
          ],
        };
        const err = await runMiddleware(mw, {}, {}, result);
        assert.equal(err, undefined);
        assert.deepEqual(result.streams.map((s) => s.id), ['fertility', 'health']);
      });

      it('[DSG03] prunes nested :_delegation:_internal:* descendants', async () => {
        const mw = createStreamsGetInternalGuardHook();
        const result = {
          streams: [
            {
              id: ':_delegation:',
              children: [
                {
                  id: ':_delegation:_internal',
                  children: [
                    { id: ':_delegation:_internal:delegates' },
                    { id: ':_delegation:_internal:controlled' },
                  ],
                },
              ],
            },
          ],
        };
        const err = await runMiddleware(mw, {}, {}, result);
        assert.equal(err, undefined);
        // The whole :_delegation:_internal node under :_delegation: is pruned,
        // leaving the :_delegation: root with no children.
        assert.equal(result.streams.length, 1);
        assert.equal(result.streams[0].id, ':_delegation:');
        assert.deepEqual(result.streams[0].children, []);
      });
    });
  });
});
