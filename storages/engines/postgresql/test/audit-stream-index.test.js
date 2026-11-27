/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [PGAS] audit_event_streams: the access stream ids of each audit record,
 * kept by triggers, filled by a resumable pass, and used to read one access's
 * audit trail in time order. The reader keeps the stream filter of the plain
 * statement: the table orders and narrows, never authorizes.
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as helpers from '../../../test/helpers/index.js';
import { DatabasePG } from '../src/DatabasePG.ts';
import { AuditStoragePG } from '../src/AuditStoragePG.ts';
import { UserAuditDatabasePG, buildSelectQuery } from '../src/UserAuditDatabasePG.ts';
import { ensureAuditStreamIndex, BATCH_LOCK_KEY, PUT_TRIGGER, DROP_TRIGGER } from '../src/auditStreamIndex.ts';
const require = createRequire(import.meta.url);
const migration = require('../migrations/20261127_140000_audit_stream_index.js');

const PREFIX = 'pgas-';
const NO_LOG = { getLogger: () => ({ debug () {}, info () {}, warn () {}, error () {} }) };

describe('[PGAS] PostgreSQL audit records indexed by access', function () {
  this.timeout(120_000);
  let db;
  let n = 0;
  const newUser = () => PREFIX + Date.now().toString(36) + '-' + (n++) + '-' + Math.random().toString(36).slice(2, 6);

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    await db.initSchema();
    const { _internals } = require('../src/_internals.ts');
    if (!_internals.getLogger && helpers.getLogger) _internals.set('getLogger', helpers.getLogger);
    await ensureAuditStreamIndex(db);
  });

  afterEach(async function () {
    if (db == null) return;
    await db.query('DELETE FROM audit_events WHERE user_id LIKE $1', [PREFIX + '%']);
    await db.query('DELETE FROM audit_event_streams WHERE user_id LIKE $1', [PREFIX + '%']);
    // Whatever a test did, leave triggers, state and table as a started core has them.
    await db.ensureAuditStreamIndexInstalled();
    await ensureAuditStreamIndex(db);
  });

  after(async function () { if (db != null) await db.close(); });

  async function put (userId, id, streamIds, time, extra = {}) {
    await db.query(
      'INSERT INTO audit_events (user_id, eventid, stream_ids, type, time, created, modified, head_id, deleted, trashed) ' +
      'VALUES ($1, $2, $3, $4, $5, $5, $5, $6, $7, $8)',
      [userId, id, streamIds == null ? null : streamIds.join(' ') + ' ..', extra.type ?? 'audit-log/pryv-api', time,
        extra.headId ?? null, extra.deleted ?? null, extra.trashed ?? false]);
  }

  async function junction (userId) {
    const res = await db.query('SELECT stream_id, time, eventid FROM audit_event_streams WHERE user_id = $1', [userId]);
    return res.rows.map((r) => r.stream_id + '|' + r.time + '|' + r.eventid).sort();
  }

  // Missing and extra rows of the whole table against audit_events.
  async function drift () {
    const res = await db.query(`
      WITH want AS (
        SELECT DISTINCT a.user_id, t AS stream_id, a.time, a.eventid
        FROM audit_events a, unnest(string_to_array(a.stream_ids, ' ')) AS t
        WHERE a.time IS NOT NULL AND left(t, 7) = 'access-'
      ), have AS (SELECT user_id, stream_id, time, eventid FROM audit_event_streams)
      SELECT (SELECT count(*) FROM (SELECT * FROM want EXCEPT SELECT * FROM have) m)::int AS missing,
             (SELECT count(*) FROM (SELECT * FROM have EXCEPT SELECT * FROM want) x)::int AS extra`);
    return res.rows[0];
  }

  async function state () {
    return (await db.query('SELECT complete, cursor_user_id, cursor_eventid FROM audit_event_streams_state')).rows[0];
  }

  async function resetState () {
    await db.query('UPDATE audit_event_streams_state SET complete = false, cursor_user_id = NULL, cursor_eventid = NULL');
  }

  async function triggerState (name) {
    const res = await db.query('SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = \'audit_events\'::regclass', [name]);
    return res.rows[0]?.tgenabled ?? null;
  }

  function userDb (userId, complete) {
    return new UserAuditDatabasePG(db, userId, NO_LOG, db, { on: false }, { isComplete: () => complete });
  }

  const BASE = () => [{ type: 'equal', content: { field: 'trashed', value: false } }];
  const one = (id) => ({ type: 'streamsQuery', content: [[{ any: [id] }]] });

  async function read (userId, query, options, complete) {
    return (await userDb(userId, complete).getEvents({ query: structuredClone(query), options: { ...options } })).map((e) => e.id);
  }

  async function readStreamed (userId, query, options, complete) {
    const ids = [];
    for await (const e of userDb(userId, complete).getEventsStreamed({ query: structuredClone(query), options: { ...options } })) ids.push(e.id);
    return ids;
  }

  it('[PGAS1] the insert trigger writes one row per access term of a record with a time', async function () {
    const u = newUser();
    await put(u, 'e1', ['access-a', 'action-events.get'], 10);
    await put(u, 'e2', ['access-b', 'access-b:3', 'action-events.get'], 11);
    await put(u, 'e3', ['access-c', 'access-d', 'access-e', 'action-accesses.delete'], 12);
    await put(u, 'e4', ['action-auth.login'], 13);
    await put(u, 'e5', ['access-f', 'action-x'], null);
    await put(u, 'e6', ['access-g', 'access-g', 'accessory', 'xaccess-h'], 14);
    await put(u, 'e7', null, 15);
    assert.deepStrictEqual(await junction(u), [
      'access-a|10|e1', 'access-b:3|11|e2', 'access-b|11|e2', 'access-c|12|e3', 'access-d|12|e3', 'access-e|12|e3', 'access-g|14|e6'
    ].sort());
  });

  it('[PGAS2] updates and deletes keep the rows exact; a whole account in one statement; deleteUser', async function () {
    const u = newUser();
    const other = newUser();
    await put(u, 'e1', ['access-a', 'action-y'], 10);
    await put(u, 'e2', ['access-b', 'action-y'], 11);
    await put(other, 'e1', ['access-a', 'action-y'], 10);
    await db.query('UPDATE audit_events SET stream_ids = $3 WHERE user_id = $1 AND eventid = $2', [u, 'e1', 'access-z action-y ..']);
    await db.query('UPDATE audit_events SET time = 99 WHERE user_id = $1 AND eventid = $2', [u, 'e2']);
    assert.deepStrictEqual(await junction(u), ['access-b|99|e2', 'access-z|10|e1']);
    // An update through the storage (it rewrites every column it is given).
    await userDb(u, true).updateEvent('e2', { id: 'e2', streamIds: ['access-c', 'action-y'], time: 50 });
    assert.deepStrictEqual(await junction(u), ['access-c|50|e2', 'access-z|10|e1']);
    await db.query('DELETE FROM audit_events WHERE user_id = $1 AND eventid = $2', [u, 'e1']);
    assert.deepStrictEqual(await junction(u), ['access-c|50|e2']);

    await db.query(`INSERT INTO audit_events (user_id, eventid, stream_ids, type, time, created, modified)
      SELECT $1, 'bulk-' || i, 'access-' || (i % 7) || ' access-q:' || (i % 3) || ' action-y ..', 'audit-log/pryv-api', i, i, i
      FROM generate_series(1, 5000) AS i`, [u]);
    assert.strictEqual((await junction(u)).length, 10001);
    await db.query('DELETE FROM audit_events WHERE user_id = $1', [u]);
    assert.deepStrictEqual(await junction(u), []);
    assert.deepStrictEqual(await junction(other), ['access-a|10|e1']);

    // One statement emptying an account and deleting part of another.
    const third = newUser();
    await put(u, 'x1', ['access-a'], 1);
    await put(u, 'x2', ['access-b'], 2);
    await put(third, 'y1', ['access-a', 'access-c'], 1);
    await put(third, 'y2', ['access-a'], 2);
    await db.query('DELETE FROM audit_events WHERE user_id = $1 OR (user_id = $2 AND eventid = $3)', [u, third, 'y1']);
    assert.deepStrictEqual(await junction(u), []);
    assert.deepStrictEqual(await junction(third), ['access-a|2|y2']);
    assert.deepStrictEqual(await junction(other), ['access-a|10|e1']);

    const storage = new AuditStoragePG(db);
    await storage.init();
    // A row a disabled trigger would have left: deleteUser removes it too.
    await db.query('INSERT INTO audit_event_streams (user_id, stream_id, time, eventid) VALUES ($1, $2, 1, $3)', [other, 'access-orphan', 'gone']);
    await storage.deleteUser(other);
    assert.deepStrictEqual(await junction(other), []);
  });

  it('[PGAS3] the fill indexes records written without the triggers, then is a no-op', async function () {
    const u = newUser();
    await db.query(`ALTER TABLE audit_events DISABLE TRIGGER ${PUT_TRIGGER}`);
    try {
      for (let i = 0; i < 250; i++) await put(u, 'f' + String(i).padStart(4, '0'), ['access-' + (i % 5), 'action-y'], 1000 + Math.floor(i / 3));
    } finally {
      await db.query(`ALTER TABLE audit_events ENABLE TRIGGER ${PUT_TRIGGER}`);
    }
    assert.deepStrictEqual(await junction(u), []);
    await resetState();
    const res = await ensureAuditStreamIndex(db, { batchRows: 100 });
    assert.strictEqual(res.fromZero, true);
    assert.ok(res.batches >= 3, 'several batches: ' + res.batches);
    assert.strictEqual((await junction(u)).length, 250);
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
    assert.deepStrictEqual(await state(), { complete: true, cursor_user_id: null, cursor_eventid: null });
    const again = await ensureAuditStreamIndex(db, { batchRows: 100 });
    assert.strictEqual(again.alreadyComplete, true);
    assert.strictEqual(again.rows, 0);
    // The migration is the same call.
    assert.strictEqual((await migration.up({ db })).alreadyComplete, true);
  });

  it('[PGAS4] a fill stopped after a batch resumes at its position', async function () {
    const u = newUser();
    for (let i = 0; i < 300; i++) await put(u, 'r' + String(i).padStart(4, '0'), ['access-' + (i % 4), 'action-y'], 2000 + i);
    // Rows a resumed run must not depend on: removed, then the state reset.
    await db.query('DELETE FROM audit_event_streams WHERE user_id = $1', [u]);
    await resetState();
    await assert.rejects(ensureAuditStreamIndex(db, {
      batchRows: 100,
      afterBatch: (b) => { if (b === 1) throw new Error('stopped on purpose'); }
    }), /stopped on purpose/);
    const stopped = await state();
    assert.strictEqual(stopped.complete, false);
    assert.ok(stopped.cursor_user_id != null && stopped.cursor_eventid != null, 'position recorded');
    const res = await ensureAuditStreamIndex(db, { batchRows: 100 });
    assert.strictEqual(res.fromZero, false);
    assert.strictEqual((await junction(u)).length, 300);
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
    assert.strictEqual((await state()).complete, true);
  });

  it('[PGAS5] the install recreates a dropped trigger, enables a disabled one, and resets a complete state', async function () {
    const u = newUser();
    assert.strictEqual((await state()).complete, true);
    await db.query(`DROP TRIGGER ${PUT_TRIGGER} ON audit_events`);
    await put(u, 'unseen', ['access-a', 'action-y'], 5);
    let res = await db.ensureAuditStreamIndexInstalled();
    assert.deepStrictEqual([res[PUT_TRIGGER], res[DROP_TRIGGER], res.complete, res.reset], ['created', 'present', false, true]);
    assert.strictEqual(await triggerState(PUT_TRIGGER), 'O');
    await ensureAuditStreamIndex(db);
    assert.deepStrictEqual(await junction(u), ['access-a|5|unseen']);

    await db.query(`ALTER TABLE audit_events DISABLE TRIGGER ${DROP_TRIGGER}`);
    await db.query('DELETE FROM audit_events WHERE user_id = $1', [u]);
    assert.deepStrictEqual(await junction(u), ['access-a|5|unseen'], 'left by the disabled trigger');
    res = await db.ensureAuditStreamIndexInstalled();
    assert.deepStrictEqual([res[PUT_TRIGGER], res[DROP_TRIGGER], res.complete, res.reset], ['present', 're-enabled', false, true]);
    const fill = await ensureAuditStreamIndex(db);
    assert.strictEqual(fill.fromZero, true);
    assert.deepStrictEqual(await junction(u), [], 'a fill from zero removes what the disabled trigger left');
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });

    // A missing state row on a table holding records starts incomplete.
    await put(u, 'k', ['access-k'], 6);
    await db.query('DELETE FROM audit_event_streams_state');
    res = await db.ensureAuditStreamIndexInstalled();
    assert.deepStrictEqual([res.complete, res.reset], [false, false]);
    // And a fill refuses to say complete while a trigger is not firing.
    await db.query(`ALTER TABLE audit_events DISABLE TRIGGER ${PUT_TRIGGER}`);
    try {
      await assert.rejects(ensureAuditStreamIndex(db), /disabled/);
      assert.strictEqual((await state()).complete, false);
    } finally {
      await db.query(`ALTER TABLE audit_events ENABLE TRIGGER ${PUT_TRIGGER}`);
    }
  });

  it('[PGAS6] records written during a fill end up indexed', async function () {
    const u = newUser();
    for (let i = 0; i < 400; i++) await put(u, 'w' + String(i).padStart(4, '0'), ['access-' + (i % 3), 'action-y'], 3000 + i);
    await resetState();
    const writer = userDb(u, false);
    const run = { stop: false };
    let written = 0;
    const writes = (async () => {
      while (!run.stop) {
        await writer.createEvent({ id: 'live-' + written, streamIds: ['access-' + (written % 3), 'action-y'], type: 'audit-log/pryv-api', time: 5000 + written });
        written++;
      }
    })();
    try {
      await ensureAuditStreamIndex(db, { batchRows: 40, afterBatch: () => new Promise((resolve) => setTimeout(resolve, 5)) });
    } finally {
      run.stop = true;
      await writes;
    }
    assert.ok(written > 0, 'writes ran during the fill');
    assert.strictEqual((await junction(u)).length, 400 + written);
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
  });

  // A user whose trail exercises every case the reader must keep identical.
  async function seedEquivalence (u) {
    let k = 0;
    const id = () => 'q' + String(k++).padStart(4, '0');
    for (let i = 0; i < 160; i++) {
      const time = 10_000 + Math.floor(i / 4); // 4 records per time value
      const terms = [];
      if (i % 2 === 0) terms.push('access-a');
      if (i % 3 === 0) terms.push('access-b');
      if (i % 5 === 0) terms.push('access-a:1');
      if (i % 11 === 0) terms.push('access-p%q_r');
      if (i % 13 === 0) terms.push('access-pxqyr'); // what an unescaped `%`/`_` would match
      terms.push(i % 7 === 0 ? 'action-events.get' : 'action-streams.get');
      await put(u, id(), terms, time, {
        type: i % 9 === 0 ? 'audit-log/pryv-api-error' : 'audit-log/pryv-api',
        headId: i % 17 === 0 ? 'q-head' : null,
        deleted: i % 19 === 0 ? 1 : null,
        trashed: i % 23 === 0
      });
    }
    // Records written without the trigger by an old release are covered by
    // the fill; here, one record changes time after being written.
    await db.query('UPDATE audit_events SET time = 10010.5 WHERE user_id = $1 AND eventid = $2', [u, 'q0002']);
  }

  it('[PGAS7] the indexed read returns the same rows in the same order as the plain one', async function () {
    const u = newUser();
    await seedEquivalence(u);
    const shapes = [];
    for (const id of ['access-a', 'access-b', 'access-a:1', 'access-p%q_r', 'access-none']) {
      shapes.push([id, [...BASE(), one(id)]]);
      shapes.push([id + ' not', [...BASE(), { type: 'streamsQuery', content: [[{ any: [id] }, { not: ['access-b'] }]] }]]);
      shapes.push([id + ' plain id', [...BASE(), { type: 'streamsQuery', content: [[id]] }]]);
      shapes.push([id + ' time', [...BASE(), one(id), { type: 'lowerOrEqual', content: { field: 'time', value: 10_030 } },
        { type: 'greaterOrEqual', content: { field: 'time', value: 10_005 } }]]);
      shapes.push([id + ' greater', [...BASE(), one(id), { type: 'greater', content: { field: 'time', value: 10_020 } }]]);
      shapes.push([id + ' types', [...BASE(), one(id), { type: 'typesList', content: ['audit-log/pryv-api-error'] }]]);
      shapes.push([id + ' all states', [one(id)]]);
    }
    let compared = 0;
    for (const [name, query] of shapes) {
      for (const time of [-1, 1]) {
        for (const limit of [1, 3, 20, undefined]) {
          for (const skip of [0, 5, 500]) {
            const options = { sort: { time }, limit, skip };
            const plain = await read(u, query, options, false);
            const indexed = await read(u, query, options, true);
            assert.deepStrictEqual(indexed, plain, `${name} ${JSON.stringify(options)}`);
            compared++;
          }
        }
      }
      const streamed = await readStreamed(u, query, { sort: { time: -1 }, limit: 7 }, true);
      assert.deepStrictEqual(streamed, await readStreamed(u, query, { sort: { time: -1 }, limit: 7 }, false), name + ' streamed');
    }
    assert.ok(compared > 500);
    // Not vacuous: the read of access-a has pages, and ties at equal times.
    const all = await read(u, [...BASE(), one('access-a')], { sort: { time: -1 } }, true);
    assert.ok(all.length > 60, 'rows: ' + all.length);
    const literal = await read(u, [one('access-p%q_r')], { sort: { time: 1 } }, true);
    assert.ok(literal.length > 5 && !literal.includes('q0013'), 'the literal `%`/`_` id does not match its look-alike: ' + literal);
  });

  it('[PGAS8] only an eligible query uses the table', function () {
    const sqlOf = (query, options = { sort: { time: -1 }, limit: 20 }, complete = true) =>
      buildSelectQuery('u', { query, options }, complete).sql;
    const uses = (sql) => sql.includes('audit_event_streams');
    assert.ok(uses(sqlOf([one('access-x')])));
    assert.ok(uses(sqlOf([{ type: 'streamsQuery', content: [['access-x', { not: ['access-y'] }]] }])));
    assert.ok(uses(sqlOf([one('access-x')], { sort: { time: 1 } })));
    const plain = buildSelectQuery('u', { query: [one('access-x')], options: { sort: { time: -1 }, limit: 20 } }, false).sql;
    assert.strictEqual(plain, 'SELECT * FROM audit_events WHERE user_id = $1 AND ((((\' \' || stream_ids || \' \') LIKE $2 ESCAPE \'\\\'))) ' +
      'ORDER BY time DESC, eventid DESC LIMIT 20');
    for (const [name, query, options] of [
      ['two ids', [{ type: 'streamsQuery', content: [[{ any: ['access-x', 'access-y'] }]] }]],
      ['two blocks', [{ type: 'streamsQuery', content: [[{ any: ['access-x'] }], [{ any: ['access-y'] }]] }]],
      ['two stream queries', [one('access-x'), one('access-y')]],
      ['star', [one('*')]],
      ['action', [one('action-events.get')]],
      ['a space', [one('access-x action-y')]],
      ['no stream', [BASE()[0]]],
      ['types', [one('access-x'), { type: 'typesList', content: ['audit-log/pryv-api-error'] }]],
      ['bare object block', [{ type: 'streamsQuery', content: [{ any: ['access-x'] }] }]],
      ['no sort', [one('access-x')], { limit: 20 }],
      ['other sort', [one('access-x')], { sort: { modified: -1 } }],
      ['time null', [one('access-x'), { type: 'equal', content: { field: 'time', value: null } }]],
      ['time or null', [one('access-x'), { type: 'greaterOrEqualOrNull', content: { field: 'time', value: 1 } }]]
    ]) {
      assert.ok(!uses(sqlOf(query, options)), name);
    }
    assert.ok(!uses(sqlOf([one('access-x')], undefined, false)), 'incomplete');
  });

  it('[PGAS9] the indexed read is an ordered scan of the primary key, without a sort', async function () {
    const u = newUser();
    await db.query(`INSERT INTO audit_events (user_id, eventid, stream_ids, type, time, created, modified)
      SELECT $1, 'p' || i, 'access-' || (i % 50) || ' action-y ..', 'audit-log/pryv-api', i / 20, i, i
      FROM generate_series(1, 5000) AS i`, [u]);
    await db.query('ANALYZE audit_events');
    await db.query('ANALYZE audit_event_streams');
    const { sql, values } = buildSelectQuery(u, {
      query: [...BASE(), one('access-7'), { type: 'equal', content: { field: 'deleted', value: null } }, { type: 'equal', content: { field: 'head_id', value: null } }],
      options: { sort: { time: -1 }, limit: 20 }
    }, true);
    const plan = (await db.query('EXPLAIN ' + sql, values)).rows.map((r) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /audit_event_streams_pkey/, plan);
    assert.doesNotMatch(plan, /\bSort\b/, plan);
  });

  it('[PGASA] a forged or stale row of the table never returns a record the stream filter refuses, nor twice', async function () {
    const u = newUser();
    const v = newUser();
    await put(u, 'mine', ['access-x', 'action-y'], 100);
    await put(u, 'theirs', ['access-other', 'action-y'], 101);
    await put(v, 'foreign', ['access-x', 'action-y'], 102);
    // A row pointing at a record of u that does not hold access-x, one at a
    // record id only v has, and a stale copy of `mine` at another time.
    await db.query('INSERT INTO audit_event_streams (user_id, stream_id, time, eventid) VALUES ($1, $2, 101, $3), ($1, $2, 102, $4), ($1, $2, 99, $5)',
      [u, 'access-x', 'theirs', 'foreign', 'mine']);
    for (const time of [-1, 1]) {
      const ids = await read(u, [...BASE(), one('access-x')], { sort: { time } }, true);
      assert.deepStrictEqual(ids, ['mine']);
    }
  });

  it('[PGASB] a deletion during a batch removes the rows that batch adds', async function () {
    const u = newUser();
    await put(u, 'd1', ['access-x', 'action-y'], 100);
    const batch = await db.getClient();
    let deleted = false;
    try {
      await batch.query('BEGIN');
      await batch.query('SELECT pg_advisory_xact_lock($1)', [BATCH_LOCK_KEY]);
      // What a batch that read `d1` before its deletion writes (already there
      // from the trigger: removed first, so the batch's copy is the only one).
      await db.query('DELETE FROM audit_event_streams WHERE user_id = $1', [u]);
      await batch.query('INSERT INTO audit_event_streams (user_id, stream_id, time, eventid) VALUES ($1, \'access-x\', 100, \'d1\')', [u]);
      const deletion = db.query('DELETE FROM audit_events WHERE user_id = $1', [u]).then(() => { deleted = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.strictEqual(deleted, false, 'the deletion waits for the batch');
      await batch.query('COMMIT');
      await deletion;
    } finally {
      batch.release();
    }
    assert.deepStrictEqual(await junction(u), []);
  });

  it('[PGASC] two fills at once: one does the work, both resolve, state complete', async function () {
    const u = newUser();
    for (let i = 0; i < 200; i++) await put(u, 't' + String(i).padStart(4, '0'), ['access-' + (i % 4)], 4000 + i);
    await db.query('DELETE FROM audit_event_streams WHERE user_id = $1', [u]);
    await resetState();
    const [a, b] = await Promise.all([ensureAuditStreamIndex(db, { batchRows: 50 }), ensureAuditStreamIndex(db, { batchRows: 50 })]);
    assert.deepStrictEqual([a.alreadyComplete, b.alreadyComplete].sort(), [false, true]);
    assert.strictEqual((await junction(u)).length, 200);
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
  });

  it('[PGASD] the accesses listing reads the table once complete, and lists the same ids', async function () {
    const u = newUser();
    await seedEquivalence(u);
    await put(u, 'notime', ['access-only-without-time'], null);
    const plain = (await userDb(u, false).getAllAccesses()).map((r) => r.term).sort();
    const indexed = (await userDb(u, true).getAllAccesses()).map((r) => r.term).sort();
    // A record without a time is not in the table: its ids are read directly.
    assert.deepStrictEqual(indexed, plain);
    assert.deepStrictEqual(indexed, ['access-a', 'access-a:1', 'access-b', 'access-only-without-time', 'access-p%q_r', 'access-pxqyr']);
    assert.deepStrictEqual(await userDb(newUser(), true).getAllAccesses(), []);
  });

  it('[PGASE] the storage reads the state at init and again in the background once stale', async function () {
    const storage = new AuditStoragePG(db);
    await storage.init();
    assert.strictEqual(storage.streamIndex.complete, true);
    await resetState();
    storage.streamIndex.recheckMs = 0;
    assert.strictEqual(storage.streamIndex.isComplete(), true, 'the value held until the background read ends');
    await storage.streamIndex.refreshing;
    assert.strictEqual(storage.streamIndex.isComplete(), false);
    const filled = await storage.ensureStreamIndex();
    assert.strictEqual(filled.alreadyComplete, false);
    assert.strictEqual(storage.streamIndex.complete, true);
  });
});
