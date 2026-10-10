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
const { spawnSync } = require('child_process');
const { childStorageEngineEnv } = require('test-helpers');
const cuid = require('cuid');

const CLI = path.resolve(__dirname, '../../../bin/emails-unproved-report.js');

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
 * [EURP] bin/emails-unproved-report.js lists, read-only, the addresses an
 * account holds without proof and its email rows matching no address; values
 * are printed only with --values.
 */
describe('[EURP] bin/emails-unproved-report.js', function () {
  this.timeout(120000);
  let fixtures;
  let platform;
  const username = 'eurp' + cuid.slug().toLowerCase();
  const primary = 'eurp-' + cuid() + '@example.com';
  const pending = 'eurp-pending-' + cuid() + '@example.com';
  const ghost = 'eurp-ghost-' + cuid() + '@example.com';
  let savedIntegrityCheck;

  before(async function () {
    // the ghost row has no address behind it, which is the point
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    await fixtures.user(username, { email: primary });
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    const operations = require('business/src/emails/operations.ts');
    await operations.addEmails({ errors: require('errors').factory, usersRepository },
      { userId, username, user: null, accessId: 'system', legacyEmail: primary }, [pending]);
    const { getPlatform } = require('platform');
    platform = await getPlatform();
    assert.strictEqual(await platform.reserveUserUniqueValue(username, 'email', ghost), true);
  });

  after(async function () {
    await platform.releaseUserUniqueValue(username, 'email', ghost);
    await fixtures.clean();
    if (savedIntegrityCheck != null) process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    else delete process.env.DISABLE_INTEGRITY_CHECK;
  });

  it('[EURP1] --help prints usage and exits 0', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /--values/);
  });

  it('[EURP2] reports counts and usernames, never the addresses, and writes nothing', async () => {
    const res = runCli([]);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(username + ': 2 unproved, 1 holding a row, 1 orphan row'));
    for (const value of [primary, pending, ghost]) {
      assert.ok(!res.stdout.includes(value), 'an address is not printed by default');
    }
    assert.notStrictEqual(await platform.getUsersUniqueField('email', ghost), null, 'nothing released');
  });

  it('[EURP3] --values prints the unproved addresses', () => {
    const res = runCli(['--values']);
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.ok(res.stdout.includes(pending + '  status=pending'), res.stdout);
    assert.ok(res.stdout.includes(primary + '  status=verified method=registration'), res.stdout);
  });
});
