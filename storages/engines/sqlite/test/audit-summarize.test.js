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

const helpers = require('../../../test/helpers');
const { SqliteStorage: Storage } = require('../src/userSQLite/Storage.ts');
const { _setSummaryChunkRows, _summaryCounters } = require('../src/userSQLite/UserDatabase.ts');
const { SUMMARY_INTERRUPTED_ERROR_CODE } = require('../../../interfaces/auditStorage/UserAuditDatabase.ts');

// The audit summary walks the `time` index of the range in windows, with or
// without an access filter, and yields to the event loop between windows.
describe('[ASQS] SQLite audit summarize', function () {
  const userLocalDirectory = helpers.userLocalDirectory;
  let storage, userId, userDb;

  before(async function () {
    await helpers.dependencies.init();
    await userLocalDirectory.init();
  });

  beforeEach(async function () {
    storage = new Storage('asqs-' + cuid.slug());
    await storage.init();
    userId = cuid();
    userDb = await storage.forUser(userId);
  });

  afterEach(async function () {
    storage.close();
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  async function insert (db, id, time, streamIds) {
    await db.createEvent({
      id,
      streamIds: streamIds.concat(['action-events.get']),
      type: 'audit-log/pryv-api',
      time,
      content: { action: 'events.get' },
      created: time,
      createdBy: 'test',
      modified: time,
      modifiedBy: 'test'
    });
  }

  const total = (groups) => groups.reduce((sum, g) => sum + g.count, 0);

  it('[ASQ9] the filtered summary does not read the full-text index; its work follows the rows of the range', async function () {
    await insert(userDb, 'in-1', 1000, ['access-q9']);
    await insert(userDb, 'in-2', 1500, ['access-q9', 'access-other']);
    for (let i = 0; i < 30; i++) await insert(userDb, 'out-' + i, 10000 + i, ['access-q9']);
    const params = { fromTime: 1000, toTime: 2000, slotSeconds: 3600, accessStreamIds: ['access-q9'] };

    const previous = _setSummaryChunkRows(3);
    try {
      const windowsBefore = _summaryCounters.windows;
      const groups = await userDb.summarize(params);
      assert.strictEqual(_summaryCounters.windows - windowsBefore, 1, 'one window for the two rows of the range');
      assert.strictEqual(total(groups), 2);

      userDb.db.prepare("INSERT INTO events_fts(events_fts) VALUES('delete-all')").run();
      const listed = await userDb.getEvents({ query: [{ type: 'streamsQuery', content: [[{ any: ['access-q9'] }]] }] });
      assert.strictEqual(listed.length, 0, 'the full-text index is empty');
      assert.deepStrictEqual(await userDb.summarize(params), groups);
      assert.strictEqual(total(await userDb.summarize(Object.assign({}, params, { toTime: 20000 }))), 32);
    } finally {
      _setSummaryChunkRows(previous);
    }
  });

  it('[ASQA] a handle closed while the summary yields gives the interruption error, not a closed-handle TypeError', async function () {
    for (let i = 0; i < 5; i++) await insert(userDb, 'r-' + i, 1000 + i, ['access-qa']);
    const previous = _setSummaryChunkRows(1);
    try {
      for (const accessStreamIds of [undefined, ['access-qa']]) {
        const db = await storage.forUser(userId);
        const pending = db.summarize({ fromTime: 0, toTime: 2000, slotSeconds: 3600, accessStreamIds });
        storage.closeUser(userId);
        assert.strictEqual(db.db.open, false);
        await assert.rejects(pending, (err) => {
          assert.strictEqual(err.code, SUMMARY_INTERRUPTED_ERROR_CODE, String(err));
          assert.ok(!(err instanceof TypeError));
          return true;
        });
      }
      // The next forUser opens the file again and the summary completes.
      assert.strictEqual(total(await (await storage.forUser(userId)).summarize({ fromTime: 0, toTime: 2000, slotSeconds: 3600 })), 5);
    } finally {
      _setSummaryChunkRows(previous);
    }
  });
});
