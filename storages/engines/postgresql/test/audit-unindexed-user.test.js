/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [AGPG] The audit storage, told to, refuses a record of a user id the users
 * index does not hold, and keeps the index entry of the one it writes until
 * the insert commits (an erasure removing the entry waits for it).
 */

import assert from 'node:assert';
import * as helpers from '../../../test/helpers/index.js';
import { DatabasePG } from '../src/DatabasePG.ts';
import { AuditStoragePG } from '../src/AuditStoragePG.ts';
import { UserAuditDatabasePG } from '../src/UserAuditDatabasePG.ts';

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

describe('[AGPG] PostgreSQL audit records of an unindexed user id', function () {
  this.timeout(30_000);
  let db, userId, n;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    await db.initSchema();
  });

  beforeEach(function () {
    userId = 'agpg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    n = 0;
  });

  afterEach(async function () {
    if (db == null) return;
    await db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
  });

  after(async function () { if (db != null) await db.close(); });

  function event () {
    return {
      id: 'agpg-e' + (++n),
      streamIds: [':_audit:access-a', ':_audit:action-x'],
      type: 'audit-log/pryv-api',
      time: 1.5,
      endTime: 2.5,
      created: 1.25,
      createdBy: 'system',
      modified: 1.75,
      modifiedBy: 'system',
      trashed: false,
      content: { action: 'x', source: { name: 'test', ip: null }, query: { a: ['b', 1] } }
    };
  }

  async function storage (seesUsersIndex) {
    const s = new AuditStoragePG(db, undefined, { seesUsersIndex });
    await s.init();
    return s;
  }

  async function index () {
    await db.query('INSERT INTO users_index (username, user_id) VALUES ($1, $1)', [userId]);
  }

  it('[AGPG1] told to: refused with PU001 while the id is not indexed, accepted once it is, also by a handle opened before', async function () {
    const s = await storage(true);
    const user = await s.forUser(userId);
    await user.createEvent(event());
    assert.strictEqual(s.refuseUnindexedUsers(true), true);
    await assert.rejects(user.createEvent(event()), (err) => err.code === 'PU001' && err.table === 'audit_events');
    assert.strictEqual((await user.getEvents({ query: [] })).length, 1);
    await index();
    await user.createEvent(event());
    assert.strictEqual((await user.getEvents({ query: [] })).length, 2);
    assert.strictEqual(s.refuseUnindexedUsers(false), false);
    await db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
    await user.createEvent(event());
  });

  it('[AGPG2] both inserts store the same row', async function () {
    const s = await storage(true);
    const user = await s.forUser(userId);
    await index();
    const one = event();
    const two = { ...one, id: 'agpg-other' };
    await user.createEvent(one);
    s.refuseUnindexedUsers(true);
    await user.createEvent(two);
    const res = await db.query('SELECT * FROM audit_events WHERE user_id = $1 ORDER BY eventid', [userId]);
    assert.strictEqual(res.rows.length, 2);
    const [a, b] = res.rows.map(({ eventid, ...rest }) => rest);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a.content, one.content);
  });

  it('[AGPG3] an index removal waits for a record being written, and the removal of the records after it sees it', async function () {
    await index();
    const writer = await db.getClient();
    const eraser = await db.getClient();
    try {
      await writer.query('BEGIN');
      const user = new UserAuditDatabasePG(writer, userId, { getLogger: () => ({}) }, undefined, { on: true });
      await user.createEvent(event());
      let removed = false;
      const removal = eraser.query('DELETE FROM users_index WHERE user_id = $1', [userId]).then((r) => { removed = true; return r; });
      await sleep(300);
      assert.strictEqual(removed, false, 'the index entry was removed while a record under it was being written');
      await writer.query('COMMIT');
      assert.strictEqual((await removal).rowCount, 1);
      assert.strictEqual((await db.query('DELETE FROM audit_events WHERE user_id = $1', [userId])).rowCount, 1);
      await assert.rejects(new UserAuditDatabasePG(db, userId, { getLogger: () => ({}) }, undefined, { on: true }).createEvent(event()),
        (err) => err.code === 'PU001');
    } finally {
      writer.release();
      eraser.release();
    }
  });

  it('[AGPG4] without effect when the users index is not in this database, and off until told', async function () {
    const elsewhere = await storage(false);
    assert.strictEqual(elsewhere.refuseUnindexedUsers(true), false);
    await (await elsewhere.forUser(userId)).createEvent(event());
    await (await (await storage(true)).forUser(userId)).createEvent(event());
  });
});
