/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert');
const cuid = require('cuid');

const helpers = require('../../../test/helpers');
const { SqliteStorage: Storage } = require('../src/userSQLite/Storage.ts');
const { UserBaseStorageDb } = require('../src/userBaseStorage/UserBaseStorageDb.ts');
const { SeriesConnectionSQLite } = require('../src/seriesStorage/SeriesConnectionSQLite.ts');

// lru-cache disposes an entry before removing it: a `close()` that throws
// (better-sqlite3 refuses while a statement iterator is open) used to make
// the removal throw and keep the stale handle cached. The entry must leave
// the cache whatever `close()` does.
describe('[SQDC] SQLite handle caches drop an entry whose close() throws', function () {
  const userLocalDirectory = helpers.userLocalDirectory;

  before(async function () {
    await helpers.dependencies.init();
    await userLocalDirectory.init();
  });

  // Make `target[method]` throw once, keeping the real one to close for good.
  function refuseClose (target, method = 'close') {
    const real = target[method].bind(target);
    target[method] = () => { throw new Error('This database connection is busy executing a query'); };
    return real;
  }

  it('[SQDC1] events / audit storage: closeUser() leaves the cache', async function () {
    const storage = new Storage('sqdc-' + cuid.slug());
    await storage.init();
    const userId = cuid();
    try {
      const db = await storage.forUser(userId);
      const realClose = refuseClose(db);
      assert.doesNotThrow(() => storage.closeUser(userId));
      assert.strictEqual(storage.userDBsCache.has(userId), false);
      realClose();
    } finally {
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });

  it('[SQDC2] base storage: evict() leaves the cache', async function () {
    const userId = cuid();
    try {
      const db = await UserBaseStorageDb.forUser(userId);
      const realClose = refuseClose(db.db);
      assert.doesNotThrow(() => UserBaseStorageDb.evict(userId));
      assert.strictEqual(UserBaseStorageDb.cache.has(userId), false);
      realClose();
    } finally {
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });

  it('[SQDC3] series: dropDatabase() goes on when the cached handle refuses to close', async function () {
    const conn = new SeriesConnectionSQLite();
    const ns = 'user.sqdc' + cuid.slug();
    await conn.writeMeasurement('event.x', [{ fields: { value: 1 }, timestamp: 1e9 }], { database: ns });
    const db = conn.cache.get(ns);
    const realClose = refuseClose(db);
    await conn.dropDatabase(ns);
    assert.strictEqual(conn.cache.has(ns), false);
    realClose();
  });
});
