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
  createStreamCreateReservedRootHook,
  createStreamDeleteReservedRootHook,
  createEventsWriteGuardHook,
  createEventsDeleteGuardHook,
  createEventsUpdateGuardHook,
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
});
