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

/**
 * An abandoned streamed read must close the statement iterator it borrowed.
 *
 * The streamed reads hand `Readable.from` a wrapper around a prepared
 * statement's iterator. `Readable.from` closes its iterator through `return()`
 * when the wrapper provides one and does nothing at all otherwise, so a wrapper
 * without `return()` leaves the statement iterator open for good when the
 * consumer walks away, which is exactly what an aborted HTTP response does.
 *
 * ⚑ How this is observed, and why it is not observed the obvious way.
 * better-sqlite3 refuses writes on a connection that has an open iterator
 * ("This database connection is busy executing a query"), which would make a
 * plain "write after abandoning a read" the natural assertion. It is not
 * available here: `initWALAndConcurrentSafeWriteCapabilities` puts every user
 * database in `unsafeMode(true)`, which disables that very guard, so writes
 * succeed whether or not the iterator leaked and such a test would pass against
 * the bug. Measured, not assumed. The guard is therefore switched back on for
 * the assertion window only, which makes the leaked iterator observable without
 * pretending the product is in a state it never runs in.
 *
 * The real consequence is not blocked writes. `close()` keeps the open-iterator
 * check whatever the mode, so a leaked iterator made the user's handle
 * unclosable, which is what account deletion and the handle cache's eviction
 * both need, and the un-reset statement pinned the WAL read mark.
 */
describe('[SQIR] userSQLite streamed reads release their statement iterator', function () {
  this.timeout(20_000);

  let storage;
  let userDb;
  const userId = 'sqir-' + cuid().slice(0, 8);

  function auditEvent (i) {
    return {
      id: 'sqir-evt-' + i,
      streamIds: ['s1'],
      type: 'note/txt',
      time: i,
      created: i,
      createdBy: 'test',
      modified: i,
      modifiedBy: 'test',
    };
  }

  before(async function () {
    await userLocalDirectory.init();
    storage = new Storage('audit-sqir-' + cuid().slice(0, 8));
    await storage.init();
    userDb = await storage.forUser(userId);
    // Many more rows than the reader will take, so the iterator is provably
    // parked mid-result when the reader abandons it.
    for (let i = 0; i < 50; i++) await userDb.createEvent(auditEvent(i));
  });

  after(async function () {
    try { userDb.db.unsafeMode(true); } catch (_e) { /* leave it as the product expects */ }
    try { await userLocalDirectory.deleteUserDirectory(userId); } catch (_e) { /* best-effort */ }
  });

  it('[SQIR1] destroying getEventsStreamed closes the underlying iterator', async function () {
    const stream = userDb.getEventsStreamed({ query: [] });

    // ⚑ PAUSED mode on purpose. A 'data' listener switches the readable to
    // flowing and it drains all 50 rows within a tick, closing the iterator by
    // exhaustion and passing whether or not the wrapper forwards `return()`.
    // One `read()` behind the 'readable' event leaves it parked, which is the
    // state that matters.
    await new Promise((resolve, reject) => {
      stream.once('readable', resolve);
      stream.once('error', reject);
    });
    assert.ok(stream.read() != null, 'the stream must have produced a row before we abandon it');

    stream.destroy();
    await new Promise((resolve) => stream.once('close', resolve));

    // Re-arm better-sqlite3's own open-iterator guard and ask it whether one is
    // still open. With `return()` forwarded the iterator is closed and the
    // write goes through; without it, this throws "busy executing a query".
    userDb.db.unsafeMode(false);
    try {
      userDb.db.prepare('SELECT 1').run();
    } catch (err) {
      assert.fail('an iterator was left open by the destroyed stream: ' + err.message);
    } finally {
      userDb.db.unsafeMode(true);
    }
  });
});
