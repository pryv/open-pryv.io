/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./test-helper');
const assert = require('node:assert');
const { streamQueryAddForcedAndForbiddenStreams } = require('../../src/methods/helpers/eventsGetUtils.ts');

function makeContext (forced, forbidden) {
  return {
    access: {
      getForcedStreamsGetEventsStreamIds: () => forced,
      getForbiddenGetEventsStreamIds: () => forbidden,
      isPersonal: () => true
    }
  };
}

function makeParams (initialAll, initialNot, storeId = 'local') {
  return {
    arrayOfStreamQueriesWithStoreId: [{
      storeId,
      all: initialAll,
      not: initialNot
    }]
  };
}

describe('[EGU] eventsGetUtils', () => {
  describe('[EGUF] streamQueryAddForcedAndForbiddenStreams', () => {
    it('[EGUF01] appends forced ids when streamQuery.all has no overlap', (done) => {
      const ctx = makeContext(['s1', 's2'], null);
      const params = makeParams(['original'], null);
      streamQueryAddForcedAndForbiddenStreams(ctx, params, null, (err) => {
        assert.strictEqual(err, undefined);
        assert.deepStrictEqual(params.arrayOfStreamQueriesWithStoreId[0].all, ['original', 's1', 's2']);
        done();
      });
    });

    it('[EGUF02] de-duplicates forced ids when caller already supplied one of them', (done) => {
      const ctx = makeContext(['s1', 's2'], null);
      const params = makeParams(['s1'], null);
      streamQueryAddForcedAndForbiddenStreams(ctx, params, null, (err) => {
        assert.strictEqual(err, undefined);
        const all = params.arrayOfStreamQueriesWithStoreId[0].all;
        assert.deepStrictEqual(all, ['s1', 's2']);
        assert.strictEqual(new Set(all).size, all.length, 'all must contain no duplicates');
        done();
      });
    });

    it('[EGUF03] de-duplicates forbidden ids when caller already supplied one of them', (done) => {
      const ctx = makeContext(null, ['f1', 'f2']);
      const params = makeParams(null, ['f2']);
      streamQueryAddForcedAndForbiddenStreams(ctx, params, null, (err) => {
        assert.strictEqual(err, undefined);
        const not = params.arrayOfStreamQueriesWithStoreId[0].not;
        assert.deepStrictEqual(not, ['f2', 'f1']);
        assert.strictEqual(new Set(not).size, not.length, 'not must contain no duplicates');
        done();
      });
    });

    it('[EGUF04] initializes all/not arrays when null', (done) => {
      const ctx = makeContext(['s1'], ['f1']);
      const params = makeParams(null, null);
      streamQueryAddForcedAndForbiddenStreams(ctx, params, null, (err) => {
        assert.strictEqual(err, undefined);
        const q = params.arrayOfStreamQueriesWithStoreId[0];
        assert.deepStrictEqual(q.all, ['s1']);
        assert.deepStrictEqual(q.not, ['f1']);
        done();
      });
    });
  });
});
