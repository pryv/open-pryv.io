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
const SQLite3 = require('better-sqlite3');

const helpers = require('../../../test/helpers');
const { SqliteStorage: Storage } = require('../src/userSQLite/Storage.ts');
const { UserBaseStorageDb } = require('../src/userBaseStorage/UserBaseStorageDb.ts');

// API and HFS workers are separate processes, each with its own cache of
// open handles on the per-user SQLite files. Deleting or replacing a file in
// one of them (account deletion, restore) must not leave the others reading
// the erased file or writing into it.
describe('[SQXH] SQLite per-user handles follow the file on disk', function () {
  const userLocalDirectory = helpers.userLocalDirectory;

  before(async function () {
    await helpers.dependencies.init();
    await userLocalDirectory.init();
  });

  function event (id) {
    return { id, streamIds: ['sqxh-stream'], type: 'test/test', time: 1000, created: 1000, createdBy: 'test', modified: 1000, modifiedBy: 'test' };
  }

  async function eventIds (userDb) {
    return (await userDb.getEvents({ query: [] })).map((e) => e.id).sort();
  }

  // Two Storage instances on the same files stand in for two processes.
  it('[SQXU] a user database deleted by another process is seen by a storage holding it open', async function () {
    const name = 'sqxh-' + cuid.slug();
    const userId = cuid();
    const holder = new Storage(name);
    const deleter = new Storage(name);
    await holder.init();
    await deleter.init();
    try {
      await (await holder.forUser(userId)).createEvent(event('before'));

      await deleter.deleteUser(userId);
      await (await holder.forUser(userId)).createEvent(event('after'));

      assert.deepStrictEqual(await eventIds(await holder.forUser(userId)), ['after'], 'the erased events must not be readable');
      const fresh = new Storage(name);
      await fresh.init();
      assert.deepStrictEqual(await eventIds(await fresh.forUser(userId)), ['after'], 'the event written after the deletion must be in the file on disk');
      fresh.close();
    } finally {
      holder.close();
      deleter.close();
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });

  it('[SQXV] a user database replaced by another process is read from the new file', async function () {
    const name = 'sqxh-' + cuid.slug();
    const userId = cuid();
    const holder = new Storage(name);
    const restorer = new Storage(name);
    await holder.init();
    await restorer.init();
    try {
      await (await holder.forUser(userId)).createEvent(event('old'));

      await restorer.deleteUser(userId);
      await (await restorer.forUser(userId)).createEvent(event('restored'));

      assert.deepStrictEqual(await eventIds(await holder.forUser(userId)), ['restored']);
    } finally {
      holder.close();
      restorer.close();
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });

  it('[SQXW] concurrent first opens of a user database share one handle', async function () {
    const name = 'sqxh-' + cuid.slug();
    const userId = cuid();
    const storage = new Storage(name);
    await storage.init();
    try {
      const [a, b] = await Promise.all([storage.forUser(userId), storage.forUser(userId)]);
      assert.strictEqual(a, b);
      await a.createEvent(event('shared'));
      assert.deepStrictEqual(await eventIds(b), ['shared']);
    } finally {
      storage.close();
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });

  // Account deletion wipes the whole user directory, in whichever process
  // handles the request; the baseStorage handle cache of every process must
  // let go of the erased file.
  it('[SQXR] a baseStorage file erased with the user directory is not served from a cached handle', async function () {
    const userId = cuid();
    const opts = { withDeleted: true, withHeadId: false };
    try {
      const before = await UserBaseStorageDb.forUser(userId);
      await before.ensureTable('sqxh', opts);
      before.db.prepare("INSERT INTO sqxh (id, data) VALUES ('before', '{}')").run();

      await userLocalDirectory.deleteUserDirectory(userId);

      const after = await UserBaseStorageDb.forUser(userId);
      await after.ensureTable('sqxh', opts);
      assert.deepStrictEqual(after.db.prepare('SELECT id FROM sqxh').all(), [], 'the erased rows must not be readable');
      after.db.prepare("INSERT INTO sqxh (id, data) VALUES ('after', '{}')").run();

      const onDisk = new SQLite3(after.dbPath, { readonly: true });
      try {
        assert.deepStrictEqual(onDisk.prepare('SELECT id FROM sqxh').all(), [{ id: 'after' }], 'the row written after the deletion must be in the file on disk');
      } finally {
        onDisk.close();
      }
    } finally {
      UserBaseStorageDb.evict(userId);
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });
});
