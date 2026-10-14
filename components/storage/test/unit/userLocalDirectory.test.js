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
const { userLocalDirectory } = require('storage');

describe('[ULDK] userLocalDirectory.deleteUserDirectory with entries to keep', function () {
  let userId, userDir;

  before(async function () {
    await userLocalDirectory.init();
  });

  beforeEach(async function () {
    userId = cuid();
    userDir = await userLocalDirectory.ensureUserDirectory(userId);
    fs.writeFileSync(path.join(userDir, 'kept.sqlite'), 'k');
    fs.writeFileSync(path.join(userDir, 'kept.sqlite-wal'), 'w');
    fs.writeFileSync(path.join(userDir, 'other.sqlite'), 'o');
    fs.mkdirSync(path.join(userDir, 'attachments', 'evt'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'attachments', 'evt', 'file'), 'a');
  });

  afterEach(async function () {
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  it('[ULK1] removes every other entry and keeps the listed ones in place', async function () {
    await userLocalDirectory.deleteUserDirectory(userId, ['kept.sqlite', 'kept.sqlite-wal', 'kept.sqlite-shm']);
    assert.deepStrictEqual(fs.readdirSync(userDir).sort(), ['kept.sqlite', 'kept.sqlite-wal']);
    assert.strictEqual(fs.readFileSync(path.join(userDir, 'kept.sqlite'), 'utf8'), 'k');
  });

  it('[ULK2] removes the directory when none of the listed entries exists', async function () {
    await userLocalDirectory.deleteUserDirectory(userId, ['absent.sqlite']);
    assert.strictEqual(fs.existsSync(userDir), false);
  });

  it('[ULK4] a user id that is not one directory name is refused, and nothing outside its directory is deleted', async function () {
    const canaryName = 'ulk4-canary-' + cuid().slice(-8);
    const canary = path.join(userLocalDirectory.getBasePath(), canaryName);
    fs.mkdirSync(canary, { recursive: true });
    fs.writeFileSync(path.join(canary, 'data'), 'kept');
    try {
      // Resolves to `<base>/<canaryName>` when joined under `<base>/x/y/z/`.
      const climbing = '../../../' + canaryName;
      for (const badId of [climbing, 'abc/../../../x', 'abc\\def', 'ab\0cd']) {
        assert.throws(() => userLocalDirectory.getPathForUser(badId), /Invalid/, JSON.stringify(badId));
      }
      await assert.rejects(() => userLocalDirectory.deleteUserDirectory(climbing), /Invalid/);
      await assert.rejects(() => userLocalDirectory.ensureUserDirectory(climbing), /Invalid/);
      assert.strictEqual(fs.readFileSync(path.join(canary, 'data'), 'utf8'), 'kept');
      assert.throws(() => userLocalDirectory.getPathForUser(userId, '../../escape'), /Invalid/);
    } finally {
      fs.rmSync(canary, { recursive: true, force: true });
    }
  });

  it('[ULK3] removes the directory without a list, and accepts a directory already gone', async function () {
    await userLocalDirectory.deleteUserDirectory(userId);
    assert.strictEqual(fs.existsSync(userDir), false);
    await userLocalDirectory.deleteUserDirectory(userId, ['kept.sqlite']);
    assert.strictEqual(fs.existsSync(userDir), false);
  });
});

describe('[ULDE] userLocalDirectory: an erased account directory is not created again', function () {
  before(async function () {
    await userLocalDirectory.init();
  });

  afterEach(function () {
    userLocalDirectory.clearErasedTestOnly();
  });

  it('[ULE1] after an erasure, ensureUserDirectory refuses and creates nothing', async function () {
    const userId = cuid();
    const userDir = await userLocalDirectory.ensureUserDirectory(userId);
    await userLocalDirectory.deleteUserDirectory(userId, [], { erased: true });
    assert.strictEqual(userLocalDirectory.isErased(userId), true);
    await assert.rejects(userLocalDirectory.ensureUserDirectory(userId), (err) => err.code === 'USER_ERASED');
    await assert.rejects(userLocalDirectory.ensureUserDirectory(userId, 'attachments'), (err) => err.code === 'USER_ERASED');
    assert.strictEqual(fs.existsSync(userDir), false);
  });

  it('[ULE2] a directory kept by the erasure stays usable', async function () {
    const userId = cuid();
    const userDir = await userLocalDirectory.ensureUserDirectory(userId);
    fs.writeFileSync(path.join(userDir, 'audit.sqlite'), 'a');
    fs.writeFileSync(path.join(userDir, 'other.sqlite'), 'o');
    try {
      await userLocalDirectory.deleteUserDirectory(userId, ['audit.sqlite'], { erased: true });
      assert.strictEqual(await userLocalDirectory.ensureUserDirectory(userId), userDir);
      assert.deepStrictEqual(fs.readdirSync(userDir), ['audit.sqlite']);
    } finally {
      await userLocalDirectory.deleteUserDirectory(userId);
    }
  });

  it('[ULE3] a plain removal (not an erasure) lets the directory be created again', async function () {
    const userId = cuid();
    const userDir = await userLocalDirectory.ensureUserDirectory(userId);
    await userLocalDirectory.deleteUserDirectory(userId);
    assert.strictEqual(await userLocalDirectory.ensureUserDirectory(userId), userDir);
    assert.strictEqual(fs.existsSync(userDir), true);
    await userLocalDirectory.deleteUserDirectory(userId);
  });

  it('[ULE4] an erasure announced by another worker is refused here too', async function () {
    const userId = cuid();
    require('messages').pubsub.cache._emit(userLocalDirectory.USER_ERASED, { userId });
    assert.strictEqual(userLocalDirectory.isErased(userId), true);
    await assert.rejects(userLocalDirectory.ensureUserDirectory(userId), (err) => err.code === 'USER_ERASED');
    assert.strictEqual(fs.existsSync(userLocalDirectory.getPathForUser(userId)), false);
  });
});
