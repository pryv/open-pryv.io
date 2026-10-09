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

  it('[ULK3] removes the directory without a list, and accepts a directory already gone', async function () {
    await userLocalDirectory.deleteUserDirectory(userId);
    assert.strictEqual(fs.existsSync(userDir), false);
    await userLocalDirectory.deleteUserDirectory(userId, ['kept.sqlite']);
    assert.strictEqual(fs.existsSync(userDir), false);
  });
});
