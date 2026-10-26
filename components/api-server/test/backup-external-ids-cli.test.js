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
/* global initTests, initCore, getNewFixture, assert */

const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('child_process');
const cuid = require('cuid');
const { childStorageEngineEnv } = require('test-helpers');

const CLI = path.resolve(__dirname, '../../../bin/backup.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

function runCli (args) {
  const env = { ...process.env, ...childStorageEngineEnv() };
  delete env.PRYV_BACKUP_PASSPHRASE;
  const res = spawnSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 90000 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function assertOk (res, what) {
  assert.strictEqual(res.status, 0, what + '\n' + res.stdout + res.stderr);
}

function blinded () {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * [XIDBK] bin/backup.js carries an account's external ids: an account
 * deleted after its backup (which releases its ids) is restored with them,
 * unless another account took one meanwhile.
 */
describe('[XIDBK] bin/backup.js: external ids of an account, end to end', function () {
  this.timeout(300000);

  let fixtures, tmpDir, externalIds, usersRepository, platform, ns;

  async function newUser (prefix) {
    const username = prefix + cuid.slug().toLowerCase();
    await fixtures.user(username);
    return username; // the fixture's user id is its username
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-external-ids-cli-'));
    externalIds = await require('business/src/external-ids/service.ts').getExternalIdsService();
    usersRepository = await require('business/src/users/repository.ts').getUsersRepository();
    platform = await require('platform').getPlatform();
    ns = 'xidbk-' + cuid.slug().toLowerCase();
    await require('platform/src/externalIdIndex.ts').setNamespace(platform, ns, { label: 'XIDBK' }, Date.now() / 1000);
  });

  after(async function () {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await fixtures.clean();
    await require('platform/src/externalIdIndex.ts').deleteNamespace(platform, ns, { force: true });
  });

  it('[XIDBK1] backup, account deletion (the id is released), restore: the account holds the id again and the lookup finds it', async function () {
    const username = await newUser('xidbka');
    const value = blinded();
    await externalIds.claim(username, ns, value);
    const [claimed] = await externalIds.list(username);
    const dir = path.join(tmpDir, 'one');

    assertOk(runCli(['--output', dir, '--user', username]), 'backup');
    assert.ok(fs.existsSync(path.join(dir, 'users', username, 'external-ids.jsonl.gz')), 'the per-user external-ids file');

    await usersRepository.deleteOne(username, username);
    assert.strictEqual(await externalIds.lookupCoreUrl(ns, value), null, 'released with the account');
    assert.deepStrictEqual(await externalIds.list(username), []);

    const restore = runCli(['--restore', dir, '--user', username]);
    assertOk(restore, 'restore');
    assert.match(restore.stdout, /Restored: 1 users/);
    assert.match(restore.stdout, /External ids: 1 restored, 0 lost/);
    assert.strictEqual(await externalIds.holds(username, ns, value), true, 'the restored account holds the id');
    assert.strictEqual(await externalIds.lookupCoreUrl(ns, value), platform.coreIdToUrl(platform.coreId), 'the lookup finds this core');
    assert.deepStrictEqual(await externalIds.list(username), [claimed], 'with its claim date');

    // Through the repository with the username given (see [BKIC4]): releases the id again.
    await usersRepository.deleteOne(username, username);
    assert.strictEqual(await externalIds.lookupCoreUrl(ns, value), null);
  });

  it('[XIDBK2] an id another account claimed between the deletion and the restore stays with that account; the restore reports it lost', async function () {
    const username = await newUser('xidbkb');
    const other = await newUser('xidbkc');
    const value = blinded();
    await externalIds.claim(username, ns, value);
    const dir = path.join(tmpDir, 'two');

    assertOk(runCli(['--output', dir, '--user', username]), 'backup');
    await usersRepository.deleteOne(username, username);
    await externalIds.claim(other, ns, value);

    const restore = runCli(['--restore', dir, '--user', username]);
    assertOk(restore, 'restore');
    assert.match(restore.stdout, /Restored: 1 users/);
    assert.match(restore.stdout, /External ids: 0 restored, 1 lost \(held by another account or core\)/);
    assert.strictEqual(await externalIds.holds(other, ns, value), true, 'the other account keeps the id');
    assert.strictEqual(await externalIds.holds(username, ns, value), false);
    assert.deepStrictEqual(await externalIds.list(username), []);

    await usersRepository.deleteOne(username, username);
    await externalIds.release(other, ns);
  });
});
