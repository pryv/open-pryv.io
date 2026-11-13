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
/* global initTests, initCore, getNewFixture, coreRequest, assert */

const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('child_process');
const cuid = require('cuid');
const { childStorageEngineEnv } = require('test-helpers');

const CLI = path.resolve(__dirname, '../../../bin/backup.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

function runCli (args) {
  const env = { ...process.env, ...childStorageEngineEnv() };
  // Each case states its own secrets; an ambient one must not leak in.
  delete env.PRYV_BACKUP_PASSPHRASE;
  const res = spawnSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 90000 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function assertOk (res, what) {
  assert.strictEqual(res.status, 0, what + '\n' + res.stdout + res.stderr);
}

/**
 * bin/backup.js: every file of a run is listed in its manifest; --inspect
 * --verify-files checks them, the restore refuses a changed file, and the
 * plaintext mirror of the bundled script restores as a chain without file
 * lists.
 */
describe('[BKIS] bin/backup.js run file tables, end to end', function () {
  this.timeout(300000);

  let fixtures, username, token, tmpDir, passphraseFile;
  const attachmentBytes = Buffer.from('BKIS attachment ' + cuid());

  function api (method, url) {
    return coreRequest[method]('/' + username + url).set('Authorization', token);
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'bkis' + cuid.slug().toLowerCase();
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-integrity-cli-'));
    passphraseFile = path.join(tmpDir, 'passphrase');
    fs.writeFileSync(passphraseFile, 'bkis-passphrase\n', { mode: 0o600 });

    const streamId = 'bkis-s1-' + cuid.slug();
    let res = await api('post', '/streams').send({ id: streamId, name: 'BKIS S1' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    res = await api('post', '/events')
      .field('event', JSON.stringify({ streamIds: [streamId], type: 'note/txt', content: 'with a file' }))
      .attach('file', attachmentBytes, 'f.txt');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  after(async function () {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await fixtures.clean();
  });

  function backupInto (dir, extra = []) {
    const res = runCli(['--output', dir, '--user', username, '--passphrase-file', passphraseFile, ...extra]);
    assertOk(res, 'backup');
    return res;
  }

  it('[BKIS3] --inspect --verify-files checks every listed file; one byte changed in an attachment fails it and the restore, naming the file', async function () {
    const dir = path.join(tmpDir, 'bkis3');
    backupInto(dir);

    const listed = runCli(['--inspect', dir, '--passphrase-file', passphraseFile]);
    assertOk(listed, 'inspect');
    assert.match(listed.stdout, /full: files: \d+ listed/);
    const noSecret = runCli(['--inspect', dir]);
    assertOk(noSecret, 'inspect without the secret');
    assert.match(noSecret.stdout, /full: files: not readable without the secret/);
    const unknown = runCli(['--inspect', dir, '--verify-files']);
    assert.strictEqual(unknown.status, 2, unknown.stdout + unknown.stderr);

    const verified = runCli(['--inspect', dir, '--verify-files', '--passphrase-file', passphraseFile]);
    assertOk(verified, 'inspect --verify-files');
    assert.match(verified.stdout, /full: files: \d+ verified/);

    const [userId] = fs.readdirSync(path.join(dir, 'users'));
    const attachDir = path.join(dir, 'users', userId, 'attachments');
    const [fileId] = fs.readdirSync(attachDir);
    const filePath = path.join(attachDir, fileId);
    const bytes = fs.readFileSync(filePath);
    bytes[bytes.length - 5] ^= 0x01;
    fs.writeFileSync(filePath, bytes);
    const rel = `users/${userId}/attachments/${fileId}`;

    const failed = runCli(['--inspect', dir, '--verify-files', '--passphrase-file', passphraseFile]);
    assert.strictEqual(failed.status, 1, failed.stdout + failed.stderr);
    assert.ok(failed.stdout.includes(`FAILED: Run full of the backup at ${dir}: file ${rel} differs from the run's manifest (hash): refused.`), failed.stdout);

    const restore = runCli(['--restore', dir, '--user', username, '--passphrase-file', passphraseFile, '--overwrite']);
    assert.strictEqual(restore.status, 1, restore.stdout + restore.stderr);
    assert.ok(restore.stderr.includes(`file ${rel} differs from the run's manifest (hash)`), restore.stderr);
    assert.doesNotMatch(restore.stdout, /Restore report/);
  });

  it('[BKDS2] the plaintext mirror the bundled script writes restores as a chain without file lists', async function () {
    const dir = path.join(tmpDir, 'bkds2');
    backupInto(dir);
    backupInto(dir, ['--incremental']);
    const mirror = path.join(tmpDir, 'bkds2-mirror');
    const script = spawnSync(process.execPath, [path.join(dir, 'decrypt-backup.mjs'), dir, '--passphrase', 'bkis-passphrase', '--out', mirror], { encoding: 'utf8' });
    assert.strictEqual(script.status, 0, script.stdout + script.stderr);
    assert.match(script.stdout, /Run full: \d+ files verified/);

    const restore = runCli(['--restore', mirror, '--user', username, '--allow-plaintext', '--overwrite']);
    assertOk(restore, 'restore of the mirror');
    assert.match(restore.stderr, /WARNING: Run full: written before 2\.0\.0-rc\.85, its file list is not verified/);
    assert.match(restore.stdout, /Restored: 1 users/);
    const res = await api('get', '/events');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });
});
