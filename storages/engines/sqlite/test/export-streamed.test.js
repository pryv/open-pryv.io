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

  it('[SQXS3] the SQLite engine actually implements exportAllEventsStreamed', function () {
    // Regression guard against silent fallback: the conformance [SQ18]/[SQ19]
    // tests SKIP when the method is absent, and the orchestrator falls back to
    // the array path, so a rename or removal would go unnoticed everywhere.
    // Assert presence explicitly for this in-repo engine.
    assert.strictEqual(typeof userDb.exportAllEventsStreamed, 'function');
  });

  it('[SQXS1] yields the same raw rows as exportAllEvents(), in order', async () => {
    const arrayRows = userDb.exportAllEvents();
    const streamedRows = [];
    for await (const row of userDb.exportAllEventsStreamed()) streamedRows.push(row);
    assert.deepStrictEqual(streamedRows, arrayRows);
    assert.ok(streamedRows.length >= 5);
  });

  it('[SQXS2] breaking out mid-stream closes the underlying statement iterator', async () => {
    let seen = 0;
    for await (const row of userDb.exportAllEventsStreamed()) {
      assert.ok(row.eventid != null);
      seen++;
      if (seen === 2) break; // abort mid-iteration → generator return() → inner iterator release
    }
    assert.strictEqual(seen, 2);

    // ⚑ Assert on the STATEMENT, not on a subsequent write. The obvious check
    // ("a write would fail while an iterator is open") cannot fail here:
    // `initWALAndConcurrentSafeWriteCapabilities` puts every user database in
    // better-sqlite3's `unsafeMode`, which disables exactly that guard, so the
    // write succeeds whether or not the iterator leaked. `Statement.busy` is
    // true for as long as the statement has an open iterator and is unaffected
    // by unsafe mode, so it reports the thing this test is about.
    assert.strictEqual(userDb.eventQueries.getAll.busy, false,
      'the statement must have no open iterator after the consumer broke out');

    // The connection is of course still usable.
    await userDb.createEvent(makeEvent(99));
    assert.strictEqual(userDb.countEvents(), 6);
  });
});
