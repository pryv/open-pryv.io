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
/* global initTests, initCore, assert */

const path = require('path');
const { spawnSync } = require('child_process');
const { childStorageEngineEnv } = require('test-helpers');
const cuid = require('cuid');

const CLI = path.resolve(__dirname, '../../../bin/platform-backloop-cleanup.js');

function runCli (args) {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: path.resolve(__dirname, '../../../'),
    env: { ...process.env, ...childStorageEngineEnv() },
    encoding: 'utf8',
    timeout: 60000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * [BKLC] bin/platform-backloop-cleanup.js releases the platform rows reserved
 * under the username "backloop" (no account behind them); a dry run writes
 * nothing; other users' rows are untouched; reserved values are never printed.
 */
describe('[BKLC] bin/platform-backloop-cleanup.js', function () {
  this.timeout(120000);
  let platform;
  const emails = ['bklc-' + cuid() + '@example.com', 'bklc-' + cuid() + '@example.com'];
  const otherUser = 'bklcother' + cuid.slug().toLowerCase();
  const otherEmail = 'bklc-other-' + cuid() + '@example.com';
  let savedIntegrityCheck;

  before(async function () {
    // the seeded rows have no account behind them, which is the point
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    await initTests();
    await initCore();
    const { getPlatform } = require('platform');
    platform = await getPlatform();
    for (const email of emails) {
      assert.strictEqual(await platform.setUserUniqueFieldIfNotExists('backloop', 'email', email), true);
    }
    await platform.setUserCore('backloop', platform.coreId);
    assert.strictEqual(await platform.setUserUniqueFieldIfNotExists(otherUser, 'email', otherEmail), true);
  });

  after(async function () {
    await platform.deleteUser('backloop', null);
    await platform.deleteUserCore('backloop');
    await platform.deleteUserUniqueField('email', otherEmail);
    if (savedIntegrityCheck != null) process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    else delete process.env.DISABLE_INTEGRITY_CHECK;
  });

  it('[BKLC1] --help prints usage and exits 0', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /--apply/);
  });

  it('[BKLC2] the default run reports the rows, never their values, and writes nothing', async () => {
    const res = runCli([]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /DRY-RUN/);
    assert.match(res.stdout, /unique values reserved 2/);
    assert.match(res.stdout, /email 2/);
    assert.match(res.stdout, /name->core row\s+yes/);
    for (const email of emails) {
      assert.ok(!res.stdout.includes(email), 'a reserved value is never printed');
      assert.notStrictEqual(await platform.getUsersUniqueField('email', email), null, 'still reserved');
    }
    assert.notStrictEqual(await platform.getUserCore('backloop'), null);
  });

  it('[BKLC3] --apply releases the rows of "backloop" only', async () => {
    const res = runCli(['--apply']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /rows removed\s+3/);
    for (const email of emails) {
      assert.strictEqual(await platform.getUsersUniqueField('email', email), null);
    }
    assert.strictEqual(await platform.getUserCore('backloop'), null);
    assert.notStrictEqual(await platform.getUsersUniqueField('email', otherEmail), null, 'other users untouched');
  });

  it('[BKLC4] a re-run finds nothing left', () => {
    const res = runCli(['--apply']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /unique values reserved 0/);
    assert.match(res.stdout, /name->core row\s+no/);
  });
});
