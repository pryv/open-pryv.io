/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The per-user base storage connection has no busy timeout (writes retry
 * SQLITE_BUSY themselves). A write that skips the retry fails with "database
 * is locked" as soon as another connection, e.g. another process serving the
 * same user, holds the write lock for a moment.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SQLite3 = require('better-sqlite3');
const { UserBaseStorageDb } = require('../src/userBaseStorage/UserBaseStorageDb.ts');
const { userStreams } = require('../src/dataStore/localUserStreamsSQLite.ts');

describe('[USBZ] SQLite user streams writes while another connection holds the lock', function () {
  let tmp, udb, other, originalForUser, release;

  beforeEach(async function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usbz-'));
    udb = new UserBaseStorageDb(path.join(tmp, 'baseStorage.sqlite'));
    await udb.init();
    await udb.ensureTable('streams', { withDeleted: true, withHeadId: false });
    originalForUser = UserBaseStorageDb.forUser;
    UserBaseStorageDb.forUser = async () => udb;
    other = new SQLite3(udb.dbPath);
  });

  afterEach(function () {
    clearTimeout(release);
    UserBaseStorageDb.forUser = originalForUser;
    if (other.inTransaction) other.exec('ROLLBACK');
    other.close();
    udb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('[USB1] createDeleted waits for the lock instead of failing', async function () {
    other.exec('BEGIN IMMEDIATE');
    release = setTimeout(() => other.exec('COMMIT'), 100);
    await userStreams.createDeleted('u1', { id: 's1', deleted: 1000 });
    const row = udb.db.prepare('SELECT deleted FROM streams WHERE id = ?').get('s1');
    assert.strictEqual(row.deleted, 1000);
  });

  it('[USB2] createDeleted on an existing row waits for the lock too', async function () {
    await userStreams.createDeleted('u1', { id: 's1', deleted: 1000 });
    other.exec('BEGIN IMMEDIATE');
    release = setTimeout(() => other.exec('COMMIT'), 100);
    await userStreams.createDeleted('u1', { id: 's1', deleted: 2000 });
    const row = udb.db.prepare('SELECT deleted FROM streams WHERE id = ?').get('s1');
    assert.strictEqual(row.deleted, 2000);
  });
});
