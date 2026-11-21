/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [PGUG] PostgreSQL refuses rows of a user id the users index does not hold
 * (the `refuse_unindexed_user` insert trigger), on the user-keyed tables an
 * account erasure clears after the index entry; the other tables accept them.
 * The index entry an insert found stays locked until that insert commits, so
 * an erasure removing the entry meanwhile waits, then removes the row too.
 */

import assert from 'node:assert';
import * as helpers from '../../../test/helpers/index.js';
import { DatabasePG } from '../src/DatabasePG.ts';
import { GUARDED_TABLES, isUnindexedUserError } from '../src/unindexedWritesGuard.ts';
import { userEvents } from '../src/dataStore/localUserEventsPG.ts';

/** One minimal row per guarded table: [sql, params(userId, n)]. */
const GUARDED_ROWS = {
  events: ['INSERT INTO events (user_id, id) VALUES ($1, $2)', (u, n) => [u, 'pgug-e' + n]],
  streams: ['INSERT INTO streams (user_id, id, path) VALUES ($1, $2, $2)', (u, n) => [u, 'pgug-s' + n]],
  accesses: ['INSERT INTO accesses (user_id, id) VALUES ($1, $2)', (u, n) => [u, 'pgug-a' + n]],
  profile: ['INSERT INTO profile (user_id, id) VALUES ($1, $2)', (u, n) => [u, 'pgug-p' + n]],
  webhooks: ['INSERT INTO webhooks (user_id, id) VALUES ($1, $2)', (u, n) => [u, 'pgug-w' + n]],
  account_fields: ['INSERT INTO account_fields (user_id, field, time) VALUES ($1, $2, 1)', (u, n) => [u, 'pgug-f' + n]],
  passwords: ['INSERT INTO passwords (user_id, time, hash) VALUES ($1, $2, \'h\')', (u, n) => [u, n]],
  store_key_values: ['INSERT INTO store_key_values (user_id, store_id, key) VALUES ($1, \'pgug\', $2)', (u, n) => [u, 'k' + n]]
};

/** Tables left unguarded on purpose, with one minimal row each. */
const UNGUARDED_ROWS = {
  event_streams: ['INSERT INTO event_streams (user_id, event_id, stream_id, stream_path) VALUES ($1, $2, \'s\', \'s\')', (u, n) => [u, 'pgug-e' + n]],
  audit_events: ['INSERT INTO audit_events (user_id, eventid) VALUES ($1, $2)', (u, n) => [u, 'pgug-ae' + n]],
  series_data: ['INSERT INTO series_data (user_id, event_id, point_time, delta_time, fields) VALUES ($1, $2, 1, 1, \'{}\')', (u, n) => [u, 'pgug-e' + n]],
  attachment_files: ['INSERT INTO attachment_files (user_id, event_id, file_id, seq, data) VALUES ($1, $2, \'f\', 0, \'\\x00\')', (u, n) => [u, 'pgug-e' + n]],
  alias_index: ['INSERT INTO alias_index (alias, user_id) VALUES ($2, $1)', (u, n) => [u, 'pgug-alias-' + u + n]],
  account_erasures: ['INSERT INTO account_erasures (user_id, username, started_at, updated_at, done_steps, attempts) VALUES ($1, $2, 1, 1, \'[]\', 1)', (u, n) => [u, 'pgug' + n]]
};

const ALL_TABLES = [...Object.keys(GUARDED_ROWS), ...Object.keys(UNGUARDED_ROWS)];

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

describe('[PGUG] PostgreSQL refusal of rows for an unindexed user id', function () {
  this.timeout(30000);
  let db, userId, n;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    await db.initSchema();
  });

  beforeEach(function () {
    userId = 'pgug-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    n = 0;
  });

  afterEach(async function () {
    if (db == null) return;
    for (const table of ALL_TABLES) {
      await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    }
    await db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
  });

  async function insert (spec, client = db) {
    const [sql, params] = spec;
    return await client.query(sql, params(userId, ++n));
  }

  async function index () {
    await db.query('INSERT INTO users_index (username, user_id) VALUES ($1, $1)', [userId]);
  }

  it('[PGUG1] every guarded table refuses a row for an unindexed id, and accepts it once the id is indexed', async function () {
    assert.deepStrictEqual(Object.keys(GUARDED_ROWS).sort(), [...GUARDED_TABLES].sort(), 'one row spec per guarded table');
    for (const [table, spec] of Object.entries(GUARDED_ROWS)) {
      await assert.rejects(insert(spec), (err) => {
        assert.ok(isUnindexedUserError(err), table + ': ' + err.message);
        assert.strictEqual(err.code, 'PU001');
        return true;
      }, table);
    }
    for (const [table] of Object.entries(GUARDED_ROWS)) {
      const res = await db.query(`SELECT count(*)::int AS c FROM ${table} WHERE user_id = $1`, [userId]);
      assert.strictEqual(res.rows[0].c, 0, table + ': row stored');
    }
    await index();
    for (const [table, spec] of Object.entries(GUARDED_ROWS)) {
      const res = await insert(spec);
      assert.strictEqual(res.rowCount, 1, table);
    }
    // An upsert inserts too: refused once the id is gone from the index.
    await db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
    await assert.rejects(db.query('INSERT INTO profile (user_id, id) VALUES ($1, $2) ON CONFLICT (user_id, id) DO NOTHING', [userId, 'pgug-upsert']),
      (err) => err.code === 'PU001');
  });

  it('[PGUG2] the tables left unguarded accept a row for an unindexed id', async function () {
    for (const [table, spec] of Object.entries(UNGUARDED_ROWS)) {
      const res = await insert(spec);
      assert.strictEqual(res.rowCount, 1, table);
    }
  });

  it('[PGUG3] an index removal waits for an insert in flight, and the data removal after it sees that row', async function () {
    await index();
    const writer = await db.getClient();
    const eraser = await db.getClient();
    try {
      await writer.query('BEGIN');
      await insert(GUARDED_ROWS.events, writer);
      // The erasure removes the index entry first: blocked by the writer's lock.
      let removed = false;
      const removal = eraser.query('DELETE FROM users_index WHERE user_id = $1', [userId]).then((r) => { removed = true; return r; });
      await sleep(300);
      assert.strictEqual(removed, false, 'the index entry was removed while an insert under it was in flight');
      await writer.query('COMMIT');
      const res = await removal;
      assert.strictEqual(res.rowCount, 1);
      // Its data removal, after the index entry, sees and removes the row.
      const cleared = await db.query('DELETE FROM events WHERE user_id = $1', [userId]);
      assert.strictEqual(cleared.rowCount, 1);
      // A write arriving now is refused.
      await assert.rejects(insert(GUARDED_ROWS.events), (err) => err.code === 'PU001');
      const left = await db.query('SELECT count(*)::int AS c FROM events WHERE user_id = $1', [userId]);
      assert.strictEqual(left.rows[0].c, 0);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      eraser.release();
    }
  });

  it('[PGUG8] the boot check enables a guard trigger left disabled and creates a missing one, with a warning', async function () {
    const warns = [];
    const originalWarn = db.logger.warn;
    let outcome;
    await db.query('ALTER TABLE profile DISABLE TRIGGER refuse_unindexed_user');
    await db.query('DROP TRIGGER refuse_unindexed_user ON webhooks');
    try {
      db.logger.warn = (msg) => { warns.push(msg); };
      outcome = await db.ensureUnindexedWritesGuard();
    } finally {
      db.logger.warn = originalWarn;
      await db.ensureUnindexedWritesGuard(); // whatever happened above, leave the guard whole
    }
    assert.strictEqual(outcome.profile, 're-enabled');
    assert.strictEqual(outcome.webhooks, 'created');
    assert.strictEqual(outcome.events, 'present');
    assert.ok(warns.some((m) => m.includes('"profile"')), JSON.stringify(warns));
    const states = await db.query(
      "SELECT c.relname AS t, tg.tgenabled AS s FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid WHERE tg.tgname = 'refuse_unindexed_user'");
    const byTable = Object.fromEntries(states.rows.map((r) => [r.t, r.s]));
    for (const table of GUARDED_TABLES) assert.strictEqual(byTable[table], 'O', table);
    for (const table of ['profile', 'webhooks']) {
      await assert.rejects(insert(GUARDED_ROWS[table]), (err) => err.code === 'PU001' && err.table === table, table);
    }
  });

  it('[PGUG9] an event link is written only while its event exists, and an account deletion running meanwhile removes it', async function () {
    await index();
    const store = Object.create(userEvents);
    store.init(db, { removeAllForUser: async () => {}, removeAllForEvent: async () => {}, getFileStorageInfos: async () => 0 }, {}, () => {}, {});
    const links = async () => (await db.query('SELECT count(*)::int AS c FROM event_streams WHERE user_id = $1', [userId])).rows[0].c;
    // No event: no link, through the link sync and through an update that matched nothing.
    await store._syncEventStreams(userId, 'pgug-missing', ['s1'], db.query.bind(db));
    assert.strictEqual(await store.update(userId, { id: 'pgug-missing', content: 'x', streamIds: ['s1'] }, null, { skipVersioning: true }), false);
    assert.strictEqual(await links(), 0, 'links without their event');

    await db.query('INSERT INTO events (user_id, id) VALUES ($1, $2)', [userId, 'pgug-e9']);
    const writer = await db.getClient();
    try {
      await writer.query('BEGIN');
      await store._syncEventStreams(userId, 'pgug-e9', ['s1', 's2'], writer.query.bind(writer));
      // The account's data removal starts while the link insert is in flight.
      let deleted = false;
      const deletion = store._deleteUser(userId).then(() => { deleted = true; });
      await sleep(300);
      assert.strictEqual(deleted, false, 'the event was deleted while a link insert holding it was in flight');
      await writer.query('COMMIT');
      await deletion;
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
    }
    assert.strictEqual(await links(), 0, 'links left after the deletion');
    const events = await db.query('SELECT count(*)::int AS c FROM events WHERE user_id = $1', [userId]);
    assert.strictEqual(events.rows[0].c, 0);
    // Written once the event is gone: nothing stored.
    await store._syncEventStreams(userId, 'pgug-e9', ['s1'], db.query.bind(db));
    assert.strictEqual(await links(), 0, 'a link written after its event is gone');
  });

  it('[PGUG4] the session setting pryv.unindexed_writes = allow lifts the refusal for that session only', async function () {
    const loader = await db.getClient();
    try {
      await loader.query("SET pryv.unindexed_writes = 'allow'");
      for (const [table, spec] of Object.entries(GUARDED_ROWS)) {
        const res = await insert(spec, loader);
        assert.strictEqual(res.rowCount, 1, table);
      }
      // Another session is still refused.
      await assert.rejects(insert(GUARDED_ROWS.events), (err) => err.code === 'PU001');
      await loader.query('RESET pryv.unindexed_writes');
      await assert.rejects(insert(GUARDED_ROWS.events, loader), (err) => err.code === 'PU001');
      // Within one transaction only.
      await loader.query('BEGIN');
      await loader.query("SET LOCAL pryv.unindexed_writes = 'allow'");
      await insert(GUARDED_ROWS.events, loader);
      await loader.query('COMMIT');
      await assert.rejects(insert(GUARDED_ROWS.events, loader), (err) => err.code === 'PU001');
    } finally {
      await loader.query('RESET pryv.unindexed_writes').catch(() => {});
      loader.release();
    }
  });
});
