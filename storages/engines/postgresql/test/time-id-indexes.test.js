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

  it('[PGTI6] two runs at once build each index once and never leave a table without a time index', async function () {
    // Enough rows for each build to last while the other run looks at it.
    await db.query(`INSERT INTO events (user_id, id, stream_ids, type, time, created, modified)
      SELECT $1, 'pgti6-e' || g, '["s"]', 'note/txt', g / 10, 0, 0 FROM generate_series(1, 200000) g`, [userId]);
    await db.query(`INSERT INTO audit_events (user_id, eventid, stream_ids, type, time, created, modified)
      SELECT $1, 'pgti6-a' || g, ':_audit:x', 'audit-log/pryv-api', g / 10, 0, 0 FROM generate_series(1, 200000) g`, [userId]);
    await db.query('DROP INDEX IF EXISTS idx_event_time_id');
    await db.query('DROP INDEX IF EXISTS idx_audit_time_id');
    await db.query(OLD.events);
    await db.query(OLD.audit_events);

    // From a third connection, while both runs go on: at least one valid time
    // index per table at every look.
    const VALID_TIME_INDEXES = `SELECT
      (SELECT count(*)::int FROM pg_index WHERE indisvalid AND indexrelid IN (to_regclass('idx_event_time'), to_regclass('idx_event_time_id'))) AS events,
      (SELECT count(*)::int FROM pg_index WHERE indisvalid AND indexrelid IN (to_regclass('idx_audit_time'), to_regclass('idx_audit_time_id'))) AS audit`;
    const watch = { running: true };
    let looks = 0;
    const gaps = [];
    const watcher = (async () => {
      while (watch.running) {
        const { rows } = await db.query(VALID_TIME_INDEXES);
        looks++;
        if (rows[0].events < 1 || rows[0].audit < 1) gaps.push(rows[0]);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    let results;
    try {
      results = await Promise.all([migration.up({ db }), migration.up({ db })]);
    } finally {
      watch.running = false;
      await watcher;
    }
    assert.deepStrictEqual(gaps, [], 'a table had no valid time index during the runs (' + looks + ' looks)');
    for (const [i, name] of ['idx_event_time_id', 'idx_audit_time_id'].entries()) {
      assert.strictEqual(results.filter((r) => r[i].name === name && r[i].built).length, 1, name + ' built by exactly one run');
      assert.strictEqual((await definition(name)).valid, true);
    }
    assert.strictEqual(await definition('idx_event_time'), null);
    assert.strictEqual(await definition('idx_audit_time'), null);
  });

  it('[PGTI7] a database holding the new index already and the previous one only loses the previous one', async function () {
    // The state after a crash between build and drop, or after the new index
    // was built by hand before the upgrade.
    await insertRows(8);
    await db.query(OLD.events);
    await db.query(OLD.audit_events);
    const res = await migration.up({ db });
    assert.deepStrictEqual(res.map((r) => [r.name, r.built, r.droppedPrevious]),
      [['idx_event_time_id', false, true], ['idx_audit_time_id', false, true]]);
    assert.strictEqual(await definition('idx_event_time'), null);
    assert.strictEqual(await definition('idx_audit_time'), null);
    assert.strictEqual((await definition('idx_event_time_id')).valid, true);
  });

  it('[PGTI8] an index of the new name with other columns is built again before the previous one is dropped', async function () {
    await insertRows(8);
    await db.query('DROP INDEX IF EXISTS idx_event_time_id');
    await db.query(OLD.events);
    await db.query('CREATE INDEX idx_event_time_id ON events(user_id, time)');
    const res = await migration.up({ db });
    assert.deepStrictEqual([res[0].name, res[0].built, res[0].droppedPrevious], ['idx_event_time_id', true, true]);
    assert.match((await definition('idx_event_time_id')).def, /ON public\.events USING btree \(user_id, "time", id\)$/);
    assert.strictEqual(await definition('idx_event_time'), null);
  });

  async function readStreamed (user, options) {
    const ids = [];
    for await (const e of user.getEventsStreamed({ query: [], options })) ids.push(e.id);
    return ids;
  }

  for (const withIndex of [true, false]) {
    for (const sortAscending of [false, true]) {
      it(`[PGTI5] audit pages over equal times read with skip neither repeat nor miss a record (${sortAscending ? 'oldest' : 'newest'} first, ${withIndex ? 'served by the index' : 'sorted by the planner'})`, async function () {
        const storage = new AuditStoragePG(db);
        await storage.init();
        const user = await storage.forUser(userId);
        const TIED = 48;
        const PER_TIME = 8;
        for (let i = 0; i < TIED; i++) {
          // Ids inserted in an order unrelated to their own order.
          const n = (i * 29) % TIED;
          await user.createEvent({
            id: 'pgti-r' + String(n).padStart(2, '0'),
            streamIds: [':_audit:access-a', ':_audit:action-x'],
            type: 'audit-log/pryv-api',
            time: 2000 + Math.floor(i / PER_TIME),
            created: 1,
            createdBy: 'system',
            modified: 1,
            modifiedBy: 'system',
            trashed: false,
            content: { action: 'x', i }
          });
        }
        if (!withIndex) {
          // No time index: the planner sorts, the order of ties is then the
          // sort's own unless the sort ends with the id. afterEach rebuilds it.
          await db.query('DROP INDEX IF EXISTS idx_audit_time_id');
          await db.query('DROP INDEX IF EXISTS idx_audit_time');
        }
        const sort = { time: sortAscending ? 1 : -1 };
        const all = (await user.getEvents({ query: [], options: { sort, limit: TIED } })).map((e) => e.id);
        assert.strictEqual(new Set(all).size, TIED);
        assert.deepStrictEqual(await readStreamed(user, { sort, limit: TIED }), all, 'streamed');
        for (const limit of [3, 5, 7, 11]) {
          const paged = [];
          const pagedStreamed = [];
          for (let skip = 0; skip < TIED; skip += limit) {
            const page = await user.getEvents({ query: [], options: { sort, limit, skip } });
            paged.push(...page.map((e) => e.id));
            pagedStreamed.push(...await readStreamed(user, { sort, limit, skip }));
          }
          assert.deepStrictEqual(paged, all, 'limit ' + limit);
          assert.deepStrictEqual(pagedStreamed, all, 'streamed, limit ' + limit);
        }
        // Ties come back in id order, in the direction of the time sort.
        for (let g = 0; g < TIED; g += PER_TIME) {
          const group = all.slice(g, g + PER_TIME);
          assert.deepStrictEqual(group, [...group].sort((a, b) => sortAscending ? (a < b ? -1 : 1) : (a < b ? 1 : -1)), 'group at ' + g);
        }
      });
    }
  }
});
