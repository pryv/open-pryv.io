/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The per-user database contract lets `countEvents` return a value or a
 * promise ("consumers must await"). The storage-infos method must resolve
 * the count either way, never hand back a pending promise as the count.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { userEvents } = require('storages/engines/sqlite/src/dataStore/localUserEventsSQLite.ts');

function storeWith (countEvents) {
  const store = Object.create(userEvents);
  store.storage = { forUser: async () => ({ countEvents }) };
  return store;
}

describe('[SQSI] SQLite user events storage infos', () => {
  it('[SQS1] resolves a synchronous event count', async () => {
    const infos = await storeWith(() => 7)._getStorageInfos('u1');
    assert.deepStrictEqual(infos, { count: 7 });
  });

  it('[SQS2] resolves an asynchronous event count', async () => {
    const infos = await storeWith(async () => 11)._getStorageInfos('u1');
    assert.deepStrictEqual(infos, { count: 11 });
  });
});
