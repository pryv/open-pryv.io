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

// A restore imports raw rows. An account's events are imported strictly (an
// id already stored fails the import, so the restore of the account fails and
// is cleaned up); its audit trail skips the ids already stored, keeping the
// stored rows (a trail kept after an erasure).
describe('[SQIM] userSQLite importAllEvents onto an id already stored', () => {
  const userIds = [];

  function makeEvent (id, description) {
    return { id, streamIds: ['s1'], type: 'note/txt', time: 1, created: 1, createdBy: 't', modified: 1, modifiedBy: 't', description };
  }

  async function openWith (options) {
    await userLocalDirectory.init();
    const storage = new Storage('sqim-' + cuid().slice(0, 8), options);
    await storage.init();
    const userId = cuid();
    userIds.push(userId);
    const userDb = await storage.forUser(userId);
    await userDb.createEvent(makeEvent('sqim-stored', 'stored'));
    return userDb;
  }

  after(async () => {
    for (const userId of userIds) await userLocalDirectory.deleteUserDirectory(userId);
  });

  it('[SQIM1] the events import throws on an id already stored, and keeps the stored row', async () => {
    const userDb = await openWith({ userEvents: true });
    const [stored] = userDb.exportAllEvents();
    await assert.rejects(
      () => userDb.importAllEvents([Object.assign({}, stored, { description: 'imported' })]),
      /UNIQUE/);
    const rows = userDb.exportAllEvents();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].description, 'stored');
  });

  it('[SQIM2] the audit import skips an id already stored and imports the others', async () => {
    const userDb = await openWith({});
    const [stored] = userDb.exportAllEvents();
    await userDb.importAllEvents([
      Object.assign({}, stored, { description: 'imported' }),
      Object.assign({}, stored, { eventid: 'sqim-new', description: 'new' })
    ]);
    const rows = userDb.exportAllEvents();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.find((r) => r.eventid === stored.eventid).description, 'stored');
  });
});
