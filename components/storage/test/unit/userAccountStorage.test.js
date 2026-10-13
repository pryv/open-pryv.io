/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cuid = require('cuid');
const { userLocalDirectory, getUserAccountStorage } = require('storage');
const conformanceTests = require('storages/interfaces/baseStorage/conformance/UserAccountStorage.test.js').default;

describe('[UAST] Users Account Storage', () => {
  conformanceTests(
    async () => {
      await userLocalDirectory.init();
      return await getUserAccountStorage();
    },
    async (userId) => {
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  );
});

/**
 * The SQLite account file is shared by every process serving the account:
 * a write must wait for another connection's lock, not fail (nor block the
 * event loop in a busy wait).
 */
describe('[UASB] SQLite account storage writes while another connection holds the lock', function () {
  const userId = cuid();
  let storage, other, release;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'sqlite') this.skip();
    await userLocalDirectory.init();
    storage = await getUserAccountStorage();
    await storage.addPasswordHash(userId, 'hash-0', 'test', 1);
    const SQLite3 = require('better-sqlite3');
    const accountFile = path.join(userLocalDirectory.getPathForUser(userId), 'account-1.0.0.sqlite');
    assert.ok(fs.existsSync(accountFile), `expected the account file at ${accountFile}`);
    other = new SQLite3(accountFile);
  });

  afterEach(function () {
    clearTimeout(release);
    if (other?.inTransaction) other.exec('ROLLBACK');
  });

  after(async function () {
    other?.close();
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  function holdLockFor (ms) {
    other.exec('BEGIN IMMEDIATE');
    release = setTimeout(() => other.exec('COMMIT'), ms);
  }

  it('[UASB1] a password, an account field and a key-value write wait for the lock', async function () {
    holdLockFor(100);
    await storage.addPasswordHash(userId, 'hash-1', 'test', 2);
    holdLockFor(100);
    await storage.setAccountField(userId, 'email', 'a@example.com', 'test');
    holdLockFor(100);
    await storage.getKeyValueDataForStore('s1').set(userId, 'k', 'v');
    assert.strictEqual(await storage.getPasswordHash(userId), 'hash-1');
    assert.strictEqual(await storage.getAccountField(userId, 'email'), 'a@example.com');
    assert.strictEqual(await storage.getKeyValueDataForStore('s1').get(userId, 'k'), 'v');
  });

  it('[UASB2] the event loop keeps running while a write waits', async function () {
    holdLockFor(300);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    await storage.setAccountField(userId, 'language', 'fr', 'test');
    clearInterval(timer);
    assert.ok(ticks >= 5, `event loop blocked during the wait (${ticks} ticks)`);
  });
});

/**
 * The account file is also opened by other processes (the backup / restore
 * tool, the other workers). When one of them deletes or replaces it while
 * this process holds it open, this process must read and write the file now
 * on disk, not the unlinked one its cached connection still serves.
 */
describe('[UASF] SQLite account storage follows its file on disk', function () {
  const SQLite3 = require('better-sqlite3');
  let storage;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'sqlite') this.skip();
    await userLocalDirectory.init();
    storage = await getUserAccountStorage();
  });

  function accountFileOf (userId) {
    return path.join(userLocalDirectory.getPathForUser(userId), 'account-1.0.0.sqlite');
  }

  // As another process would: the file and its WAL go, the open connection here stays.
  function removeFromOutside (userId) {
    const file = accountFileOf(userId);
    for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
  }

  it('[UASF1] an account file deleted by another process is not read through the cached connection', async function () {
    const userId = cuid();
    try {
      await storage.setAccountField(userId, 'email', 'before@example.com', 'test');
      assert.strictEqual(await storage.getAccountField(userId, 'email'), 'before@example.com');

      removeFromOutside(userId);

      assert.strictEqual(await storage.getAccountField(userId, 'email'), null, 'the deleted account must not be readable');
      await storage.setAccountField(userId, 'email', 'after@example.com', 'test');
      const onDisk = new SQLite3(accountFileOf(userId), { readonly: true });
      try {
        const rows = onDisk.prepare('SELECT value FROM account_fields WHERE field = ?').all('email');
        assert.deepStrictEqual(rows, [{ value: JSON.stringify('after@example.com') }], 'the write after the deletion must land in the file on disk');
      } finally {
        onDisk.close();
      }
    } finally {
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });

  it('[UASF2] an account file replaced by another process is read from the new file', async function () {
    const userId = cuid();
    try {
      await storage.setAccountField(userId, 'email', 'old@example.com', 'test');
      await storage.addPasswordHash(userId, 'hash-old', 'test', 1);
      assert.strictEqual(await storage.getAccountField(userId, 'email'), 'old@example.com');

      removeFromOutside(userId);
      const restorer = new SQLite3(accountFileOf(userId));
      try {
        restorer.exec('CREATE TABLE passwords (time REAL PRIMARY KEY, hash TEXT NOT NULL, createdBy TEXT NOT NULL);' +
          'CREATE TABLE storeKeyValueData (storeId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (storeId, key));' +
          'CREATE TABLE account_fields (field TEXT NOT NULL, value TEXT, time REAL NOT NULL, createdBy TEXT NOT NULL, PRIMARY KEY (field, time));');
        restorer.prepare('INSERT INTO account_fields (field, value, time, createdBy) VALUES (?, ?, ?, ?)').run('email', JSON.stringify('restored@example.com'), 2, 'restore');
        restorer.prepare('INSERT INTO passwords (time, hash, createdBy) VALUES (?, ?, ?)').run(2, 'hash-restored', 'restore');
      } finally {
        restorer.close();
      }

      assert.strictEqual(await storage.getAccountField(userId, 'email'), 'restored@example.com');
      assert.strictEqual(await storage.getPasswordHash(userId), 'hash-restored');
    } finally {
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });

  it('[UASF3] concurrent first opens of an account file share one connection', async function () {
    const userId = cuid();
    try {
      await Promise.all([
        storage.setAccountField(userId, 'a', 1, 'test'),
        storage.setAccountField(userId, 'b', 2, 'test'),
        storage.getAccountFields(userId)
      ]);
      assert.deepStrictEqual(await storage.getAccountFields(userId), { a: 1, b: 2 });
    } finally {
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });
});
