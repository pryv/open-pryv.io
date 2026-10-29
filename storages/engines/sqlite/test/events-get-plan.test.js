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
  async function run (storeQuery, storeOptions) {
    let sql = null;
    const debug = userDb.logger.debug;
    userDb.logger.debug = (msg) => { if (typeof msg === 'string' && msg.startsWith('GET events streamed: ')) sql = msg.slice(21); };
    let stream;
    try {
      stream = userDb.getEventsStreamed({ query: localStorePrepareQuery(storeQuery), options: localStorePrepareOptions(storeOptions) });
    } finally {
      userDb.logger.debug = debug;
    }
    const rows = [];
    for await (const e of stream) rows.push(e);
    const plan = userDb.db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
    return { rows, plan, sql };
  }

  it('[SQQP1] with no stream filter, walks the time index and stops at the limit (no full sort)', async function () {
    const { rows, plan, sql } = await run({ modifiedSince: 1, fromTime: -1e12, toTime: 1e12 }, { limit: 10 });
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

  it('[SQQP8] stream ids carrying quotes stay inside the match expression', async function () {
    for (const id of ["o'q", 'd"q', "x' OR 1=1 --"]) {
      const { rows } = await run({ streams: [[{ any: [id] }]] }, {});
      assert.deepStrictEqual(rows, [], 'any ' + id);
      const not = await run({ streams: [[{ any: ['a'] }, { not: [id] }]], toTime: 1030 }, {});
      assert.ok(not.rows.length > 0, 'not ' + id);
    }
  });
});
