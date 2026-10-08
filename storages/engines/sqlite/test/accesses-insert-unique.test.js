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
const { AccessesSQLite } = require('../src/user/AccessesSQLite.ts');
const { UserBaseStorageDb } = require('../src/userBaseStorage/UserBaseStorageDb.ts');

// SQLite has no unique index on the access fields (they live in a JSON
// column): the check runs in code and must be atomic with the insert, or two
// concurrent logins for the same app both pass it and leave two personal
// accesses.
describe('[AIUQ] AccessesSQLite uniqueness under concurrent inserts', function () {
  const userLocalDirectory = helpers.userLocalDirectory;
  let storage, userId;

  before(async function () {
    await helpers.dependencies.init();
    await userLocalDirectory.init();
    storage = new AccessesSQLite({ isActive: false, set: () => {} });
  });

  beforeEach(function () { userId = cuid(); });

  afterEach(async function () {
    UserBaseStorageDb.evict(userId);
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  function insert (item) {
    return new Promise((resolve) => storage.insertOne(userId, item, (err, res) => resolve({ err, res })));
  }

  function countLive () {
    return new Promise((resolve, reject) => storage.find(userId, { deleted: null }, null, (err, res) => err ? reject(err) : resolve(res.length)));
  }

  it('[AIUQ1] two concurrent inserts with the same name, type and device: one succeeds, the other is a name duplicate', async function () {
    const results = await Promise.all([
      insert({ name: 'app-x', type: 'personal' }),
      insert({ name: 'app-x', type: 'personal' })
    ]);
    const failed = results.filter((r) => r.err != null);
    assert.strictEqual(failed.length, 1, JSON.stringify(results.map((r) => r.err?.message ?? 'ok')));
    assert.strictEqual(failed[0].err.isDuplicateIndex('name'), true);
    assert.strictEqual(await countLive(), 1);
  });

  it('[AIUQ2] two concurrent inserts with the same token: one is a token duplicate', async function () {
    const token = 'tok-' + cuid.slug();
    const results = await Promise.all([
      insert({ name: 'app-a', type: 'shared', token }),
      insert({ name: 'app-b', type: 'shared', token })
    ]);
    const failed = results.filter((r) => r.err != null);
    assert.strictEqual(failed.length, 1, JSON.stringify(results.map((r) => r.err?.message ?? 'ok')));
    assert.strictEqual(failed[0].err.isDuplicateIndex('token'), true);
    assert.strictEqual(failed[0].err.isDuplicateIndex('name'), false);
    assert.strictEqual(await countLive(), 1);
  });
});
