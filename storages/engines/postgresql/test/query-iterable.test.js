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

  // The connection-loss path, which [PGQI4] does NOT cover: that one fails the
  // query server-side on a LIVE connection, where `readyForQuery` still
  // arrives. Here the socket dies under the cursor, which is what a PostgreSQL
  // restart, a failover or a DBA `pg_terminate_backend` looks like from here.
  // Two distinct defects are pinned:
  //   - the held client has no `'error'` listener (the pool removes its own
  //     when it hands the client out), so the loss is an unhandled `'error'`
  //     event and the process dies;
  //   - `cursor.close()` waits for a `readyForQuery` that will never come, so
  //     the release never runs and the slot is gone until restart.
  it('[PGQI7] a connection lost mid-cursor releases the slot and does not crash the process', async function () {
    const pool = db.pool;
    await settle(pool);
    const totalBefore = pool.totalCount;

    const it = db.queryIterable('SELECT * FROM audit_events WHERE user_id = $1 ORDER BY time', [userId], 5);
    const first = await it.next();
    assert.strictEqual(first.done, false, 'generator must have yielded before we kill the connection');

    // The client this generator holds is the one the pool has checked out.
    const held = pool._clients.find((c) => !pool._idle.some((i) => i.client === c));
    assert.ok(held != null, 'the checked-out client must be findable on the pool');

    // An unhandled `'error'` on the client would take the process down, so a
    // surviving assertion below IS the proof that one was handled.
    held.connection.stream.destroy(new Error('[PGQI7] connection lost'));

    await assert.rejects(async () => {
      // Keep pulling until the generator rejects: the loss surfaces on the next
      // batch read, not on the row already buffered.
      let next = await it.next();
      while (next.done !== true) next = await it.next();
    });

    await settle(pool, 3000);
    assert.strictEqual(pool.waitingCount, 0, 'nobody left queued for a client');
    assert.strictEqual(
      pool.totalCount, pool.idleCount,
      'the slot must be released, not parked forever inside cursor.close()');
    assert.ok(
      pool.totalCount <= totalBefore,
      'the dead client is discarded, never handed back to another caller');

    // The pool recovers: a fresh query opens a new connection and works.
    const res = await db.query('SELECT count(*)::int AS c FROM audit_events WHERE user_id = $1', [userId]);
    assert.strictEqual(res.rows[0].c, 25);
  });

  // The sibling of [PGQI7], and the one the obvious implementation gets wrong.
  // There, the loss is discovered BY a `cursor.read`, which sets the failed flag
  // and tells the cleanup to skip the close. Here nothing is mid-read: the
  // generator is parked at a yield when the connection dies, and the consumer
  // then walks away, which is what an aborted HTTP response does. Unless the
  // client's own 'error' is treated as knowledge of the loss, the cleanup
  // believes the connection is healthy and waits forever on a close that cannot
  // complete, losing the pool slot for good.
  it('[PGQI8] a consumer aborting AFTER the connection died still releases the slot', async function () {
    const pool = db.pool;
    await settle(pool);

    const it = db.queryIterable('SELECT * FROM audit_events WHERE user_id = $1 ORDER BY time', [userId], 5);
    const first = await it.next();
    assert.strictEqual(first.done, false, 'generator must be parked at a yield');

    const held = pool._clients.find((c) => !pool._idle.some((i) => i.client === c));
    assert.ok(held != null, 'the checked-out client must be findable on the pool');
    held.connection.stream.destroy(new Error('[PGQI8] connection lost while parked'));
    // Let the 'error' reach the client before we abandon the generator.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Abandon it WITHOUT another read — `return()` is what Readable.from calls
    // on a plain destroy, and it goes straight to the generator's finally.
    await it.return();

    await settle(pool, 3000);
    assert.strictEqual(pool.waitingCount, 0, 'nobody left queued for a client');
    assert.strictEqual(
      pool.totalCount, pool.idleCount,
      'the slot must come back rather than park inside cursor.close() on a dead connection');

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
