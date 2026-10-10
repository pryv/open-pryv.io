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

const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '../../../bin/backup.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

function runCli (args, extraEnv = {}) {
  const env = Object.assign({}, process.env, extraEnv);
  // Each case states its own secrets; an ambient one must not leak in.
  if (!('PRYV_BACKUP_PASSPHRASE' in extraEnv)) delete env.PRYV_BACKUP_PASSPHRASE;
  const res = spawnSync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: 90000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * [BKRE] bin/backup.js restore: a plaintext backup is not read as such when the
 * operator supplied a decryption secret (or asked for an encrypted backup),
 * unless plaintext is explicitly allowed.
 */
describe('[BKRE] bin/backup.js restore refuses an unexpected plaintext backup', function () {
  this.timeout(120000);

  let tmpDir, plainBackup;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-enc-'));
    // A plaintext backup holding no user: restoring it writes nothing.
    plainBackup = path.join(tmpDir, 'plain');
    fs.mkdirSync(plainBackup);
    fs.writeFileSync(path.join(plainBackup, 'manifest.json'), JSON.stringify({
      formatVersion: 1,
      coreVersion: '2.0.0',
      config: {},
      backupType: 'full',
      backupTimestamp: Math.floor(Date.now() / 1000),
      snapshotBefore: null,
      users: [],
      compressed: true
    }));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function assertRefused (res) {
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /not encrypted/);
    assert.match(res.stderr, /--allow-plaintext/);
    assert.doesNotMatch(res.stdout, /Restoring/);
    assert.doesNotMatch(res.stdout, /Storage initialized/);
  }

  it('[BKRE1] --decrypt-passphrase on a plaintext backup is refused before anything is read or written', () => {
    assertRefused(runCli(['--restore', plainBackup, '--decrypt-passphrase', 'some-secret']));
  });

  it('[BKRE2] a passphrase from PRYV_BACKUP_PASSPHRASE on a plaintext backup is refused', () => {
    assertRefused(runCli(['--restore', plainBackup], { PRYV_BACKUP_PASSPHRASE: 'some-secret' }));
  });

  it('[BKRE3] --private-key on a plaintext backup is refused', () => {
    assertRefused(runCli(['--restore', plainBackup, '--private-key', path.join(tmpDir, 'unused.pem')]));
  });

  it('[BKRE4] --require-encrypted on a plaintext backup is refused, even without a secret', () => {
    assertRefused(runCli(['--restore', plainBackup, '--require-encrypted']));
  });

  it('[BKRE5] --allow-plaintext together with --require-encrypted is a usage error', () => {
    const res = runCli(['--restore', plainBackup, '--allow-plaintext', '--require-encrypted']);
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /mutually exclusive/);
  });

  it('[BKRE6] --allow-plaintext restores the plaintext backup despite the secret', () => {
    const res = runCli(['--restore', plainBackup, '--decrypt-passphrase', 'some-secret', '--allow-plaintext']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Restored: 0 users/);
  });

  it('[BKRE7] without any secret a plaintext backup restores as before', () => {
    const res = runCli(['--restore', plainBackup]);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Restored: 0 users/);
  });
});
