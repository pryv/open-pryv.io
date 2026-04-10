/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert */

const setUserBasePathTestOnly = require('../../../test/helpers').userLocalDirectory.setBasePathTestOnly;

const path = require('path');
const { copy, pathExists } = require('fs-extra');
const cuid = require('cuid');
const migrate0to1 = require('storages/engines/sqlite/src/userSQLite/migrations/1');
const UserDatabase = require('storages/engines/sqlite/src/userSQLite/UserDatabase');
const os = require('os');
const { getLogger } = require('../../../test/helpers');
const Storage = require('storages/engines/sqlite/src/userSQLite/Storage');

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
    this.timeout(30000);
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
});
