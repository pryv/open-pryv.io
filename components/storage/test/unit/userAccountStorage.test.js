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
