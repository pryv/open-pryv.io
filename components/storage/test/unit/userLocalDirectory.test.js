/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cuid = require('cuid');
const { userLocalDirectory, getUsersLocalIndex } = require('storage');

const ENSURE_WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../support/ensureUserFileWorker.js');

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
      assert.deepStrictEqual(fs.readdirSync(userDir).sort(), ['audit.sqlite', userLocalDirectory.ERASED_MARKER]);
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

describe('[ERMK] userLocalDirectory: the erased marker of a kept directory', function () {
  this.timeout(60000);
  const MARKER = userLocalDirectory.ERASED_MARKER;
  let userId, userDir;

  before(async function () {
    await userLocalDirectory.init();
  });

  /** An account directory with an audit file and another file, erased keeping the audit file. */
  async function erasedKeepingAudit () {
    userId = cuid();
    userDir = await userLocalDirectory.ensureUserDirectory(userId);
    fs.writeFileSync(path.join(userDir, 'audit.sqlite'), 'a');
    fs.writeFileSync(path.join(userDir, 'account.sqlite'), 'o');
    await userLocalDirectory.deleteUserDirectory(userId, ['audit.sqlite'], { erased: true });
  }

  afterEach(async function () {
    userLocalDirectory.clearErasedTestOnly();
    if (userId != null) await userLocalDirectory.deleteUserDirectory(userId);
    userId = null;
  });

  it('[ERMK1] the erasure writes the marker in the kept directory, and a resumed erasure keeps it as it is', async function () {
    await erasedKeepingAudit();
    assert.deepStrictEqual(fs.readdirSync(userDir).sort(), ['audit.sqlite', MARKER]);
    const first = JSON.parse(fs.readFileSync(path.join(userDir, MARKER), 'utf8'));
    assert.strictEqual(first.v, 1);
    assert.strictEqual(typeof first.erasedAt, 'number');
    assert.deepStrictEqual(Object.keys(first).sort(), ['erasedAt', 'v'], 'the marker names nothing but the time');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await userLocalDirectory.deleteUserDirectory(userId, ['audit.sqlite'], { erased: true });
    assert.deepStrictEqual(fs.readdirSync(userDir).sort(), ['audit.sqlite', MARKER]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(userDir, MARKER), 'utf8')), first);
  });

  it('[ERMK2] ensureUserFile opens a kept file and refuses a new one, with or without the in-process mark', async function () {
    await erasedKeepingAudit();
    assert.strictEqual(await userLocalDirectory.ensureUserFile(userId, 'audit.sqlite'), path.join(userDir, 'audit.sqlite'));
    await assert.rejects(userLocalDirectory.ensureUserFile(userId, 'account.sqlite'), (err) => err.code === 'USER_ERASED');
    userLocalDirectory.clearErasedTestOnly(); // a restarted process: the marker alone decides
    await assert.rejects(userLocalDirectory.ensureUserFile(userId, 'account.sqlite'), (err) => err.code === 'USER_ERASED');
    await assert.rejects(userLocalDirectory.ensureUserFile(userId, 'attachments'), (err) => err.code === 'USER_ERASED');
    assert.deepStrictEqual(fs.readdirSync(userDir).sort(), ['audit.sqlite', MARKER], 'nothing created');
    // A live account (no marker): a missing file is fine, its path is given.
    const liveId = cuid();
    try {
      const livePath = await userLocalDirectory.ensureUserFile(liveId, 'account.sqlite');
      assert.strictEqual(livePath, userLocalDirectory.getPathForUser(liveId, 'account.sqlite'));
      await assert.rejects(userLocalDirectory.ensureUserFile(liveId, 'sub/account.sqlite'), /Invalid/);
      await assert.rejects(userLocalDirectory.ensureUserFile(liveId, '../account.sqlite'), /Invalid/);
    } finally {
      await userLocalDirectory.deleteUserDirectory(liveId);
    }
  });

  it('[ERMK3] another process, without any in-process mark, is refused too', async function () {
    await erasedKeepingAudit();
    const refused = runWorker(userId, 'account.sqlite');
    assert.deepStrictEqual(refused, { ok: false, code: 'USER_ERASED' });
    const kept = runWorker(userId, 'audit.sqlite');
    assert.deepStrictEqual(kept, { ok: true, path: path.join(userDir, 'audit.sqlite') });
    assert.deepStrictEqual(fs.readdirSync(userDir).sort(), ['audit.sqlite', MARKER]);
  });

  it('[ERMK4] indexing the id again removes the marker: new files open again', async function () {
    await erasedKeepingAudit();
    const usersLocalIndex = await getUsersLocalIndex();
    const username = 'ermk' + cuid.slug().toLowerCase();
    await usersLocalIndex.addUser(username, userId);
    try {
      assert.deepStrictEqual(fs.readdirSync(userDir).sort(), ['audit.sqlite']);
      assert.strictEqual(userLocalDirectory.isErased(userId), false);
      assert.strictEqual(await userLocalDirectory.ensureUserFile(userId, 'account.sqlite'), path.join(userDir, 'account.sqlite'));
      assert.deepStrictEqual(runWorker(userId, 'account.sqlite'), { ok: true, path: path.join(userDir, 'account.sqlite') });
      // Absent marker, absent directory: nothing to do.
      await userLocalDirectory.unmarkErased(userId);
      await userLocalDirectory.unmarkErased(cuid());
    } finally {
      await usersLocalIndex.deleteById(userId);
    }
  });

  it('[ERMK6] an index entry refused (the name is taken) leaves the marker; hasErasedMarker / remarkErased', async function () {
    await erasedKeepingAudit();
    const usersLocalIndex = await getUsersLocalIndex();
    const holderId = cuid();
    const username = 'ermk' + cuid.slug().toLowerCase();
    await usersLocalIndex.addUser(username, holderId);
    try {
      await assert.rejects(usersLocalIndex.addUser(username, userId));
      assert.strictEqual(await userLocalDirectory.hasErasedMarker(userId), true, 'the marker stays');
      await assert.rejects(userLocalDirectory.ensureUserFile(userId, 'account.sqlite'), (err) => err.code === 'USER_ERASED');
      // Removed, then put back (a failed restore).
      await userLocalDirectory.unmarkErased(userId);
      assert.strictEqual(await userLocalDirectory.hasErasedMarker(userId), false);
      await userLocalDirectory.remarkErased(userId);
      assert.strictEqual(await userLocalDirectory.hasErasedMarker(userId), true);
      // No directory: nothing to mark.
      const goneId = cuid();
      await userLocalDirectory.remarkErased(goneId);
      assert.strictEqual(fs.existsSync(userLocalDirectory.getPathForUser(goneId)), false);
    } finally {
      await usersLocalIndex.deleteById(holderId);
    }
  });
});

/** `ensureUserFile(userId, fileName)` in a child process: `{ ok, path }` or `{ ok: false, code }`. */
function runWorker (userId, fileName) {
  const res = spawnSync(process.execPath, [ENSURE_WORKER, userId, fileName], { env: process.env, encoding: 'utf8', timeout: 60000 });
  if (res.status !== 0) throw new Error(`worker exit ${res.status}: ${(res.stderr || '').slice(-2000)}`);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}
