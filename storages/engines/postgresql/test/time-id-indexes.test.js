/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [PGTI] Time sorts end with the row id: the (user_id, time, id) indexes, the
 * migration bringing them to an existing database, and audit pages over equal
 * times.
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as helpers from '../../../test/helpers/index.js';
import { DatabasePG } from '../src/DatabasePG.ts';
import { AuditStoragePG } from '../src/AuditStoragePG.ts';
const require = createRequire(import.meta.url);
const migration = require('../migrations/20261127_130000_time_id_indexes.js');

const OLD = {
  events: 'CREATE INDEX IF NOT EXISTS idx_event_time ON events(user_id, time)',
  audit_events: 'CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(user_id, time)'
};

describe('[PGTI] PostgreSQL time sort indexes', function () {
  this.timeout(60_000);
  let db, userId;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    await db.initSchema();
    const { _internals } = require('../src/_internals.ts');
    if (!_internals.getLogger && helpers.getLogger) _internals.set('getLogger', helpers.getLogger);
  });

  beforeEach(async function () {
    userId = 'pgti-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    await db.query('INSERT INTO users_index (username, user_id) VALUES ($1, $1)', [userId]);
  });

  afterEach(async function () {
    if (db == null) return;
    await db.query('DELETE FROM events WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
    // Whatever a test did, leave the indexes as a migrated database has them.
    await migration.up({ db });
  });

  after(async function () { if (db != null) await db.close(); });

  async function definition (name) {
    const res = await db.query('SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass($1)', [name]);
    return res.rows[0] ?? null;
  }

  async function insertRows (n) {
    for (let i = 0; i < n; i++) {
      const time = 1000 + Math.floor(i / 4);
      await db.query('INSERT INTO events (user_id, id, stream_ids, type, time, created, modified) VALUES ($1, $2, $3, $4, $5, $5, $5)',
        [userId, 'pgti-e' + i, '["s"]', 'note/txt', time]);
      await db.query('INSERT INTO audit_events (user_id, eventid, stream_ids, type, time, created, modified) VALUES ($1, $2, $3, $4, $5, $5, $5)',
        [userId, 'pgti-a' + i, ':_audit:x', 'audit-log/pryv-api', time]);
    }
  }

  async function count (table) {
    const res = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
    return res.rows[0].n;
  }

  it('[PGTI1] the migration builds the new indexes on a database holding the previous ones and rows, then drops the previous ones', async function () {
    await insertRows(40);
    await db.query('DROP INDEX IF EXISTS idx_event_time_id');
    await db.query('DROP INDEX IF EXISTS idx_audit_time_id');
    await db.query(OLD.events);
    await db.query(OLD.audit_events);

    const res = await migration.up({ db });
    assert.deepStrictEqual(res.map((r) => [r.name, r.built, r.droppedPrevious]),
      [['idx_event_time_id', true, true], ['idx_audit_time_id', true, true]]);
    const ev = await definition('idx_event_time_id');
    assert.strictEqual(ev.valid, true);
    assert.match(ev.def, /ON public\.events USING btree \(user_id, "time", id\)$/);
    const au = await definition('idx_audit_time_id');
    assert.strictEqual(au.valid, true);
    assert.match(au.def, /ON public\.audit_events USING btree \(user_id, "time", eventid\)$/);
    assert.strictEqual(await definition('idx_event_time'), null);
    assert.strictEqual(await definition('idx_audit_time'), null);
    assert.strictEqual(await count('events'), 40);
    assert.strictEqual(await count('audit_events'), 40);

    const again = await migration.up({ db });
    assert.deepStrictEqual(again.map((r) => [r.name, r.built, r.droppedPrevious]),
      [['idx_event_time_id', false, false], ['idx_audit_time_id', false, false]]);
  });

  it('[PGTI2] an index a failed concurrent build left INVALID is built again', async function () {
    await insertRows(8); // equal (user_id, time) pairs: a unique build fails
    await db.query('DROP INDEX IF EXISTS idx_event_time_id');
    await assert.rejects(db.query('CREATE UNIQUE INDEX CONCURRENTLY idx_event_time_id ON events(user_id, time)'));
    assert.strictEqual((await definition('idx_event_time_id')).valid, false);

    const res = await migration.up({ db });
    assert.deepStrictEqual(res[0].name, 'idx_event_time_id');
    assert.strictEqual(res[0].built, true);
    const ev = await definition('idx_event_time_id');
    assert.strictEqual(ev.valid, true);
    assert.match(ev.def, /CREATE INDEX idx_event_time_id ON public\.events USING btree \(user_id, "time", id\)$/);
  });

  it('[PGTI3] the schema DDL builds the new indexes on a database holding neither them nor the previous ones', async function () {
    await db.query('DROP INDEX IF EXISTS idx_event_time_id');
    await db.query('DROP INDEX IF EXISTS idx_audit_time_id');
    await db.query('DROP INDEX IF EXISTS idx_event_time');
    await db.query('DROP INDEX IF EXISTS idx_audit_time');
    const fresh = new DatabasePG(helpers.state.config);
    try {
      await fresh.waitForConnection();
      assert.strictEqual((await definition('idx_event_time_id')).valid, true);
      assert.strictEqual((await definition('idx_audit_time_id')).valid, true);
    } finally {
      await fresh.close();
    }
  });

  it('[PGTI4] the schema DDL leaves a database holding the previous indexes to the migration', async function () {
    await db.query('DROP INDEX IF EXISTS idx_event_time_id');
    await db.query(OLD.events);
    const fresh = new DatabasePG(helpers.state.config);
    try {
      await fresh.waitForConnection();
      assert.strictEqual(await definition('idx_event_time_id'), null);
      assert.notStrictEqual(await definition('idx_event_time'), null);
    } finally {
      await fresh.close();
    }
  });

  for (const sortAscending of [false, true]) {
    it(`[PGTI5] audit pages over equal times read with skip neither repeat nor miss a record (${sortAscending ? 'oldest' : 'newest'} first)`, async function () {
      const storage = new AuditStoragePG(db);
      await storage.init();
      const user = await storage.forUser(userId);
      const TIED = 24;
      for (let i = 0; i < TIED; i++) {
        await user.createEvent({
          id: 'pgti-r' + String(i).padStart(2, '0'),
          streamIds: [':_audit:access-a', ':_audit:action-x'],
          type: 'audit-log/pryv-api',
          time: 2000 + Math.floor(i / 4),
          created: 1,
          createdBy: 'system',
          modified: 1,
          modifiedBy: 'system',
          trashed: false,
          content: { action: 'x', i }
        });
      }
      const sort = { time: sortAscending ? 1 : -1 };
      const all = (await user.getEvents({ query: [], options: { sort, limit: TIED } })).map((e) => e.id);
      assert.strictEqual(new Set(all).size, TIED);
      for (const limit of [3, 5, 7]) {
        const paged = [];
        for (let skip = 0; skip < TIED; skip += limit) {
          const page = await user.getEvents({ query: [], options: { sort, limit, skip } });
          paged.push(...page.map((e) => e.id));
        }
        assert.deepStrictEqual(paged, all, 'limit ' + limit);
      }
      // Ties come back in id order, in the direction of the time sort.
      const firstGroup = all.slice(0, 4);
      assert.deepStrictEqual(firstGroup, [...firstGroup].sort((a, b) => sortAscending ? (a < b ? -1 : 1) : (a < b ? 1 : -1)));
    });
  }
});
