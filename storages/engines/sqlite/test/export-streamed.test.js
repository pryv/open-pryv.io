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
const userLocalDirectory = require('../../../test/helpers').userLocalDirectory;
const { SqliteStorage: Storage } = require('storages/engines/sqlite/src/userSQLite/Storage.ts');

// exportAllEventsStreamed is the bounded-memory backup producer. It wraps
// better-sqlite3's `.iterate()`, whose read lock must be released when the
// consumer stops early — otherwise the connection stays busy and later writes
// fail. These tests pin both the parity with the array form and the release.
describe('[SQXS] userSQLite exportAllEventsStreamed', () => {
  let storage; let userDb; let userId;

  function makeEvent (i) {
    return {
      id: 'evt-' + i,
      streamIds: ['s1'],
      type: 'note/txt',
      time: i,
      created: i,
      createdBy: 'test',
      modified: i,
      modifiedBy: 'test'
    };
  }

  before(async () => {
    await userLocalDirectory.init();
    storage = new Storage('audit-test-' + cuid().slice(0, 8));
    await storage.init();
    userId = cuid();
    userDb = await storage.forUser(userId);
    for (let i = 0; i < 5; i++) await userDb.createEvent(makeEvent(i));
  });

  after(async () => {
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  it('[SQXS1] yields the same raw rows as exportAllEvents(), in order', async () => {
    const arrayRows = userDb.exportAllEvents();
    const streamedRows = [];
    for await (const row of userDb.exportAllEventsStreamed()) streamedRows.push(row);
    assert.deepStrictEqual(streamedRows, arrayRows);
    assert.ok(streamedRows.length >= 5);
  });

  it('[SQXS2] releasing the iterator mid-stream leaves the db writable (no lingering read lock)', async () => {
    let seen = 0;
    for await (const row of userDb.exportAllEventsStreamed()) {
      assert.ok(row.eventid != null);
      seen++;
      if (seen === 2) break; // abort mid-iteration → generator return() → inner iterator release
    }
    assert.strictEqual(seen, 2);
    // If the better-sqlite3 iterator were still open, this write would fail on a
    // busy connection. It must succeed.
    await userDb.createEvent(makeEvent(99));
    assert.strictEqual(userDb.countEvents(), 6);
  });
});
