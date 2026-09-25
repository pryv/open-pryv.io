/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The access's forced / forbidden stream ids are merged into the caller's
 * stream query. When the caller already named one of those ids, the merged
 * arrays must not carry it twice.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./test-helper');
const assert = require('node:assert');
const { streamQueryAddForcedAndForbiddenStreams } = require('../../src/methods/helpers/eventsGetUtils.ts');

function makeContext (forced, forbidden, isPersonal = true) {
  return {
    access: {
      getForcedStreamsGetEventsStreamIds: () => forced,
      getForbiddenGetEventsStreamIds: () => forbidden,
      isPersonal: () => isPersonal
    }
  };
}

function makeParams (all, not, any) {
  return { arrayOfStreamQueriesWithStoreId: [{ storeId: 'local', all, not, any }] };
}

function run (ctx, params) {
  return new Promise((resolve, reject) => {
    streamQueryAddForcedAndForbiddenStreams(ctx, params, null, (err) => err ? reject(err) : resolve());
  });
}

describe('[EGDU] eventsGetUtils forced / forbidden stream merge', () => {
  it('[EGD1] appends forced ids when the caller query has no overlap', async () => {
    const params = makeParams(['original'], null);
    await run(makeContext(['s1', 's2'], null), params);
    assert.deepStrictEqual(params.arrayOfStreamQueriesWithStoreId[0].all, ['original', 's1', 's2']);
  });

  it('[EGD2] does not duplicate a forced id the caller already supplied', async () => {
    const params = makeParams(['s1'], null);
    await run(makeContext(['s1', 's2'], null), params);
    assert.deepStrictEqual(params.arrayOfStreamQueriesWithStoreId[0].all, ['s1', 's2']);
  });

  it('[EGD3] does not duplicate a forbidden id the caller already supplied', async () => {
    const params = makeParams(null, ['f2']);
    await run(makeContext(null, ['f1', 'f2']), params);
    assert.deepStrictEqual(params.arrayOfStreamQueriesWithStoreId[0].not, ['f2', 'f1']);
  });

  it('[EGD4] initializes all / not when absent', async () => {
    const params = makeParams(null, null);
    await run(makeContext(['s1'], ['f1']), params);
    const q = params.arrayOfStreamQueriesWithStoreId[0];
    assert.deepStrictEqual(q.all, ['s1']);
    assert.deepStrictEqual(q.not, ['f1']);
  });

  it('[EGD5] a wildcard query from a non-personal token carries each exclusion once', async () => {
    const params = makeParams(null, [':_shared-secrets:'], ['*']);
    await run(makeContext(null, null, false), params);
    const not = params.arrayOfStreamQueriesWithStoreId[0].not;
    assert.deepStrictEqual(not, [...new Set(not)]);
    assert.ok(not.includes(':_emails:'));
    assert.ok(not.includes(':_shared-secrets:'));
  });
});
