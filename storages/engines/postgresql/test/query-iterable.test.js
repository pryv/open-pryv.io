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

// Server-side cursor iteration for bounded-memory export. The critical
// invariant is client lifecycle: the dedicated pooled client must be released
// on normal completion, on early consumer break, and on a mid-iteration error,
// or the pool leaks and eventually exhausts.
describe('[PGQI] DatabasePG.queryIterable', function () {
  before(function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
  });

  let db;
  let auditUserDb;
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
    auditUserDb = userDb;
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

  it('[PGQI5] the PG audit engine actually implements exportAllEventsStreamed', function () {
    // Regression guard against silent fallback (conformance [SQ17/SQ18] skip
    // when absent): assert the method exists for this in-repo engine.
    assert.strictEqual(typeof auditUserDb.exportAllEventsStreamed, 'function');
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
});
