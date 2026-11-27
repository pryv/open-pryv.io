/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
/* global assert */

const setUserBasePathTestOnly = require('../../../test/helpers').userLocalDirectory.setBasePathTestOnly;

const path = require('path');
const { copy, pathExists } = require('fs-extra');
const cuid = require('cuid');
const migrate0to1 = require('storages/engines/sqlite/src/userSQLite/migrations/1.ts').migrateUserDB;
const { UserDatabase } = require('storages/engines/sqlite/src/userSQLite/UserDatabase.ts');
const os = require('os');
const { getLogger } = require('../../../test/helpers');
const { SqliteStorage: Storage } = require('storages/engines/sqlite/src/userSQLite/Storage.ts');

describe('[SQLM] SQLite user-centric storage migration', () => {
  let logger;
  before(async () => {
    logger = getLogger('sqlite-storage-migration-test');
  });

  after(() => {
    // reset userDirectory base path to original
    setUserBasePathTestOnly();
  });

  it('[MFFR] a single Migrate v0 to v1', async function () {
    const userid = cuid();
    const srcPath = path.join(__dirname, './support/migration/audit-v0.sqlite');
    const v0dbPath = path.join(os.tmpdir(), userid + '-v0.sqlite');
    const v1dbPath = path.join(os.tmpdir(), userid + '-v1.sqlite');
    await copy(srcPath, v0dbPath);

    const v1user = new UserDatabase(logger, { dbPath: v1dbPath });
    await v1user.init();

    const resMigrate = await migrate0to1(v0dbPath, v1user, logger);
    assert.strictEqual(resMigrate.count, 298);
  });

  it('[RXVF] check userDir and perform migration when needed', async function () {
    // migrates a 32 MB fixture: 20 to 30 s on a loaded machine
    this.timeout(90000);
    const srcDir = path.join(__dirname, './support/migration-userDirV0');
    const tempUserDir = path.join(os.tmpdir(), 'pryv.io-test-userdir-' + Math.random().toString(36).substring(2, 8));
    await copy(srcDir, tempUserDir);
    assert.strictEqual(await pathExists(path.join(tempUserDir, 'audit-db-version-1.0.0.txt')), false);
    setUserBasePathTestOnly(tempUserDir);
    const storage = new Storage('audit');
    await storage.init();
    assert.strictEqual(await pathExists(path.join(tempUserDir, 'audit-db-version-1.0.0.txt')), true);
    storage.close();
  });

  it('[SMNW1] the shared files of the users base directory raise no warning; an odd entry inside the user tree still does', async function () {
    const fs = require('node:fs');
    const { foreachUserDirectory } = require('storages/engines/sqlite/src/userSQLite/migrations/index.ts');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv.io-test-smnw-'));
    try {
      // what a fresh users directory holds before any migration
      fs.writeFileSync(path.join(base, 'user-index.db'), '');
      fs.writeFileSync(path.join(base, 'user-index.db-wal'), '');
      fs.writeFileSync(path.join(base, 'accesses-token-protected.done'), '');
      fs.mkdirSync(path.join(base, '_shared'));
      // one user directory: levels a / b / c, the id ends with 'cba'
      fs.mkdirSync(path.join(base, 'a', 'b', 'c', 'u1cba'), { recursive: true });
      const warnings = [];
      const fakeLogger = { warn: (m) => warnings.push(m), debug: () => {}, info: () => {}, error: (m) => warnings.push(m) };
      const visited = [];
      await foreachUserDirectory(async (uid) => { visited.push(uid); }, base, fakeLogger);
      assert.deepStrictEqual(visited, ['u1cba']);
      assert.deepStrictEqual(warnings, []);
      // inside the tree, an entry that does not belong is still reported
      fs.mkdirSync(path.join(base, 'a', 'zz'));
      await foreachUserDirectory(async () => {}, base, fakeLogger);
      assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
      assert.match(warnings[0], /zz/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
