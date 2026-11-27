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
 * An index removal waits for the inserts in flight for its id (a per-user
 * advisory lock), so an erasure removing the entry meanwhile waits, then
 * removes the rows too.
 */

import assert from 'node:assert';
import * as helpers from '../../../test/helpers/index.js';
import { DatabasePG } from '../src/DatabasePG.ts';
import {
  GUARDED_TABLES, INDEX_TRIGGER_NAME, LOCK_CLASS, ROW_LOCK_FUNCTION_SQL, installUnindexedWritesGuard, isUnindexedUserError
} from '../src/unindexedWritesGuard.ts';
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

  // --------------------------------------------------------------------
  // [PGAL] the lock is a per-user advisory lock: shared on insert,
  // exclusive on the index removal (a trigger on users_index).
  // --------------------------------------------------------------------

  async function advisoryLocksOf (client) {
    const pid = (await client.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const res = await db.query(
      "SELECT mode FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::bigint::oid AND objsubid = 2 AND pid = $2", [LOCK_CLASS, pid]);
    return res.rows.map((r) => r.mode);
  }

  async function countEvents (id = userId) {
    return (await db.query('SELECT count(*)::int AS c FROM events WHERE user_id = $1', [id])).rows[0].c;
  }

  /** Resolves to a flag object whose `done` turns true once `promise` settles. */
  function track (promise) {
    const state = { done: false, promise: null };
    state.promise = promise.then((r) => { state.done = true; return r; }, (e) => { state.done = true; throw e; });
    state.promise.catch(() => {}); // the caller's own await still receives the rejection
    return state;
  }

  it('[PGAL1] an insert holds one shared advisory lock and writes no row lock on the index entry; the escape takes none', async function () {
    await index();
    const writer = await db.getClient();
    try {
      await writer.query('BEGIN');
      await insert(GUARDED_ROWS.events, writer);
      assert.deepStrictEqual(await advisoryLocksOf(writer), ['ShareLock']);
      const entry = await db.query('SELECT xmax::text AS x FROM users_index WHERE user_id = $1', [userId]);
      assert.strictEqual(entry.rows[0].x, '0', 'a row lock was written on the index entry');
      await writer.query("INSERT INTO events (user_id, id) SELECT $1, 'pgal-bulk-' || g FROM generate_series(1, 1000) g", [userId]);
      assert.deepStrictEqual(await advisoryLocksOf(writer), ['ShareLock'], 'one lock for one id, whatever the row count');
      await writer.query('ROLLBACK');
      await writer.query('BEGIN');
      await writer.query("SET LOCAL pryv.unindexed_writes = 'allow'");
      await insert(GUARDED_ROWS.events, writer);
      assert.deepStrictEqual(await advisoryLocksOf(writer), []);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
    }
  });

  it('[PGAL2] an index removal in flight holds inserts back: refused once it commits, accepted if it rolls back', async function () {
    for (const outcome of ['COMMIT', 'ROLLBACK']) {
      await index();
      const eraser = await db.getClient();
      try {
        await eraser.query('BEGIN');
        await eraser.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
        const write = track(insert(GUARDED_ROWS.events));
        await sleep(300);
        assert.strictEqual(write.done, false, outcome + ': an insert passed an index removal in flight');
        await eraser.query(outcome);
        if (outcome === 'COMMIT') {
          await assert.rejects(write.promise, (err) => err.code === 'PU001');
          assert.strictEqual(await countEvents(), 0);
        } else {
          assert.strictEqual((await write.promise).rowCount, 1);
          await db.query('DELETE FROM events WHERE user_id = $1', [userId]);
          await db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
        }
      } finally {
        await eraser.query('ROLLBACK').catch(() => {});
        eraser.release();
      }
    }
  });

  it('[PGAL3] a transaction opened before an erasure and inserting after it stores nothing, in read committed and in repeatable read', async function () {
    for (const begin of ['BEGIN', 'BEGIN ISOLATION LEVEL REPEATABLE READ']) {
      await index();
      const writer = await db.getClient();
      try {
        await writer.query(begin);
        await writer.query('SELECT count(*) FROM users_index WHERE user_id = $1', [userId]); // snapshot taken
        await db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
        await assert.rejects(insert(GUARDED_ROWS.events, writer),
          (err) => err.code === 'PU001' || err.code === '40001', begin);
      } finally {
        await writer.query('ROLLBACK').catch(() => {});
        writer.release();
      }
      assert.strictEqual(await countEvents(), 0, begin);
    }
  });

  it('[PGAL4] an index entry changing id waits for an insert in flight; a rename does not', async function () {
    await index();
    const newId = userId + '-moved';
    const writer = await db.getClient();
    try {
      await writer.query('BEGIN');
      await insert(GUARDED_ROWS.events, writer);
      const rename = track(db.query('UPDATE users_index SET username = $2 WHERE user_id = $1', [userId, userId + '-renamed']));
      await Promise.race([rename.promise, sleep(5000)]);
      assert.strictEqual(rename.done, true, 'a rename waited for an insert in flight');
      await rename.promise;
      const move = track(db.query('UPDATE users_index SET user_id = $2 WHERE user_id = $1', [userId, newId]));
      await sleep(300);
      assert.strictEqual(move.done, false, 'the id changed under an insert in flight');
      await writer.query('COMMIT');
      assert.strictEqual((await move.promise).rowCount, 1);
      await assert.rejects(insert(GUARDED_ROWS.events), (err) => err.code === 'PU001');
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      await db.query('DELETE FROM users_index WHERE user_id = $1', [newId]);
    }
  });

  it('[PGAL5] the boot check creates a missing users_index lock trigger and enables a disabled one, with a warning', async function () {
    const warns = [];
    const originalWarn = db.logger.warn;
    const outcomes = [];
    try {
      db.logger.warn = (msg) => { warns.push(msg); };
      await db.query(`DROP TRIGGER ${INDEX_TRIGGER_NAME} ON users_index`);
      outcomes.push(await db.ensureUnindexedWritesGuard());
      await db.query(`ALTER TABLE users_index DISABLE TRIGGER ${INDEX_TRIGGER_NAME}`);
      outcomes.push(await db.ensureUnindexedWritesGuard());
      outcomes.push(await db.ensureUnindexedWritesGuard());
    } finally {
      db.logger.warn = originalWarn;
      await db.ensureUnindexedWritesGuard();
    }
    assert.deepStrictEqual(outcomes.map((o) => o.users_index), ['created', 're-enabled', 'present']);
    assert.ok(warns.some((m) => m.includes('"users_index"')), JSON.stringify(warns));
    const state = await db.query('SELECT tgenabled AS s FROM pg_trigger WHERE tgname = $1', [INDEX_TRIGGER_NAME]);
    assert.deepStrictEqual(state.rows.map((r) => r.s), ['O']);
  });

  it('[PGAL6] the row-lock body still holds with the users_index trigger present, and the boot check puts the advisory body back', async function () {
    const body = async () => (await db.query("SELECT prosrc FROM pg_proc WHERE proname = 'refuse_unindexed_user'")).rows[0].prosrc;
    try {
      await db.query(ROW_LOCK_FUNCTION_SQL);
      assert.ok(!(await body()).includes('pg_advisory_xact_lock_shared'));
      await index();
      const writer = await db.getClient();
      try {
        await writer.query('BEGIN');
        await insert(GUARDED_ROWS.events, writer);
        const removal = track(db.query('DELETE FROM users_index WHERE user_id = $1', [userId]));
        await sleep(300);
        assert.strictEqual(removal.done, false, 'the index entry was removed under an insert in flight');
        await writer.query('COMMIT');
        await removal.promise;
        assert.strictEqual((await db.query('DELETE FROM events WHERE user_id = $1', [userId])).rowCount, 1);
      } finally {
        await writer.query('ROLLBACK').catch(() => {});
        writer.release();
      }
    } finally {
      await db.ensureUnindexedWritesGuard();
    }
    assert.ok((await body()).includes('pg_advisory_xact_lock_shared'));
  });

  it('[PGAL9] the installer sets the removal side up before the insert body, and installs the row-lock body when it cannot', async function () {
    const quietLogger = { info () {}, warn () {}, error () {} };
    /** A recording client; `fail(sql)` true throws a non-retryable error; `indexTriggerState` answers the users_index state query. */
    function fakeClient ({ fail = () => false, indexTriggerState } = {}) {
      const issued = [];
      return {
        issued,
        async query (sql, params) {
          issued.push(sql);
          if (fail(sql)) throw Object.assign(new Error('injected'), { code: '42501' });
          if (sql.startsWith('SELECT tgenabled') && params?.[1] === 'users_index' && indexTriggerState != null) {
            return { rows: [{ tgenabled: indexTriggerState }] };
          }
          return { rows: [] };
        }
      };
    }
    const advisoryBody = (s) => s.includes('pg_advisory_xact_lock_shared');

    const ok = fakeClient();
    const outcome = await installUnindexedWritesGuard(ok, quietLogger, { attempts: 1 });
    assert.strictEqual(outcome.users_index, 'created');
    const indexTrigger = ok.issued.findIndex((s) => s.startsWith(`CREATE TRIGGER ${INDEX_TRIGGER_NAME}`));
    const insertBody = ok.issued.findIndex(advisoryBody);
    assert.ok(indexTrigger >= 0 && insertBody > indexTrigger, 'order: users_index trigger, then the advisory insert body');

    const failures = {
      'CREATE TRIGGER fails': { fail: (s) => s.startsWith(`CREATE TRIGGER ${INDEX_TRIGGER_NAME}`) },
      'ENABLE TRIGGER fails': { indexTriggerState: 'D', fail: (s) => s.startsWith('ALTER TABLE users_index ENABLE TRIGGER') },
      'removal function fails': { fail: (s) => s.includes('FUNCTION lock_user_index_removal()') }
    };
    for (const [name, spec] of Object.entries(failures)) {
      const client = fakeClient(spec);
      const res = await installUnindexedWritesGuard(client, quietLogger, { attempts: 1 });
      assert.strictEqual(res.users_index, 'failed', name);
      assert.ok(!client.issued.some(advisoryBody), name + ': advisory insert body installed without the removal side');
      assert.ok(client.issued.includes(ROW_LOCK_FUNCTION_SQL), name + ': the row-lock body is installed instead');
      assert.strictEqual(client.issued.at(-1), 'RESET lock_timeout', name);
    }
  });

  it('[PGAL7] two ids sharing a lock key: an erasure of one waits for the other\'s insert in flight, the probe still tells them apart', async function () {
    const pair = await db.query(
      "SELECT array_agg(s ORDER BY s) AS ids FROM (SELECT 'pgal7-' || g AS s FROM generate_series(1, 300000) g) x GROUP BY hashtext(s) HAVING count(*) > 1 LIMIT 1");
    if (pair.rows.length === 0) return this.skip(); // no colliding pair among the candidates on this build
    const [a, b] = pair.rows[0].ids;
    const cleanup = async () => {
      for (const id of [a, b]) {
        await db.query('DELETE FROM events WHERE user_id = $1', [id]);
        await db.query('DELETE FROM users_index WHERE user_id = $1', [id]);
      }
    };
    await cleanup();
    for (const id of [a, b]) await db.query('INSERT INTO users_index (username, user_id) VALUES ($1, $1)', [id]);
    const writer = await db.getClient();
    try {
      await writer.query('BEGIN');
      await writer.query('INSERT INTO events (user_id, id) VALUES ($1, $2)', [b, 'pgal7-b1']);
      const removal = track(db.query('DELETE FROM users_index WHERE user_id = $1', [a]));
      await sleep(300);
      assert.strictEqual(removal.done, false, 'the colliding key did not serialize the erasure');
      await writer.query('COMMIT');
      await removal.promise;
      await assert.rejects(db.query('INSERT INTO events (user_id, id) VALUES ($1, $2)', [a, 'pgal7-a1']), (err) => err.code === 'PU001');
      assert.strictEqual((await db.query('INSERT INTO events (user_id, id) VALUES ($1, $2)', [b, 'pgal7-b2'])).rowCount, 1);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      await cleanup();
    }
  });

  it('[PGAL8] under concurrent writers, an erasure (index entry, then data) leaves no row and every later insert is refused', async function () {
    this.timeout(120000);
    const WRITERS = 8;
    const ITERATIONS = 15;
    const deadline = Date.now() + 90000;
    for (let round = 0; round < ITERATIONS && Date.now() < deadline; round++) {
      const id = `${userId}-l${round}`;
      await db.query('INSERT INTO users_index (username, user_id) VALUES ($1, $1)', [id]);
      const clients = await Promise.all(Array.from({ length: WRITERS }, () => db.getClient()));
      let seq = 0;
      const ctl = { stop: false };
      const unexpected = [];
      const loops = clients.map(async (c, w) => {
        while (!ctl.stop) {
          try {
            if (w % 2 === 0) {
              await c.query('INSERT INTO events (user_id, id) VALUES ($1, $2)', [id, `l${w}-${++seq}`]);
            } else {
              await c.query('BEGIN');
              for (let k = 0; k < 3; k++) await c.query('INSERT INTO events (user_id, id) VALUES ($1, $2)', [id, `l${w}-${++seq}`]);
              await c.query('COMMIT');
            }
          } catch (err) {
            await c.query('ROLLBACK').catch(() => {});
            if (err.code !== 'PU001') unexpected.push(err.code + ' ' + err.message);
            return;
          }
        }
      });
      let left;
      try {
        await sleep(30 + (round % 5) * 10);
        await db.query('DELETE FROM users_index WHERE user_id = $1', [id]);
        await db.query('DELETE FROM events WHERE user_id = $1', [id]);
        await Promise.all(loops);
        left = await countEvents(id);
      } finally {
        ctl.stop = true;
        await Promise.allSettled(loops);
        for (const c of clients) c.release();
        await db.query('DELETE FROM events WHERE user_id = $1', [id]);
        await db.query('DELETE FROM users_index WHERE user_id = $1', [id]);
      }
      assert.deepStrictEqual(unexpected, [], `round ${round}`);
      assert.strictEqual(left, 0, `round ${round}: rows left after the erasure`);
      await assert.rejects(db.query('INSERT INTO events (user_id, id) VALUES ($1, $2)', [id, 'late']), (err) => err.code === 'PU001');
    }
  });
});
