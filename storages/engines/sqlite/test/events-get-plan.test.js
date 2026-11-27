/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const cuid = require('cuid');
const userLocalDirectory = require('../../../test/helpers').userLocalDirectory;
const { SqliteStorage: Storage } = require('storages/engines/sqlite/src/userSQLite/Storage.ts');
const { localStorePrepareOptions, localStorePrepareQuery } = require('storage/src/localStoreEventQueries.ts');
const { _setModifiedProbeCap, _setCandidateProbeCap, _setBoundedWalk } = require('storages/engines/sqlite/src/userSQLite/UserDatabase.ts');

/**
 * `events.get` on a large per-user file (an audit log of several GB) must not
 * scan and sort the whole table before `LIMIT`: better-sqlite3 runs that
 * synchronously and the API worker stops answering for minutes.
 *
 * Reading `events_fts` made every index unusable, and without statistics the
 * planner preferred the `trashed` / `deleted` indexes (conditions nearly every
 * row meets) followed by a temporary sort. Checked here through the query plan
 * of the SQL actually run, plus the rows it returns.
 */
describe('[SQQP] userSQLite events.get query plans', function () {
  this.timeout(20_000);

  let storage;
  let userDb;
  const userId = 'sqqp-' + cuid().slice(0, 8);

  before(async function () {
    await userLocalDirectory.init();
    storage = new Storage('audit-sqqp-' + cuid().slice(0, 8));
    await storage.init();
    userDb = await storage.forUser(userId);
    for (let i = 0; i < 60; i++) {
      await userDb.createEvent({
        id: 'sqqp-' + i,
        streamIds: i % 3 === 0 ? ['a', 'b'] : (i % 3 === 1 ? ['a'] : ['c']),
        type: 'note/txt',
        time: 1000 + i,
        created: 1000 + i,
        createdBy: 'test',
        modified: 1000 + i,
        modifiedBy: 'test',
        trashed: i === 7
      });
    }
    // Audit-shaped terms, older than every row above; `accessory` sorts next
    // to `access-` but must not be listed as an access.
    await userDb.createEvent({
      id: 'sqqp-audit',
      streamIds: ['access-x', 'access-x:1', 'action-y', 'accessory'],
      type: 'audit-log/pryv-api',
      time: 500,
      created: 500,
      createdBy: 'test',
      modified: 500,
      modifiedBy: 'test'
    });
  });

  after(async function () {
    try { await userLocalDirectory.deleteUserDirectory(userId); } catch (_e) { /* best-effort */ }
  });

  // Run a store-level query; return the rows and the plan of the SQL used.
  // `walked`: the SQL of a bounded walk run first (`sql` is then the
  // fallback's, or the walk's own when it answered).
  async function run (storeQuery, storeOptions, db = userDb) {
    let sql = null;
    let walked = null;
    const debug = db.logger.debug;
    db.logger.debug = (msg) => {
      if (typeof msg !== 'string') return;
      if (msg.startsWith('GET events streamed: ')) sql = msg.slice(21);
      if (msg.startsWith('GET events (bounded walk): ')) walked = msg.slice(27);
    };
    const rows = [];
    try {
      const stream = db.getEventsStreamed({ query: localStorePrepareQuery(storeQuery), options: localStorePrepareOptions(storeOptions) });
      for await (const e of stream) rows.push(e);
    } finally {
      db.logger.debug = debug;
    }
    sql ??= walked;
    // Values are bound (`?`): the plan does not depend on them.
    const placeholders = (sql.match(/\?/g) || []).length;
    const plan = db.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...new Array(placeholders).fill(null)).map((r) => r.detail).join(' | ');
    return { rows, plan, sql, walked };
  }

  it('[SQQP1] with no stream filter, walks the time index and stops at the limit (no full sort)', async function () {
    const { rows, plan, sql } = await run({ fromTime: -1e12, toTime: 1e12 }, { limit: 10 });
    assert.ok(!sql.includes('events_fts'), sql);
    assert.match(plan, /USING INDEX events_time/, plan);
    assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
    assert.deepStrictEqual(rows.map((e) => e.id), Array.from({ length: 10 }, (_, k) => 'sqqp-' + (59 - k)));
  });

  it('[SQQP2] `any: [*]` is no stream filter at all', async function () {
    const { rows, plan, sql } = await run({ streams: [[{ any: ['*'] }]], toTime: 1e12 }, { limit: 5 });
    assert.ok(!sql.includes('events_fts'), sql);
    assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
    assert.strictEqual(rows.length, 5);
  });

  it('[SQQP3] with a stream filter, reads the matching rows by rowid and returns them newest first', async function () {
    const { rows, plan } = await run({ streams: [[{ any: ['b'] }]], toTime: 1e12 }, {});
    assert.match(plan, /INTEGER PRIMARY KEY/, plan);
    assert.doesNotMatch(plan, /USING INDEX events_time/, plan);
    const expected = [];
    for (let i = 59; i >= 0; i--) if (i % 3 === 0) expected.push('sqqp-' + i);
    assert.deepStrictEqual(rows.map((e) => e.id), expected);
  });

  it('[SQQP4] keeps `not`, the trashed state and the time bound with a stream filter', async function () {
    const { rows } = await run({ streams: [[{ any: ['a'] }, { not: ['b'] }]], toTime: 1030 }, {});
    const expected = [];
    for (let i = 30; i >= 0; i--) if (i % 3 === 1 && i !== 7) expected.push('sqqp-' + i);
    assert.deepStrictEqual(rows.map((e) => e.id), expected);
    const trashed = await run({ state: 'trashed', streams: [[{ any: ['a'] }]] }, {});
    assert.deepStrictEqual(trashed.rows.map((e) => e.id), ['sqqp-7']);
  });

  it('[SQQP5] keeps skip, ascending order, OR of blocks and types with a stream filter', async function () {
    const page = await run({ streams: [[{ any: ['c'] }]], toTime: 1e12 }, { sortAscending: true, skip: 2, limit: 3 });
    assert.deepStrictEqual(page.rows.map((e) => e.id), ['sqqp-8', 'sqqp-11', 'sqqp-14']);
    const or = await run({ streams: [[{ any: ['b'] }], [{ any: ['c'] }]], toTime: 1059 }, { limit: 4 });
    assert.deepStrictEqual(or.rows.map((e) => e.id), ['sqqp-59', 'sqqp-57', 'sqqp-56', 'sqqp-54']);
    const typed = await run({ streams: [[{ any: ['a'] }]], types: ['other/type'] }, {});
    assert.deepStrictEqual(typed.rows, []);
  });

  it('[SQQP6] lists access and action terms by range exactly as the prefix match did', function () {
    const prefixed = (prefix) => userDb.db.prepare('SELECT term FROM events_fts_v WHERE term LIKE ?').all(prefix + '%').map((r) => r.term);
    assert.deepStrictEqual(userDb.getAllAccesses().map((r) => r.term), prefixed('access-'));
    assert.deepStrictEqual(userDb.getAllActions().map((r) => r.term), prefixed('action-'));
    assert.deepStrictEqual(prefixed('access-'), ['access-x', 'access-x:1']);
  });

  it('[SQQP7] accepts hundreds of excluded streams in one `not` (a large expanded subtree)', async function () {
    const not = ['b'];
    for (let i = 0; i < 600; i++) not.push('sqqp-excluded-' + i);
    const { rows } = await run({ streams: [[{ any: ['a'] }, { not }]], toTime: 1030 }, {});
    const expected = [];
    for (let i = 30; i >= 0; i--) if (i % 3 === 1 && i !== 7) expected.push('sqqp-' + i);
    assert.deepStrictEqual(rows.map((e) => e.id), expected);
    const star = await run({ streams: [[{ any: ['*'] }, { not }]], toTime: 1030 }, {});
    const expectedStar = [];
    for (let i = 30; i >= 0; i--) if (i % 3 !== 0 && i !== 7) expectedStar.push('sqqp-' + i);
    expectedStar.push('sqqp-audit');
    assert.deepStrictEqual(star.rows.map((e) => e.id), expectedStar);
  });

  it('[SQQP9] modifiedSince: few recent rows are read through the modified index, many by walking the time index', async function () {
    const previous = _setModifiedProbeCap(10);
    try {
      // 61 rows modified since 1: over the cap, the time index is walked.
      const many = await run({ modifiedSince: 1, fromTime: -1e12, toTime: 1e12 }, { limit: 10 });
      assert.match(many.sql, /\+modified > \?/, many.sql);
      assert.match(many.plan, /USING INDEX events_time/, many.plan);
      assert.doesNotMatch(many.plan, /TEMP B-TREE/, many.plan);
      assert.deepStrictEqual(many.rows.map((e) => e.id), Array.from({ length: 10 }, (_, k) => 'sqqp-' + (59 - k)));
      // 4 rows modified since 1055: under the cap, the modified index; a cursor
      // below them answers at once instead of walking the time index.
      const few = await run({ modifiedSince: 1055, fromTime: -1e12, toTime: 1e12 }, { limit: 2 });
      assert.match(few.plan, /USING INDEX events_modified/, few.plan);
      assert.deepStrictEqual(few.rows.map((e) => e.id), ['sqqp-59', 'sqqp-58']);
      const below = await run({ modifiedSince: 1055, fromTime: -1e12, toTime: 1030 }, { limit: 2 });
      assert.deepStrictEqual(below.rows, []);
      // Both plans return the same rows.
      for (const since of [1, 1020, 1055, 1059]) {
        for (const toTime of [1e12, 1040]) {
          const q = { modifiedSince: since, fromTime: -1e12, toTime };
          const capped = (await run(q, { limit: 5 })).rows.map((e) => e.id);
          _setModifiedProbeCap(1e9);
          const indexed = (await run(q, { limit: 5 })).rows.map((e) => e.id);
          _setModifiedProbeCap(10);
          assert.deepStrictEqual(capped, indexed, JSON.stringify(q));
        }
      }
    } finally {
      _setModifiedProbeCap(previous);
    }
  });

  it('[SQQPA] a small page of a filter most rows meet walks the time index; the same rows as the rowid set', async function () {
    const previous = _setCandidateProbeCap(20);
    try {
      // 40 of the 61 rows hold `a`: at the cap (20), a page of 3 (3 x 61 rows <= 20 x 20) walks the time index.
      const walk = await run({ streams: [[{ any: ['a'] }]], toTime: 1e12 }, { limit: 3 });
      assert.ok(!walk.sql.includes('events_fts') && !walk.sql.includes('NOT INDEXED'), walk.sql);
      assert.match(walk.plan, /USING INDEX events_time/, walk.plan);
      assert.doesNotMatch(walk.plan, /TEMP B-TREE/, walk.plan);
      // A page whose walk would read more rows than the cap keeps the rowid set.
      const large = await run({ streams: [[{ any: ['a'] }]], toTime: 1e12 }, { limit: 50 });
      assert.match(large.sql, /NOT INDEXED/, large.sql);
      // A filter under the cap keeps the rowid set.
      const few = await run({ streams: [[{ any: ['sqqp-none'] }]], toTime: 1e12 }, { limit: 3 });
      assert.match(few.sql, /NOT INDEXED/, few.sql);
      // Both plans return the same rows (order, skip, `not`, OR of blocks, trashed).
      const cases = [
        [{ streams: [[{ any: ['a'] }]], toTime: 1e12 }, { limit: 3 }],
        [{ streams: [[{ any: ['a'] }]], toTime: 1e12 }, { limit: 2, skip: 3, sortAscending: true }],
        [{ streams: [[{ any: ['a'] }, { not: ['b'] }]], toTime: 1030 }, { limit: 4 }],
        [{ streams: [[{ any: ['b'] }], [{ any: ['c'] }]], toTime: 1059 }, { limit: 4 }],
        [{ state: 'trashed', streams: [[{ any: ['a'] }]] }, { limit: 2 }]
      ];
      for (const [q, o] of cases) {
        const walked = await run(q, o);
        assert.ok(!walked.sql.includes('NOT INDEXED'), 'walked ' + JSON.stringify([q, o]));
        _setCandidateProbeCap(1e9);
        const bounded = _setBoundedWalk(false);
        const set = await run(q, o);
        _setBoundedWalk(bounded);
        _setCandidateProbeCap(20);
        assert.match(set.sql, /NOT INDEXED/, set.sql);
        assert.deepStrictEqual(walked.rows.map((e) => e.id), set.rows.map((e) => e.id), JSON.stringify([q, o]));
        assert.ok(set.rows.length > 0, JSON.stringify([q, o]));
      }
    } finally {
      _setCandidateProbeCap(previous);
    }
  });

  it('[SQQPB] newest first under the cap: a walk over the newest rows, the rowid set when it falls short; the same rows', async function () {
    // 400 rows: `old` holds the even rows of the oldest half, `recent` the even
    // rows of the newest half (one trashed), `bulk` the odd rows.
    const userId2 = userId + '-b';
    const db = await storage.forUser(userId2);
    try {
      for (let i = 0; i < 400; i++) {
        db.createEventSync({
          id: 'sqqpb-' + i,
          streamIds: [i % 2 === 1 ? 'bulk' : (i < 200 ? 'old' : 'recent')],
          type: 'note/txt',
          time: 2000 + i,
          created: 2000 + i,
          createdBy: 'test',
          modified: 2000 + i,
          modifiedBy: 'test',
          trashed: i === 398
        });
      }
      const ids = (from, step, n) => Array.from({ length: n }, (_, k) => 'sqqpb-' + (from - k * step));
      // Recent matches: the walk over the newest rows fills the page.
      const recent = await run({ streams: [[{ any: ['recent'] }]] }, { limit: 5 }, db);
      assert.ok(recent.walked != null && recent.sql === recent.walked, recent.sql);
      assert.match(recent.sql, /time >= \?/, recent.sql);
      assert.ok(!recent.sql.includes('NOT INDEXED') && !recent.sql.includes('events_fts'), recent.sql);
      assert.match(recent.plan, /USING INDEX events_time/, recent.plan);
      assert.doesNotMatch(recent.plan, /TEMP B-TREE/, recent.plan);
      assert.deepStrictEqual(recent.rows.map((e) => e.id), ids(396, 2, 5));
      // Old matches only: the bounded walk finds none, the rowid set answers.
      const old = await run({ streams: [[{ any: ['old'] }]] }, { limit: 5 }, db);
      assert.ok(old.walked != null, 'bounded walk tried first');
      assert.match(old.sql, /NOT INDEXED/, old.sql);
      assert.deepStrictEqual(old.rows.map((e) => e.id), ids(198, 2, 5));
      // A type condition does not move the walk to the `type` index.
      const typed = await run({ streams: [[{ any: ['recent'] }]], types: ['note/txt'] }, { limit: 5 }, db);
      assert.ok(typed.walked != null && typed.sql === typed.walked, typed.sql);
      assert.match(typed.plan, /USING INDEX events_time/, typed.plan);
      assert.doesNotMatch(typed.plan, /TEMP B-TREE/, typed.plan);
      // Ascending order keeps the rowid set.
      const asc = await run({ streams: [[{ any: ['recent'] }]] }, { limit: 5, sortAscending: true }, db);
      assert.strictEqual(asc.walked, null);
      assert.match(asc.sql, /NOT INDEXED/, asc.sql);
      // Same rows as the rowid set: skip, toTime, `not`, OR of blocks, trashed,
      // and through `getEvents` too.
      const cases = [
        [{ streams: [[{ any: ['recent'] }]] }, { limit: 12 }],
        [{ streams: [[{ any: ['recent'] }]], types: ['note/txt'] }, { limit: 5 }],
        [{ streams: [[{ any: ['recent'] }]], modifiedSince: 2390 }, { limit: 2 }],
        [{ streams: [[{ any: ['recent'] }]] }, { limit: 5, skip: 3 }],
        [{ streams: [[{ any: ['recent'] }]], toTime: 2300 }, { limit: 5 }],
        [{ streams: [[{ any: ['old'] }]], toTime: 2300 }, { limit: 5 }],
        [{ streams: [[{ any: ['bulk'] }, { not: ['recent'] }]] }, { limit: 7 }],
        [{ streams: [[{ any: ['old'] }], [{ any: ['recent'] }]] }, { limit: 6 }],
        [{ state: 'all', streams: [[{ any: ['recent'] }]] }, { limit: 3 }],
        [{ streams: [[{ any: ['recent'] }]] }, { limit: 0 }]
      ];
      for (const [q, o] of cases) {
        const walked = await run(q, o, db);
        const list = db.getEvents({ query: localStorePrepareQuery(q), options: localStorePrepareOptions(o) });
        const bounded = _setBoundedWalk(false);
        const set = await run(q, o, db);
        _setBoundedWalk(bounded);
        assert.strictEqual(set.walked, null);
        assert.match(set.sql, /NOT INDEXED/, set.sql);
        assert.deepStrictEqual(walked.rows.map((e) => e.id), set.rows.map((e) => e.id), JSON.stringify([q, o]));
        assert.deepStrictEqual(list.map((e) => e.id), set.rows.map((e) => e.id), 'getEvents ' + JSON.stringify([q, o]));
        assert.ok(set.rows.length > 0 || o.limit === 0, JSON.stringify([q, o]));
      }
    } finally {
      storage.closeUser(userId2);
      try { await userLocalDirectory.deleteUserDirectory(userId2); } catch (_e) { /* best-effort */ }
    }
  });

  it('[SQQP8] stream ids carrying quotes stay inside the match expression', async function () {
    for (const id of ["o'q", 'd"q', "x' OR 1=1 --"]) {
      const { rows } = await run({ streams: [[{ any: [id] }]] }, {});
      assert.deepStrictEqual(rows, [], 'any ' + id);
      const not = await run({ streams: [[{ any: ['a'] }, { not: [id] }]], toTime: 1030 }, {});
      assert.ok(not.rows.length > 0, 'not ' + id);
    }
  });

  // Last: it deletes the audit-shaped row.
  it('[SQQP10] access and action terms are kept on insert in stored case, filled for an existing file, and dropped once their rows are gone', async function () {
    const terms = () => ({ accesses: userDb.getAllAccesses().map((r) => r.term), actions: userDb.getAllActions().map((r) => r.term) });
    const add = (id, streamIds) => userDb.createEvent({ id, streamIds, type: 'audit-log/pryv-api', time: 501, created: 501, createdBy: 'test', modified: 501, modifiedBy: 'test' });
    await add('sqqp-audit-2', ['access-Z', 'action-events.get', 'action-callBatch']);
    // Neither is an access id: `Access-Up` does not start with `access-`, and
    // `foo/access-odd` only holds the full-text token `access-odd`.
    await add('sqqp-odd', ['Access-Up', 'foo/access-odd']);
    const expected = { accesses: ['access-Z', 'access-x', 'access-x:1'], actions: ['action-callBatch', 'action-events.get', 'action-y'] };
    assert.deepStrictEqual(terms(), expected, 'on insert');
    // (i) The table missing: refilled in stored case from the rows.
    userDb.db.exec('DROP TABLE events_stream_terms');
    await userDb.init();
    assert.deepStrictEqual(terms(), expected, 'refilled');
    // (ii) A file from an earlier release: its lower-cased `events_terms` is
    // dropped and the table rebuilt, even next to a stale one.
    userDb.db.exec("DELETE FROM events_stream_terms; INSERT INTO events_stream_terms (term) VALUES ('access-stale')");
    userDb.db.exec("CREATE TABLE events_terms (term TEXT PRIMARY KEY) WITHOUT ROWID; INSERT INTO events_terms (term) VALUES ('access-z'), ('action-callbatch')");
    await userDb.init();
    assert.deepStrictEqual(terms(), expected, 'rebuilt from an earlier release');
    assert.strictEqual(userDb.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'events_terms'").get(), undefined);
    // (iii) After a delete, the terms with no row left are gone.
    await userDb.deleteEvents({ query: [{ type: 'equal', content: { field: 'id', value: 'sqqp-audit' } }] });
    assert.deepStrictEqual(terms(), { accesses: ['access-Z'], actions: ['action-callBatch', 'action-events.get'] });
  });
});
