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

  function keyFiles (name) {
    const crypto = require('node:crypto');
    const pair = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const key = path.join(tmpDir, name + '.key.pem');
    const pub = path.join(tmpDir, name + '.pub.pem');
    fs.writeFileSync(key, pair.privateKey, { mode: 0o600 });
    fs.writeFileSync(pub, pair.publicKey);
    return { key, pub };
  }

  function rsaFiles (name) {
    const crypto = require('node:crypto');
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const key = path.join(tmpDir, name + '.key.pem');
    const pub = path.join(tmpDir, name + '.pub.pem');
    fs.writeFileSync(key, pair.privateKey, { mode: 0o600 });
    fs.writeFileSync(pub, pair.publicKey);
    return { key, pub };
  }

  it('[BKIS1] a hybrid chain signed with --signing-key: --inspect shows the signatures, the restore with --signing-pubkey verifies them and refuses another key', async function () {
    const dir = path.join(tmpDir, 'bkis1');
    const recipient = rsaFiles('bkis1-recipient');
    const signing = keyFiles('bkis1-signing');
    const other = keyFiles('bkis1-other');
    const full = runCli(['--output', dir, '--user', username, '--recipient-pubkey', recipient.pub, '--signing-key', signing.key]);
    assertOk(full, 'signed full backup');
    assert.doesNotMatch(full.stderr, /not signed/);
    assertOk(runCli(['--output', dir, '--user', username, '--incremental', '--recipient-pubkey', recipient.pub, '--signing-key', signing.key]), 'signed incremental');

    const inspect = runCli(['--inspect', dir]);
    assertOk(inspect, 'inspect');
    assert.match(inspect.stdout, /Signing key: sha256:[0-9a-f]{64}/);
    assert.strictEqual(inspect.stdout.match(/signed: yes, key sha256:[0-9a-f]{64} \(not verified: pass --signing-pubkey\)/g)?.length, 2, inspect.stdout);
    const verified = runCli(['--inspect', dir, '--signing-pubkey', signing.pub]);
    assertOk(verified, 'inspect --signing-pubkey');
    assert.strictEqual(verified.stdout.match(/signed: yes, key sha256:[0-9a-f]{64}, verified/g)?.length, 2, verified.stdout);

    const restore = runCli(['--restore', dir, '--user', username, '--private-key', recipient.key, '--signing-pubkey', signing.pub, '--overwrite']);
    assertOk(restore, 'restore');
    assert.match(restore.stdout, /Restored: 1 users/);
    const refused = runCli(['--restore', dir, '--user', username, '--private-key', recipient.key, '--signing-pubkey', other.pub, '--overwrite']);
    assert.strictEqual(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /not signed by the key given \(--signing-pubkey\)/);
    assert.doesNotMatch(refused.stdout, /Restore report/);
  });

  it('[BKIS2] a hybrid backup without --signing-key warns, a symmetric one does not; another --signing-key on a signed chain is refused before anything is written', async function () {
    const recipient = rsaFiles('bkis2-recipient');
    const hybrid = runCli(['--output', path.join(tmpDir, 'bkis2-hybrid'), '--user', username, '--recipient-pubkey', recipient.pub]);
    assertOk(hybrid, 'hybrid backup');
    assert.match(hybrid.stderr, /WARNING: this backup is not signed: a holder of the recipient public key with write access to the destination could replace a run; pass --signing-key <ed25519 pem> and verify with --signing-pubkey at restore\./);
    const symmetric = runCli(['--output', path.join(tmpDir, 'bkis2-sym'), '--user', username, '--passphrase-file', passphraseFile]);
    assertOk(symmetric, 'symmetric backup');
    assert.doesNotMatch(symmetric.stderr, /not signed/);

    const dir = path.join(tmpDir, 'bkis2-signed');
    const signing = keyFiles('bkis2-signing');
    const other = keyFiles('bkis2-other');
    assertOk(runCli(['--output', dir, '--user', username, '--passphrase-file', passphraseFile, '--signing-key', signing.key]), 'signed full backup');
    const before = fs.readdirSync(dir).sort();
    const wrong = runCli(['--output', dir, '--user', username, '--incremental', '--passphrase-file', passphraseFile, '--signing-key', other.key]);
    assert.strictEqual(wrong.status, 1, wrong.stdout + wrong.stderr);
    assert.match(wrong.stderr, /The signing key \(sha256:[0-9a-f]{64}\) differs from the one of the backup chain/);
    const none = runCli(['--output', dir, '--user', username, '--incremental', '--passphrase-file', passphraseFile]);
    assert.strictEqual(none.status, 1, none.stdout + none.stderr);
    assert.match(none.stderr, /is signed with key sha256:[0-9a-f]{64}: pass the same --signing-key/);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'nothing written');
  });

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
