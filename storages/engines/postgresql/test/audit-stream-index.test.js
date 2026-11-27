/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [PGAS] audit_event_streams: the access stream ids of each audit record,
 * kept by triggers, filled by a resumable pass, and used to read the audit
 * trail of one access, or of several (an ordered merge of their ranges), in
 * time order. The reader keeps the stream filter of the plain
 * statement: the table orders and narrows, never authorizes.
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as helpers from '../../../test/helpers/index.js';
import { DatabasePG } from '../src/DatabasePG.ts';
import { AuditStoragePG } from '../src/AuditStoragePG.ts';
import { UserAuditDatabasePG, buildSelectQuery, streamIndexTerms, MULTI_MAX_IDS } from '../src/UserAuditDatabasePG.ts';
import { ensureAuditStreamIndex, BATCH_LOCK_KEY, PUT_TRIGGER, DROP_TRIGGER, DROP_FUNCTION_SQL } from '../src/auditStreamIndex.ts';
const require = createRequire(import.meta.url);
const migration = require('../migrations/20261127_140000_audit_stream_index.js');

const PREFIX = 'pgas-';
const NO_LOG = { getLogger: () => ({ debug () {}, info () {}, warn () {}, error () {} }) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // What the install does (and the CHANGELOG's by-hand statement).
  async function resetState () {
    await db.query('UPDATE audit_event_streams_state SET complete = false, cursor_user_id = NULL, cursor_eventid = NULL, updated_at = now()');
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
      shapes.push([id + ' equal', [...BASE(), one(id), { type: 'equal', content: { field: 'time', value: 10_010 } }]]);
      shapes.push([id + ' and access-b', [...BASE(), { type: 'streamsQuery', content: [[{ any: [id] }, { any: ['access-b'] }]] }]]);
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
      const whole = await readStreamed(u, query, { sort: { time: 1 } }, true);
      assert.deepStrictEqual(whole, await readStreamed(u, query, { sort: { time: 1 } }, false), name + ' streamed, no limit');
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
    // The whole statement, `OFFSET 0` included: removing that fence lets the
    // planner walk the account's trail first (see buildSelectQuery).
    assert.strictEqual(sqlOf([one('access-x')]),
      'SELECT a.* FROM (SELECT eventid AS s_eventid, time AS s_time FROM audit_event_streams WHERE user_id = $1 AND stream_id = $3) s ' +
      'CROSS JOIN LATERAL (SELECT * FROM audit_events WHERE user_id = $1 AND ((((\' \' || stream_ids || \' \') LIKE $2 ESCAPE \'\\\'))) ' +
      'AND eventid = s.s_eventid AND time = s.s_time OFFSET 0) a ORDER BY s.s_time DESC, s.s_eventid DESC LIMIT 20');
    const plain = buildSelectQuery('u', { query: [one('access-x')], options: { sort: { time: -1 }, limit: 20 } }, false).sql;
    assert.strictEqual(plain, 'SELECT * FROM audit_events WHERE user_id = $1 AND ((((\' \' || stream_ids || \' \') LIKE $2 ESCAPE \'\\\'))) ' +
      'ORDER BY time DESC, eventid DESC LIMIT 20');
    for (const [name, query, options] of [
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
    // Seeded so that, without the `OFFSET 0` fence, the planner WANTS the bad
    // plan: every record names the access, the LIKE is estimated to match
    // almost none of them, so a flattened join expects to read the whole range
    // of the table for 20 rows and scans audit_events first instead.
    const u = newUser();
    await db.query(`INSERT INTO audit_events (user_id, eventid, stream_ids, type, time, created, modified, deleted, head_id)
      SELECT $1, 'p' || i, 'access-all action-y ..', 'audit-log/pryv-api', i / 20, i, i, NULL, NULL
      FROM generate_series(1, 5000) AS i`, [u]);
    await db.query('ANALYZE audit_events');
    await db.query('ANALYZE audit_event_streams');
    for (const [time, direction] of [[-1, 'Backward'], [1, 'Forward']]) {
      const { sql, values } = buildSelectQuery(u, {
        query: [...BASE(), one('access-all'), { type: 'equal', content: { field: 'deleted', value: null } }, { type: 'equal', content: { field: 'head_id', value: null } }],
        options: { sort: { time }, limit: 20 }
      }, true);
      const root = (await db.query('EXPLAIN (FORMAT JSON) ' + sql, values)).rows[0]['QUERY PLAN'][0].Plan;
      const text = JSON.stringify(root);
      const nodes = [];
      (function walk (n) { nodes.push(n); for (const c of n.Plans ?? []) walk(c); })(root);
      assert.ok(!nodes.some((n) => /Sort/.test(n['Node Type'])), 'no sort: ' + text);
      const loop = nodes.find((n) => n['Node Type'] === 'Nested Loop');
      assert.ok(loop != null, 'a nested loop: ' + text);
      const outer = loop.Plans.find((c) => c['Parent Relationship'] === 'Outer');
      assert.ok(/Index (Only )?Scan/.test(outer['Node Type']) && outer['Index Name'] === 'audit_event_streams_pkey' &&
        outer['Scan Direction'] === direction, 'the outer side reads the key ' + direction + ': ' + text);
    }
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

  it('[PGASF] a trigger not firing resets an incomplete state too, and a fill never leaves a position past unseen writes', async function () {
    const u = newUser();
    // A start that could not create the trigger, then a fill that walked the
    // whole table before failing its end check: incomplete, position past
    // every record. The core served meanwhile, without the trigger.
    await db.query(`DROP TRIGGER ${PUT_TRIGGER} ON audit_events`);
    await put(u, 'unseen', ['access-a', 'action-y'], 5);
    const last = (await db.query('SELECT max(user_id) AS m FROM audit_events')).rows[0].m;
    await db.query('UPDATE audit_event_streams_state SET complete = false, cursor_user_id = $1, cursor_eventid = $2', [last + 'z', '']);
    // The next start creates the trigger: the position is stale.
    const res = await db.ensureAuditStreamIndexInstalled();
    assert.deepStrictEqual([res[PUT_TRIGGER], res.complete, res.reset], ['created', false, true]);
    assert.deepStrictEqual(await state(), { complete: false, cursor_user_id: null, cursor_eventid: null });
    const fill = await ensureAuditStreamIndex(db);
    assert.strictEqual(fill.fromZero, true);
    assert.deepStrictEqual(await junction(u), ['access-a|5|unseen']);
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });

    // A fill started while a trigger is disabled: refused before reading, no position kept.
    await db.query(`ALTER TABLE audit_events DISABLE TRIGGER ${PUT_TRIGGER}`);
    try {
      await resetState();
      await assert.rejects(ensureAuditStreamIndex(db, { batchRows: 1000 }), /disabled/);
      assert.deepStrictEqual(await state(), { complete: false, cursor_user_id: null, cursor_eventid: null });
    } finally {
      await db.query(`ALTER TABLE audit_events ENABLE TRIGGER ${PUT_TRIGGER}`);
    }
    // A trigger disabled during the fill: the end check resets the position.
    try {
      await assert.rejects(ensureAuditStreamIndex(db, {
        batchRows: 1000,
        afterBatch: async (b) => { if (b === 1) await db.query(`ALTER TABLE audit_events DISABLE TRIGGER ${PUT_TRIGGER}`); }
      }), /disabled/);
      assert.deepStrictEqual(await state(), { complete: false, cursor_user_id: null, cursor_eventid: null });
    } finally {
      await db.query(`ALTER TABLE audit_events ENABLE TRIGGER ${PUT_TRIGGER}`);
    }
  });

  it('[PGASG] a state reset by another process during a fill restarts the fill from zero', async function () {
    const u = newUser();
    for (let i = 0; i < 300; i++) await put(u, 'r' + String(i).padStart(4, '0'), ['access-' + (i % 4)], 2000 + i);
    // Resume inside u's records (the rest of the table is indexed already).
    await db.query('UPDATE audit_event_streams_state SET complete = false, cursor_user_id = $1, cursor_eventid = $2, updated_at = now()', [u, 'r0100']);
    let batches = 0;
    const fill = await ensureAuditStreamIndex(db, {
      batchRows: 50,
      afterBatch: async () => {
        if (++batches !== 1) return;
        // What another process meets: a record written unseen behind the
        // position, then its install finds the trigger and resets the state.
        await db.query(`ALTER TABLE audit_events DISABLE TRIGGER ${PUT_TRIGGER}`);
        await put(u, 'r0050x', ['access-late'], 1);
        await db.query(`ALTER TABLE audit_events ENABLE TRIGGER ${PUT_TRIGGER}`);
        await resetState();
      }
    });
    assert.strictEqual(fill.fromZero, true, 'the run that completed started from zero');
    assert.ok((await junction(u)).includes('access-late|1|r0050x'));
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
    assert.strictEqual((await state()).complete, true);
  });

  it('[PGASH] an update during a batch removes the old row that batch adds', async function () {
    const u = newUser();
    await put(u, 'm1', ['access-x', 'action-y'], 100);
    const batch = await db.getClient();
    let updated = false;
    try {
      await batch.query('BEGIN');
      await batch.query('SELECT pg_advisory_xact_lock($1)', [BATCH_LOCK_KEY]);
      // What a batch that read the version before the update writes.
      await db.query('DELETE FROM audit_event_streams WHERE user_id = $1', [u]);
      await batch.query('INSERT INTO audit_event_streams (user_id, stream_id, time, eventid) VALUES ($1, \'access-x\', 100, \'m1\')', [u]);
      const update = db.query('UPDATE audit_events SET time = 200 WHERE user_id = $1 AND eventid = $2', [u, 'm1']).then(() => { updated = true; });
      await sleep(300);
      assert.strictEqual(updated, false, 'the update waits for the batch');
      await batch.query('COMMIT');
      await update;
    } finally {
      batch.release();
    }
    assert.deepStrictEqual(await junction(u), ['access-x|200|m1']);
  });

  it('[PGASI] a record written for an account while its whole trail is deleted keeps its row', async function () {
    const u = newUser();
    await put(u, 'old', ['access-x', 'action-y'], 1);
    // The delete function with a pause in the statement that finds the
    // emptied accounts: the late record commits during it.
    const paused = DROP_FUNCTION_SQL.replace('FROM gone g) u', 'FROM gone g) u, pg_sleep(1) z');
    assert.notStrictEqual(paused, DROP_FUNCTION_SQL);
    await db.query(paused);
    try {
      const deletion = db.query('DELETE FROM audit_events WHERE user_id = $1', [u]);
      await sleep(300);
      await put(u, 'late', ['access-y', 'action-y'], 2);
      await deletion;
    } finally {
      await db.query(DROP_FUNCTION_SQL);
    }
    assert.deepStrictEqual(await junction(u), ['access-y|2|late']);
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
  });

  it('[PGASJ] a fill from zero does not hold audit writes behind a read of the table', async function () {
    const u = newUser();
    await put(u, 'a', ['access-x', 'action-y'], 1);
    await resetState();
    const reader = await db.getClient();
    await reader.query('BEGIN');
    await reader.query('SELECT count(*) FROM audit_event_streams WHERE user_id = $1', [u]);
    const released = sleep(6000).then(() => reader.query('COMMIT')).finally(() => reader.release());
    try {
      const fill = ensureAuditStreamIndex(db);
      await sleep(500); // its TRUNCATE now waits for the reader
      const waiting = await db.query('SELECT count(*)::int AS n FROM pg_locks WHERE relation = \'audit_event_streams\'::regclass ' +
        'AND mode = \'AccessExclusiveLock\' AND NOT granted');
      assert.strictEqual(waiting.rows[0].n, 1, 'the fill waits for its TRUNCATE');
      const t0 = Date.now();
      await put(u, 'b', ['access-x', 'action-y'], 2);
      const waited = Date.now() - t0;
      assert.ok(waited < 3500, 'an audit insert waited ' + waited + ' ms');
      await fill;
    } finally {
      await released;
    }
    assert.deepStrictEqual(await junction(u), ['access-x|1|a', 'access-x|2|b']);
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
  });

  it('[PGASK] a restore imports records through the triggers', async function () {
    const u = newUser();
    await put(u, 'kept', ['access-a', 'action-y'], 1);
    const rows = [
      { eventid: 'kept', stream_ids: 'access-other action-y ..', time: 1, type: 'audit-log/pryv-api' },
      { eventid: 'new', stream_ids: 'access-b action-y ..', time: 2, type: 'audit-log/pryv-api' },
      { eventid: 'two', stream_ids: 'access-c access-d:2 action-y ..', time: 3, type: 'audit-log/pryv-api' },
      { eventid: 'notime', stream_ids: 'access-e action-y ..', time: null, type: 'audit-log/pryv-api' }
    ];
    await userDb(u, true).importAllEvents(rows);
    assert.deepStrictEqual(await junction(u), ['access-a|1|kept', 'access-b|2|new', 'access-c|3|two', 'access-d:2|3|two']);
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
  });

  it('[PGASL] a fill with inserts, single deletions, account erasures and time updates going on ends exact', async function () {
    const writer = newUser();
    const deleted = newUser();
    const updated = newUser();
    for (let i = 0; i < 200; i++) {
      const k = String(i).padStart(4, '0');
      await put(writer, 'w' + k, ['access-' + (i % 3)], 1000 + i);
      await put(deleted, 'd' + k, ['access-' + (i % 3), 'access-z'], 1000 + i);
      await put(updated, 'u' + k, ['access-' + (i % 3)], 1000 + i);
    }
    // Resume just before this test's accounts (the rest of the shared test
    // table is indexed already): small batches over these accounts only.
    await db.query('UPDATE audit_event_streams_state SET complete = false, cursor_user_id = $1, cursor_eventid = $2, updated_at = now()', [PREFIX, '']);
    const run = { stop: false };
    const counts = { inserts: 0, deletions: 0, erasures: 0, updates: 0 };
    const loops = [
      (async () => {
        while (!run.stop) await put(writer, 'live-' + counts.inserts++, ['access-' + (counts.inserts % 3), 'action-y'], 5000 + counts.inserts);
      })(),
      (async () => {
        for (let i = 0; i < 200 && !run.stop; i++) {
          await db.query('DELETE FROM audit_events WHERE user_id = $1 AND eventid = $2', [deleted, 'd' + String(i).padStart(4, '0')]);
          counts.deletions++;
        }
      })(),
      (async () => {
        while (!run.stop) {
          const v = newUser();
          for (let i = 0; i < 20; i++) await put(v, 'e' + i, ['access-' + (i % 2), 'action-y'], 100 + i);
          await db.query('DELETE FROM audit_events WHERE user_id = $1', [v]);
          counts.erasures++;
        }
      })(),
      (async () => {
        while (!run.stop) {
          const i = counts.updates++ % 200;
          await db.query('UPDATE audit_events SET time = time + 0.5 WHERE user_id = $1 AND eventid = $2', [updated, 'u' + String(i).padStart(4, '0')]);
        }
      })()
    ];
    try {
      await ensureAuditStreamIndex(db, { batchRows: 30, afterBatch: () => sleep(3) });
    } finally {
      run.stop = true;
      await Promise.all(loops);
    }
    assert.ok(counts.inserts > 0 && counts.deletions > 0 && counts.erasures > 0 && counts.updates > 0, JSON.stringify(counts));
    assert.deepStrictEqual(await drift(), { missing: 0, extra: 0 });
    assert.strictEqual((await state()).complete, true);
  });

  it('[PGASM] a record without a time: the plain read returns it, the indexed read does not (recorded decision)', async function () {
    const u = newUser();
    await put(u, 'timed', ['access-x', 'action-y'], 10);
    await put(u, 'untimed', ['access-x', 'action-y'], null);
    const query = [...BASE(), one('access-x')];
    assert.deepStrictEqual(await read(u, query, { sort: { time: -1 } }, false), ['untimed', 'timed']);
    assert.deepStrictEqual(await read(u, query, { sort: { time: -1 } }, true), ['timed']);
    // The same decision for several ids (the merge of their ranges).
    await put(u, 'timed-y', ['access-y', 'action-y'], 20);
    const both = [...BASE(), several(['access-x', 'access-y'])];
    assert.ok(isMerge(buildSelectQuery(u, { query: both, options: { sort: { time: -1 } } }, true).sql));
    assert.deepStrictEqual(await read(u, both, { sort: { time: -1 } }, false), ['untimed', 'timed-y', 'timed']);
    assert.deepStrictEqual(await read(u, both, { sort: { time: -1 } }, true), ['timed-y', 'timed']);
  });

  // -- Several access ids: an ordered merge of their key ranges --

  const several = (ids, ...others) => ({ type: 'streamsQuery', content: [[{ any: ids }, ...others]] });
  const isMerge = (sql) => sql.includes('DISTINCT ON');

  it('[PGASN] several covered ids: which queries merge, and the exact statement', function () {
    const sqlOf = (query, options = { sort: { time: -1 }, limit: 20 }, complete = true) =>
      buildSelectQuery('u', { query, options }, complete);
    const like = (n) => `(' ' || stream_ids || ' ') LIKE $${n} ESCAPE '\\'`;
    const branch = (n, dir, bound) => 'SELECT time AS s_time, eventid AS s_eventid FROM audit_event_streams WHERE user_id = $1 ' +
      `AND stream_id = $${n}${bound} ORDER BY time ${dir}, eventid ${dir}`;
    for (const [time, dir] of [[-1, 'DESC'], [1, 'ASC']]) {
      const { sql, values } = sqlOf([several(['access-x', 'access-y']), { type: 'lowerOrEqual', content: { field: 'time', value: 50 } }],
        { sort: { time }, limit: 20, skip: 3 });
      assert.strictEqual(sql,
        'SELECT a.* FROM (SELECT DISTINCT ON (u.s_time, u.s_eventid) u.s_time, u.s_eventid FROM ' +
        `((${branch(5, dir, ' AND time <= $7')}) UNION ALL (${branch(6, dir, ' AND time <= $7')})) ` +
        `u ORDER BY u.s_time ${dir}, u.s_eventid ${dir}) k CROSS JOIN LATERAL (SELECT * FROM audit_events WHERE user_id = $1 ` +
        `AND (((${like(2)} OR ${like(3)}))) AND time <= $4 AND eventid = k.s_eventid AND time = k.s_time OFFSET 0) a ` +
        `ORDER BY k.s_time ${dir}, k.s_eventid ${dir} LIMIT 20 OFFSET 3`, dir);
      assert.deepStrictEqual(values, ['u', '% access-x %', '% access-y %', 50, 'access-x', 'access-y', 50]);
    }
    // Three ids: a balanced tree; 500: its nesting stays shallow.
    assert.ok(sqlOf([several(['access-x', 'access-y', 'access-z'])]).sql.includes(
      `FROM (((${branch(5, 'DESC', '')}) UNION ALL (${branch(6, 'DESC', '')})) UNION ALL (${branch(7, 'DESC', '')})) u `));
    // The cap moves only by a deliberate edit (planning cost, see its comment).
    assert.strictEqual(MULTI_MAX_IDS, 500);
    const many = Array.from({ length: MULTI_MAX_IDS }, (_, i) => 'access-m' + i);
    const big = sqlOf([several(many)]);
    assert.ok(isMerge(big.sql));
    assert.strictEqual(big.values.length, 1 + 2 * MULTI_MAX_IDS);
    let depth = 0;
    let deepest = 0;
    for (const c of big.sql) { if (c === '(') deepest = Math.max(deepest, ++depth); else if (c === ')') depth--; }
    assert.ok(deepest < 20, 'nesting ' + deepest);
    // Every branch is bounded by the account.
    assert.strictEqual(big.sql.split('FROM audit_event_streams WHERE user_id = $1 AND stream_id = $').length - 1, MULTI_MAX_IDS);

    // Which list is chosen.
    const terms = (...entries) => streamIndexTerms({ query: [{ type: 'streamsQuery', content: [entries] }], options: { sort: { time: -1 } } });
    assert.deepStrictEqual(terms({ any: ['access-x', 'access-y'] }), ['access-x', 'access-y']);
    assert.deepStrictEqual(terms({ any: ['access-a', 'access-b', 'access-c'] }, { any: ['access-d', 'access-e'] }), ['access-d', 'access-e']);
    assert.deepStrictEqual(terms({ any: ['access-a', 'access-b'] }, 'access-z'), ['access-z'], 'one id wins');
    assert.deepStrictEqual(terms({ any: ['access-a', 'access-a', 'access-b'] }), ['access-a', 'access-b']);
    assert.deepStrictEqual(terms({ any: ['access-a', 'access-b'] }, { not: ['access-c'] }), ['access-a', 'access-b']);
    assert.strictEqual(terms({ any: ['access-a', 'access-a'] }), null);
    assert.strictEqual(terms({ any: many }).length, MULTI_MAX_IDS);
    // The one-id statement is unchanged ([PGAS8] pins its text).
    assert.ok(!isMerge(sqlOf([one('access-x')]).sql) && sqlOf([one('access-x')]).sql.includes('audit_event_streams'));

    const usesTable = (sql) => sql.includes('audit_event_streams');
    for (const [name, query, options] of [
      ['an uncovered id', [several(['access-x', 'action-y'])]],
      ['a parent id', [several(['accesses', 'access-x', 'access-y'])]],
      ['star', [several(['access-x', '*'])]],
      ['a space', [several(['access-x', 'access-y action-z'])]],
      ['types', [several(['access-x', 'access-y']), { type: 'typesList', content: ['audit-log/pryv-api-error'] }]],
      ['too many', [several([...many, 'access-one-more'])]],
      ['two blocks', [{ type: 'streamsQuery', content: [[{ any: ['access-x', 'access-y'] }], [{ any: ['access-z', 'access-w'] }]] }]],
      ['deny', [several(['access-x', 'access-y'], { unknown: true })]],
      ['deny, one id', [several(['access-x'], { unknown: true })]],
      ['no sort', [several(['access-x', 'access-y'])], { limit: 20 }],
      ['time or null', [several(['access-x', 'access-y']), { type: 'greaterOrEqualOrNull', content: { field: 'time', value: 1 } }]]
    ]) {
      const { sql } = sqlOf(query, options);
      assert.ok(!usesTable(sql), name + ': ' + sql.slice(0, 120));
    }
    assert.ok(!usesTable(sqlOf([several(['access-x', 'access-y'])], undefined, false).sql), 'incomplete');
    // A deny reads nothing: the plain statement with FALSE.
    assert.match(sqlOf([several(['access-x', 'access-y'], { unknown: true })]).sql, /^SELECT \* FROM audit_events WHERE user_id = \$1 AND FALSE ORDER BY/);
  });

  it('[PGASO] the merged read returns the same rows in the same order as the plain one', async function () {
    const u = newUser();
    await seedEquivalence(u);
    // `q0000` and every 6th record name both access-a and access-b.
    const lists = {
      two: ['access-a', 'access-b'],
      three: ['access-a:1', 'access-b', 'access-a'],
      nine: ['access-a', 'access-b', 'access-a:1', 'access-p%q_r', 'access-pxqyr', 'access-none1', 'access-none2', 'access-none3', 'access-none4'],
      none: ['access-none1', 'access-none2'],
      rare: ['access-p%q_r', 'access-none1']
    };
    const shapes = [];
    for (const [key, ids] of Object.entries(lists)) {
      shapes.push([key, [...BASE(), several(ids)]]);
      shapes.push([key + ' not', [...BASE(), several(ids, { not: ['access-a:1'] })]]);
      shapes.push([key + ' and access-b', [...BASE(), several(ids, { any: ['access-b', 'access-pxqyr'] })]]);
      shapes.push([key + ' time', [...BASE(), several(ids), { type: 'lowerOrEqual', content: { field: 'time', value: 10_030 } },
        { type: 'greaterOrEqual', content: { field: 'time', value: 10_005 } }]]);
      shapes.push([key + ' greater', [...BASE(), several(ids), { type: 'greater', content: { field: 'time', value: 10_020 } }]]);
      shapes.push([key + ' equal', [...BASE(), several(ids), { type: 'equal', content: { field: 'time', value: 10_010 } }]]);
      shapes.push([key + ' all states', [several(ids)]]);
    }
    let compared = 0;
    for (const [name, query] of shapes) {
      for (const time of [-1, 1]) {
        // Not vacuous: these shapes take the merge.
        assert.ok(isMerge(buildSelectQuery(u, { query: structuredClone(query), options: { sort: { time } } }, true).sql), name);
        for (const limit of [1, 3, 20, undefined]) {
          for (const skip of [0, 1, 5, 500]) {
            const options = { sort: { time }, limit, skip };
            const plain = await read(u, query, options, false);
            const indexed = await read(u, query, options, true);
            assert.deepStrictEqual(indexed, plain, `${name} ${JSON.stringify(options)}`);
            compared++;
          }
        }
      }
      const streamed = await readStreamed(u, query, { sort: { time: -1 }, limit: 7, skip: 2 }, true);
      assert.deepStrictEqual(streamed, await readStreamed(u, query, { sort: { time: -1 }, limit: 7, skip: 2 }, false), name + ' streamed');
      const whole = await readStreamed(u, query, { sort: { time: 1 } }, true);
      assert.deepStrictEqual(whole, await readStreamed(u, query, { sort: { time: 1 } }, false), name + ' streamed, no limit');
    }
    assert.ok(compared > 1000, 'compared ' + compared);
    const all = await read(u, [...BASE(), several(lists.two)], { sort: { time: -1 } }, true);
    assert.ok(all.length > 80 && new Set(all).size === all.length, 'rows: ' + all.length);
    assert.ok(all.includes('q0006'), 'a record of both ids is returned');
  });

  it('[PGASP] the merged read is an ordered merge of the key ranges, without a sort', async function () {
    // 2 dense ids among 50, the other 48 without any record: a sort of every
    // key of the dense ids is what a wrong plan does here. The plan follows
    // the statistics: on a table this account fills (a few thousand rows) or
    // whose visibility map is not set yet (never vacuumed), the planner sorts
    // the dense ranges instead, which it costs as cheaper for a full read
    // (it plans the DISTINCT ON subquery without the outer limit). So the
    // account sits among other accounts' rows, vacuumed, as a running core's
    // table is once autovacuum has passed.
    const dense = ['access-d1', 'access-d2'];
    const ids = [...dense, ...Array.from({ length: 48 }, (_, i) => 'access-e' + i)];
    const seed = async (client, u, others) => {
      await client.query(`INSERT INTO audit_events (user_id, eventid, stream_ids, type, time, created, modified)
        SELECT $1, 'p' || i, CASE WHEN i % 3 = 0 THEN 'access-d1 access-d2' WHEN i % 3 = 1 THEN 'access-d1' ELSE 'access-z' END || ' action-y ..',
          'audit-log/pryv-api', i / 10, i, i FROM generate_series(1, 6000) AS i`, [u]);
      // Rows of other accounts, in the table only (what the plan reads).
      await client.query(`INSERT INTO audit_event_streams (user_id, stream_id, time, eventid)
        SELECT $1 || (i % 100), 'access-o' || (i % 7), i / 10, 'o' || i FROM generate_series(1, 200000) AS i`, [others]);
      await client.query('VACUUM ANALYZE audit_events');
      await client.query('VACUUM ANALYZE audit_event_streams');
    };
    const check = async (client, u, label) => {
      for (const [time, direction] of [[-1, 'Backward'], [1, 'Forward']]) {
        const { sql, values } = buildSelectQuery(u, {
          query: [...BASE(), several(ids), { type: 'equal', content: { field: 'deleted', value: null } }, { type: 'equal', content: { field: 'head_id', value: null } }],
          options: { sort: { time }, limit: 20 }
        }, true);
        const root = (await client.query('EXPLAIN (FORMAT JSON) ' + sql, values)).rows[0]['QUERY PLAN'][0].Plan;
        const text = label + ' ' + direction + ': ' + JSON.stringify(root);
        const nodes = [];
        (function walk (n) { nodes.push(n); for (const c of n.Plans ?? []) walk(c); })(root);
        assert.ok(!nodes.some((n) => /Sort/.test(n['Node Type'])), 'no sort: ' + text);
        assert.ok(nodes.some((n) => n['Node Type'] === 'Unique'), 'a unique: ' + text);
        const merges = nodes.filter((n) => n['Node Type'] === 'Merge Append');
        assert.strictEqual(merges.length, 1, 'one merge append: ' + text);
        assert.strictEqual(merges[0].Plans.length, ids.length, 'one child per id: ' + text);
        for (const child of merges[0].Plans) {
          assert.ok(/Index (Only )?Scan/.test(child['Node Type']) && child['Index Name'] === 'audit_event_streams_pkey' &&
            child['Scan Direction'] === direction, 'each child reads the key ' + direction + ': ' + text);
        }
      }
    };
    // On the shared test tables (the other accounts' rows are this test's,
    // removed with it).
    const u = newUser();
    await seed(db, u, newUser());
    await check(db, u, 'shared');
    // On fresh tables holding only these rows.
    const client = await db.getClient();
    const schema = 'pgasp_' + Math.random().toString(36).slice(2, 8);
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${schema}.audit_events (LIKE public.audit_events INCLUDING ALL)`);
      await client.query(`CREATE TABLE ${schema}.audit_event_streams (LIKE public.audit_event_streams INCLUDING ALL)`);
      await client.query(`SET search_path TO ${schema}`);
      // No trigger on these copies: the account's rows are written here.
      await client.query(`INSERT INTO audit_event_streams (user_id, stream_id, time, eventid)
        SELECT 'fresh', t, i / 10, 'p' || i FROM generate_series(1, 6000) AS i,
          unnest(CASE WHEN i % 3 = 0 THEN ARRAY['access-d1', 'access-d2'] WHEN i % 3 = 1 THEN ARRAY['access-d1'] ELSE ARRAY[]::text[] END) AS t`);
      await seed(client, 'fresh', 'other');
      await check(client, 'fresh', 'fresh');
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });

  it('[PGASQ] with several ids, a forged or stale row never returns a refused record, and a record of two ids comes once', async function () {
    const u = newUser();
    const v = newUser();
    await put(u, 'mine', ['access-x', 'action-y'], 100);
    await put(u, 'both', ['access-x', 'access-y', 'action-y'], 103);
    await put(u, 'theirs', ['access-other', 'action-y'], 101);
    await put(v, 'foreign', ['access-y', 'action-y'], 102);
    // Under access-y: a row pointing at a record of u that names neither id,
    // one at a record id only v has, and a stale copy of `mine` at another time.
    await db.query('INSERT INTO audit_event_streams (user_id, stream_id, time, eventid) VALUES ($1, $2, 101, $3), ($1, $2, 102, $4), ($1, $2, 99, $5)',
      [u, 'access-y', 'theirs', 'foreign', 'mine']);
    for (const [time, expected] of [[-1, ['both', 'mine']], [1, ['mine', 'both']]]) {
      for (const ids of [['access-x', 'access-y'], ['access-y', 'access-x', 'access-none']]) {
        const query = [...BASE(), several(ids)];
        assert.deepStrictEqual(await read(u, query, { sort: { time } }, true), expected, JSON.stringify(ids));
        assert.deepStrictEqual(await readStreamed(u, query, { sort: { time } }, true), expected);
        assert.deepStrictEqual(await read(u, query, { sort: { time }, limit: 1, skip: 1 }, true), expected.slice(1));
      }
    }
  });
});
