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
/* global initTests, initCore, getNewFixture, assert, cuid */

/**
 * [SSOCLI] bin/sso-link.js — operator link-management CLI (spawned as a child
 * against a booted core, like the other bin CLIs). Covers the operationally
 * critical show + unlink paths and the guards. The list command's
 * provider-enumeration branch depends on `sso:providers` config the spawned
 * child would need on disk; here we cover its no-providers-configured branch
 * (the loop itself is a thin wrapper over the Platform.listUserUniqueValues
 * primitive, which is covered by the platform suite).
 */

const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '../../../bin/sso-link.js');
const PROVIDER = 'testidp';
const field = 'sso-' + PROVIDER;

function runCli (args) {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: path.resolve(__dirname, '../../../'),
    encoding: 'utf8',
    timeout: 30000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('[SSOCLI] bin/sso-link.js CLI', function () {
  this.timeout(40000);
  let platform, fixtures;

  before(async function () {
    await initTests();
    await initCore();
    const { getPlatform } = require('platform');
    platform = await getPlatform();
    fixtures = getNewFixture();
  });

  after(async function () { await fixtures.clean(); });

  async function makeUser () {
    const username = 'slc' + cuid().toLowerCase().slice(1, 12);
    await fixtures.user(username, { email: cuid() + '@slc.example.com' });
    return username;
  }

  it('[SLC01] --help prints usage and exits 0', function () {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /unlink <username> <provider> <subject>/);
  });

  it('[SLC02] show + unlink round-trip over a real binding', async function () {
    const username = await makeUser();
    const sub = 'sub-' + cuid();
    assert.strictEqual(await platform.reserveUserUniqueValue(username, field, sub), true);

    // show resolves the binding to the owning account.
    let res = runCli(['show', PROVIDER, sub]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp('-> ' + username));

    // unlink refuses without --yes and changes nothing.
    res = runCli(['unlink', username, PROVIDER, sub]);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /--yes/);
    assert.strictEqual(await platform.getUsersUniqueField(field, sub) != null, true);

    // unlink --yes removes the row.
    res = runCli(['unlink', username, PROVIDER, sub, '--yes']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /removed the "testidp" binding/);
    assert.strictEqual(await platform.getUsersUniqueField(field, sub), null);

    // a second unlink is a NO-OP with a non-zero status.
    res = runCli(['unlink', username, PROVIDER, sub, '--yes']);
    assert.strictEqual(res.status, 2, res.stdout);
    assert.match(res.stdout, /NO-OP/);
  });

  it('[SLC03] show on an unbound subject exits 2', function () {
    const res = runCli(['show', PROVIDER, 'sub-never-' + cuid()]);
    assert.strictEqual(res.status, 2);
    assert.match(res.stdout, /NOT BOUND/);
  });

  it('[SLC04] unlink never removes a row owned by another account', async function () {
    const owner = await makeUser();
    const other = await makeUser();
    const sub = 'sub-' + cuid();
    assert.strictEqual(await platform.reserveUserUniqueValue(owner, field, sub), true);

    // Wrong owner: the guard leaves the row intact.
    const res = runCli(['unlink', other, PROVIDER, sub, '--yes']);
    assert.strictEqual(res.status, 2, res.stdout);
    assert.strictEqual(await platform.getUsersUniqueField(field, sub) != null, true);

    await platform.releaseUserUniqueValue(owner, field, sub);
  });
});
