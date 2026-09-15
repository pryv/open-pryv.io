/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { createId: cuid } = require('@paralleldrive/cuid2');
const helpers = require('../../../test/helpers');
const { DatabasePG } = require('../src/DatabasePG.ts');
const { AuditStoragePG } = require('../src/AuditStoragePG.ts');

// Server-side cursor iteration for bounded-memory reads. The critical
// invariant is client lifecycle: the dedicated pooled client must be released
// on normal completion, on early consumer break, and on a mid-iteration error,
// or the pool leaks and eventually exhausts.
describe('[PGQI] DatabasePG.queryIterable', function () {
  before(function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
  });

  let db;
  const userId = 'pgqi-' + cuid();

  before(async function () {
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    const { _internals } = require('../src/_internals.ts');
    if (!_internals.getLogger) _internals.set('getLogger', helpers.getLogger);
    const storage = new AuditStoragePG(db);
    await storage.init();
    const userDb = await storage.forUser(userId);
    for (let i = 0; i < 25; i++) {
      await userDb.createEvent({
        id: 'evt-' + i,
        streamIds: ['s1'],
        type: 'note/txt',
        time: i,
        created: i,
        createdBy: 'test',
        modified: i,
        modifiedBy: 'test'
      });
    }
  });

  after(async function () {
    if (db) await db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
  });

  it('[PGQI1] yields every row of the query one at a time', async function () {
    const seen = [];
    for await (const row of db.queryIterable('SELECT * FROM audit_events WHERE user_id = $1 ORDER BY time', [userId])) {
      seen.push(row.eventid);
    }
    assert.strictEqual(seen.length, 25);
    assert.strictEqual(seen[0], 'evt-0');
  });

  it('[PGQI2] a small batch size still yields every row', async function () {
    let n = 0;
    for await (const row of db.queryIterable('SELECT * FROM audit_events WHERE user_id = $1', [userId], 4)) {
      assert.ok(row.eventid != null);
      n++;
    }
    assert.strictEqual(n, 25);
  });

  it('[PGQI3] breaking early does not leak clients (pool survives many partial reads)', async function () {
    for (let r = 0; r < 30; r++) {
      let taken = 0;
      for await (const row of db.queryIterable('SELECT * FROM audit_events WHERE user_id = $1', [userId], 5)) {
        assert.ok(row.eventid != null);
        if (++taken === 3) break; // early break → generator return() → client release
      }
      assert.strictEqual(taken, 3);
    }
    // Had early-break leaked clients, 30 rounds would exceed the pool and this
    // would hang; it must still resolve.
    const res = await db.query('SELECT count(*)::int AS c FROM audit_events WHERE user_id = $1', [userId]);
    assert.strictEqual(res.rows[0].c, 25);
  });

  it('[PGQI4] a mid-iteration query error releases the client (pool survives repeated failures)', async function () {
    for (let r = 0; r < 30; r++) {
      await assert.rejects(async () => {
        // eslint-disable-next-line no-unused-vars
        for await (const row of db.queryIterable('SELECT * FROM no_such_table_pgqi', [])) { /* unreachable */ }
      });
    }
    // The failing cursor's client must have been released (with the error
    // flag), not leaked — the pool must still serve queries.
    const res = await db.query('SELECT count(*)::int AS c FROM audit_events WHERE user_id = $1', [userId]);
    assert.strictEqual(res.rows[0].c, 25);
  });

  // A consumer walking away is NOT a broken connection. An aborted HTTP
  // response reaches the generator as a throw at its `yield`; if that were
  // treated like a cursor failure the client would be released WITH an error
  // and pg would close the socket, so a burst of aborts would churn the pool
  // (reconnect storm) instead of leaking it. Better than a leak, still wrong.
  // This is what scopes the failure flag to `cursor.read` alone.
  it('[PGQI6] a consumer-injected throw returns a HEALTHY client (connection not destroyed)', async function () {
    const pool = db.pool;
    await settle(pool);
    const totalBefore = pool.totalCount;

    for (let r = 0; r < 5; r++) {
      const it = db.queryIterable('SELECT * FROM audit_events WHERE user_id = $1', [userId], 5);
      const first = await it.next();
      assert.strictEqual(first.done, false, 'generator must have yielded before we abort it');

      // What `Readable.from` does to its iterator on destroy-with-error.
      const injected = new Error('consumer aborted (premature close)');
      await assert.rejects(() => it.throw(injected), (e) => e === injected);

      await settle(pool);
      assert.strictEqual(pool.waitingCount, 0, 'nobody should be queued for a client');
      assert.strictEqual(
        pool.totalCount, pool.idleCount,
        'every client must be back in the idle set, not checked out');
      assert.strictEqual(
        pool.totalCount, totalBefore,
        'the connection must be REUSED, not discarded and reopened — a destroyed ' +
        'client would drop totalCount and force a reconnect on the next query');
    }

    // And the pool still works.
    const res = await db.query('SELECT count(*)::int AS c FROM audit_events WHERE user_id = $1', [userId]);
    assert.strictEqual(res.rows[0].c, 25);
  });
});

// Client release happens in the generator's `finally`, which the runtime may
// run a microtask or two after `throw()` settles.
async function settle (pool, deadlineMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (pool.waitingCount === 0 && pool.totalCount === pool.idleCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
