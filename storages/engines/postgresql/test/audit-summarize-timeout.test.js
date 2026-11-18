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
const { SUMMARY_BUDGET_ERROR_CODE } = require('../../../interfaces/auditStorage/UserAuditDatabase.ts');

describe('[PGSB] PostgreSQL audit summarize: statement timeout', function () {
  let db, storage, userDb, userId;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    const { _internals } = require('../src/_internals.ts');
    if (!_internals.getLogger) _internals.set('getLogger', helpers.getLogger);
    storage = new AuditStoragePG(db);
    await storage.init();
    userId = 'pg-audit-sum-' + cuid();
    userDb = await storage.forUser(userId);
    await userDb.createEvent({
      id: 'pgsb-1',
      streamIds: ['access-a'],
      type: 'audit-log/pryv-api',
      time: 36000,
      content: { action: 'events.get' },
      created: 36000,
      createdBy: 'test',
      modified: 36000,
      modifiedBy: 'test'
    });
  });

  after(async () => {
    if (db) await db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
  });

  /** Makes the summary statement slow (a sleep before it, inside its transaction). */
  function slowSummaryStatement (readDb) {
    return {
      query: readDb.query.bind(readDb),
      withTransaction: (fn) => readDb.withTransaction((client) => fn({
        query: async (text, params) => {
          if (/GROUP BY/.test(text)) await client.query('SELECT pg_sleep(3)');
          return client.query(text, params);
        }
      }))
    };
  }

  it('[PGSB1] a statement running past the deadline is cancelled as the budget error', async () => {
    const readDb = userDb.readDb;
    userDb.readDb = slowSummaryStatement(readDb);
    const started = Date.now();
    try {
      for (const accessStreamIds of [undefined, ['access-a']]) {
        await assert.rejects(
          userDb.summarize({ fromTime: 0, toTime: 100000, slotSeconds: 3600, accessStreamIds, deadline: Date.now() + 300 }),
          (err) => err.code === SUMMARY_BUDGET_ERROR_CODE);
      }
    } finally {
      userDb.readDb = readDb;
    }
    assert.ok(Date.now() - started < 2500, 'cancelled by the timeout, not run to completion');
  });

  it('[PGSD] a wait for a read-pool client counts in the budget: none left, no statement runs', async () => {
    const small = new DatabasePG({ ...helpers.state.config, max: 2 });
    await small.waitForConnection();
    const held = [await small.getClient(), await small.getClient()];
    const statements = [];
    const readDb = userDb.readDb;
    userDb.readDb = {
      query: small.query.bind(small),
      withTransaction: (fn) => small.withTransaction((client) => fn({
        query: (text, params) => { statements.push(text); return client.query(text, params); }
      }))
    };
    try {
      setTimeout(() => { for (const client of held) client.release(); }, 600);
      await assert.rejects(
        userDb.summarize({ fromTime: 0, toTime: 100000, slotSeconds: 3600, deadline: Date.now() + 300 }),
        (err) => err.code === SUMMARY_BUDGET_ERROR_CODE);
      assert.deepStrictEqual(statements, [], 'no statement ran on the client acquired past the deadline');
    } finally {
      userDb.readDb = readDb;
      await small.close();
    }
  });

  it('[PGSB2] the timeout does not outlive the summary on the pooled connections', async () => {
    const before = (await userDb.readDb.query('SHOW statement_timeout')).rows[0].statement_timeout;
    const groups = await userDb.summarize({ fromTime: 0, toTime: 100000, slotSeconds: 3600, deadline: Date.now() + 300 });
    assert.deepStrictEqual(groups, [{ slot: 10, action: 'events.get', error: false, count: 1 }]);
    for (let i = 0; i < 10; i++) {
      const res = await userDb.readDb.query('SHOW statement_timeout');
      assert.strictEqual(res.rows[0].statement_timeout, before);
    }
  });

  it('[PGSB3] on a pool with its own statement limit, the summary\'s limit does not replace it', async () => {
    const { setRequestServingForTests } = require('../src/DatabasePG.ts');
    setRequestServingForTests(true);
    const limited = new DatabasePG({ ...helpers.state.config, statementTimeoutMs: 1500, max: 1 });
    setRequestServingForTests(null);
    await limited.waitForConnection();
    try {
      const limitedStorage = new AuditStoragePG(limited);
      await limitedStorage.init();
      const limitedUserDb = await limitedStorage.forUser(userId);
      const groups = await limitedUserDb.summarize({ fromTime: 0, toTime: 100000, slotSeconds: 3600, deadline: Date.now() + 300 });
      assert.deepStrictEqual(groups, [{ slot: 10, action: 'events.get', error: false, count: 1 }]);
      for (let i = 0; i < 3; i++) {
        const res = await limited.query('SHOW statement_timeout');
        assert.strictEqual(res.rows[0].statement_timeout, '1500ms');
      }
    } finally {
      await limited.close();
    }
  });
});
