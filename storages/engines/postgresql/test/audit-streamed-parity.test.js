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

// The streamed audit reads go through a server-side cursor a batch at a time,
// while getEvents runs one query. They must return the same thing. The row
// count is deliberately larger than one batch, so a bug in the batch boundary
// (dropped or duplicated rows at the seam) shows up.
describe('[AUSP] streamed audit reads match the non-streamed read', function () {
  before(function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
  });

  let db, userDb;
  const userId = 'ausp-' + cuid();
  const ROWS = 2500; // > STREAM_BATCH_SIZE (1000), so at least three batches

  before(async function () {
    this.timeout(30000);
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    const { _internals } = require('../src/_internals.ts');
    if (!_internals.getLogger) _internals.set('getLogger', helpers.getLogger);
    const storage = new AuditStoragePG(db);
    await storage.init();
    userDb = await storage.forUser(userId);

    // One statement rather than 2500 round-trips.
    await db.query(
      `INSERT INTO audit_events
         (user_id, eventid, stream_ids, time, type, content, created, created_by, modified, modified_by)
       SELECT $1, 'evt-' || g, 's1', g, 'log/test', '{}'::jsonb, g, 'test', g, 'test'
       FROM generate_series(1, $2) AS g`,
      [userId, ROWS]
    );
  });

  after(async function () {
    if (db) await db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
  });

  function freshParams () {
    return { query: [], options: { sort: { time: 1 } } };
  }

  async function collect (stream) {
    const out = [];
    for await (const event of stream) out.push(event);
    return out;
  }

  it('[AUSP4] the PG audit engine actually implements exportAllEventsStreamed', function () {
    // Regression guard against silent fallback. The conformance [SQ18]/[SQ19]
    // tests SKIP when the method is absent and the backup orchestrator falls
    // back to the array path, so a rename or removal would turn bounded-memory
    // backup back into a full materialisation with every test still green.
    assert.strictEqual(typeof userDb.exportAllEventsStreamed, 'function');
  });

  it('[AUSP1] getEventsStreamed yields exactly what getEvents returns', async function () {
    this.timeout(30000);
    const expected = await userDb.getEvents(freshParams());
    const streamed = await collect(userDb.getEventsStreamed(freshParams()));

    assert.strictEqual(streamed.length, ROWS, 'every seeded row must come back');
    assert.strictEqual(streamed.length, expected.length, 'same count as the non-streamed read');
    const byId = (a, b) => String(a.id).localeCompare(String(b.id));
    assert.deepStrictEqual(
      [...streamed].sort(byId), [...expected].sort(byId),
      'same events, regardless of order');
  });

  it('[AUSP2] the batch seam neither drops nor duplicates rows', async function () {
    this.timeout(30000);
    const streamed = await collect(userDb.getEventsStreamed(freshParams()));
    const ids = streamed.map((e) => e.id);
    assert.strictEqual(new Set(ids).size, ROWS, 'no duplicates across batch boundaries');
  });

  it('[AUSP3] destroying the stream early releases the pooled client', async function () {
    this.timeout(30000);
    const pool = db.pool;
    const totalBefore = pool.totalCount;

    for (let i = 0; i < 5; i++) {
      const stream = userDb.getEventsStreamed(freshParams());
      // Take one event, then walk away like an aborted response does.
      // eslint-disable-next-line no-unreachable-loop
      for await (const event of stream) {
        assert.ok(event.id != null);
        break;
      }
      stream.destroy();
    }

    const started = Date.now();
    while (Date.now() - started < 3000) {
      if (pool.waitingCount === 0 && pool.totalCount === pool.idleCount) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.strictEqual(pool.waitingCount, 0, 'nobody queued behind an exhausted pool');
    assert.strictEqual(pool.totalCount, pool.idleCount, 'no client left checked out');
    // NOT asserting totalCount === totalBefore here. Release is asynchronous, so
    // the next iteration can ask for a client while the previous one is still
    // going back, and pg-pool then opens a second connection — growth up to
    // `max` is normal and is not a leak. What would signal discarding is the
    // count DROPPING. The precise "a healthy client is reused, not destroyed"
    // property is pinned by [PGQI6], which settles the pool between rounds.
    assert.ok(pool.totalCount >= totalBefore,
      `connections must not be destroyed on abort (was ${totalBefore}, now ${pool.totalCount})`);
    assert.ok(pool.totalCount <= pool.options.max, 'pool stayed within its bound');

    // The pool still serves.
    const res = await db.query('SELECT count(*)::int AS c FROM audit_events WHERE user_id = $1', [userId]);
    assert.strictEqual(res.rows[0].c, ROWS);
  });
});
