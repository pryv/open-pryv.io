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

/**
 * [RXCR] a backup restore on a multi-core platform: an account whose name the
 * platform routes to another core is not restored here (it lives there, or
 * its erasure there has not completed), and a restored account's name is
 * routed to this core. Platform rows of a whole restore never take a unique
 * value (an email, an SSO binding) from the account that holds it now.
 */

/* global initTests, initCore, getNewFixture, assert */

const path = require('node:path');
const cuid = require('cuid');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { childStorageEngineEnv } = require('test-helpers');
const { getUsersRepository } = require('business/src/users/index.ts');
const RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator.ts').default;
const { createBackupReader } = require('storages/interfaces/backup/BackupReader.ts');

const CLI = path.resolve(__dirname, '../../../bin/backup.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');
// The core the restores below run as (a member of a multi-core platform), and
// another core of that platform.
const THIS_CORE = 'rxcr-a-' + cuid.slug().toLowerCase();
const OTHER_CORE = 'rxcr-b-' + cuid.slug().toLowerCase();

function runCli (args, env = {}) {
  const fullEnv = { ...process.env, ...childStorageEngineEnv(), ...env };
  delete fullEnv.PRYV_BACKUP_PASSPHRASE;
  const res = spawnSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: fullEnv, timeout: 90000 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** bin/backup.js as `THIS_CORE` of a multi-core platform (an explicit core URL, DNSless). */
function runCliMultiCore (args) {
  return runCli(args, { core__id: THIS_CORE, core__url: 'http://127.0.0.1:13999' });
}

function assertOk (res, what) {
  assert.strictEqual(res.status, 0, what + '\n' + res.stdout + res.stderr);
}

describe('[RXCR] restore of an account the platform routes to another core', function () {
  this.timeout(300000);

  let usersRepository, platform, platformDB, tmpDir;
  const fixtures = [];
  const accounts = [];

  before(async function () {
    await initTests();
    await initCore();
    usersRepository = await getUsersRepository();
    platform = usersRepository.platform;
    platformDB = require('storages').platformDB;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-foreign-core-'));
  });

  // Before the per-test platform consistency check: a single-account restore
  // writes no platform rows (indexed fields) for the account.
  afterEach(async function () {
    for (const u of accounts.splice(0)) {
      if (await exists(u)) await usersRepository.deleteOne(u.id, u.username);
      await platform.deleteUserCore(u.username);
    }
  });

  after(async function () {
    for (const f of fixtures) await f.clean();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    // The multi-core restores registered `THIS_CORE` in the platform store.
    if (typeof platformDB?.execute === 'function') {
      await platformDB.execute('DELETE FROM keyValue WHERE key = ?', ['core-info/' + THIS_CORE]);
    }
  });

  /**
   * An account backed up with bin/backup.js, then removed from this core
   * (index, data, platform rows): as if it had moved to another core.
   */
  async function backedUpAccount () {
    const fx = getNewFixture();
    fixtures.push(fx);
    const username = ('rxcr' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await fx.user(username);
    const stream = await fu.stream({ id: 'rxcr-' + cuid().slice(-10), name: 'RXCR ' + cuid().slice(-6) });
    await stream.event({ type: 'note/txt', content: 'backed up' });
    const dir = path.join(tmpDir, username);
    assertOk(runCli(['--output', dir, '--user', username]), 'backup');
    const u = { id: fu.attrs.id, username, dir };
    accounts.push(u);
    await usersRepository.deleteOne(u.id, u.username);
    assert.strictEqual(await exists(u), false, 'removed from this core');
    return u;
  }

  async function exists (u) {
    return (await usersRepository.getUserIdForUsername(u.username)) === u.id;
  }

  it('[RXCR1] a single-account restore is refused, nothing restored, when the account\'s name is routed to another core', async function () {
    const u = await backedUpAccount();
    await platform.setUserCore(u.username, OTHER_CORE);

    const res = runCliMultiCore(['--restore', u.dir, '--user', u.username]);
    assert.notStrictEqual(res.status, 0, 'refused\n' + res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`username "${u.username}" is routed to core "${OTHER_CORE}" \\(this core is "${THIS_CORE}"\\)`));
    assert.match(res.stderr, /Restore it on that core/);
    assert.match(res.stderr, /Nothing was restored/);
    assert.strictEqual(await exists(u), false, 'not indexed on this core');
    assert.strictEqual(await platform.getUserCore(u.username), OTHER_CORE, 'still routed to the other core');

    // --overwrite does not lift it.
    const again = runCliMultiCore(['--restore', u.dir, '--user', u.username, '--overwrite']);
    assert.notStrictEqual(again.status, 0, 'refused with --overwrite\n' + again.stdout + again.stderr);
    assert.strictEqual(await exists(u), false);
  });

  it('[RXCR2] a whole-backup restore is refused before anything is written; with --skip-conflicts the account is skipped', async function () {
    const u = await backedUpAccount();
    await platform.setUserCore(u.username, OTHER_CORE);

    const res = runCliMultiCore(['--restore', u.dir]);
    assert.notStrictEqual(res.status, 0, 'refused\n' + res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`Restore aborted: 1 conflict\\(s\\): ${u.username} \\(username "${u.username}" is routed to core "${OTHER_CORE}"`));
    assert.match(res.stderr, /Nothing was restored/);
    assert.strictEqual(await exists(u), false, 'not indexed on this core');

    const moved = path.join(tmpDir, u.username + '-done');
    const skipped = runCliMultiCore(['--restore', u.dir, '--skip-conflicts', '--move-on-success', moved]);
    assertOk(skipped, 'restore with --skip-conflicts');
    assert.match(skipped.stdout, /Restored: 0 users/);
    assert.match(skipped.stdout, new RegExp(`Skipped: 1 users\\s+- ${u.username}`));
    assert.match(skipped.stdout, new RegExp(`Conflicts: 1\\s+- ${u.username}: username "${u.username}" is routed to core "${OTHER_CORE}"`));
    assert.strictEqual(await exists(u), false, 'not indexed on this core');
    assert.strictEqual(await platform.getUserCore(u.username), OTHER_CORE, 'still routed to the other core');
    assert.ok(fs.existsSync(u.dir), 'nothing restored: the backup is not moved');
  });

  it('[RXCR3] an account whose name no core holds is restored and routed to this core; one routed here already is restored', async function () {
    const u = await backedUpAccount();
    assert.strictEqual(await platform.getUserCore(u.username), null, 'no routing row');

    const res = runCliMultiCore(['--restore', u.dir, '--user', u.username]);
    assertOk(res, 'restore');
    assert.match(res.stdout, /Restored: 1 users/);
    assert.strictEqual(await exists(u), true, 'indexed on this core');
    assert.strictEqual(await platform.getUserCore(u.username), THIS_CORE, 'routed to this core');

    const again = runCliMultiCore(['--restore', u.dir, '--user', u.username, '--overwrite']);
    assertOk(again, 'restore over the account routed here');
    assert.strictEqual(await exists(u), true);
    assert.strictEqual(await platform.getUserCore(u.username), THIS_CORE);
  });

  it('[RXCR4] on a single core, a routing row naming another core id does not refuse the restore', async function () {
    const u = await backedUpAccount();
    await platform.setUserCore(u.username, OTHER_CORE);

    const res = runCli(['--restore', u.dir, '--user', u.username]);
    assertOk(res, 'restore on a single core');
    assert.strictEqual(await exists(u), true, 'indexed on this core');
  });

  it('[RXCR5] a whole restore keeps a unique value another account holds now, and writes the free ones', async function () {
    const slug = cuid.slug().toLowerCase();
    const restored = 'rxcrr' + slug;
    const holder = 'rxcrh' + slug;
    const taken = restored + '-taken@rxcr.example';
    const free = restored + '-free@rxcr.example';
    const token = (name) => platform.hashFor('username', name);
    // The restored account's rows, as a backup holds them (storage form),
    // then removed: the platform as after the account's deletion.
    await platform.setUserUniqueField(restored, 'email', taken);
    await platform.setUserUniqueField(restored, 'email', free);
    await platformDB.setUserIndexedField(token(restored), 'language', 'fr');
    const backupRows = await platformDB.getAllForUser(token(restored));
    assert.strictEqual(backupRows.length, 3, JSON.stringify(backupRows));
    await platform.deleteUserUniqueField('email', taken);
    await platform.deleteUserUniqueField('email', free);
    await platformDB.deleteUserIndexedField(token(restored), 'language');
    // Another account took one of the emails meanwhile.
    await platform.setUserUniqueField(holder, 'email', taken);

    const reader = createBackupReader({
      async readManifest () { return { users: [], compressed: false }; },
      async * readPlatformData () { for (const row of backupRows) yield row; },
      async readServerMappings () { return (async function * () {})(); },
      async openUser () { throw new Error('no account in this backup'); },
      async close () {}
    });
    const o = await new RestoreOrchestrator().init();
    const warnings = [];
    o.logger = { info () {}, warn (msg) { warnings.push(msg); }, error () {}, debug () {} };
    try {
      const report = await o.restoreAllUsers(reader);
      assert.strictEqual(await platform.getUsersUniqueField('email', taken), token(holder), 'the holder keeps its email');
      assert.strictEqual(await platform.getUsersUniqueField('email', free), token(restored), 'a free email is restored');
      assert.strictEqual(await platformDB.getUserIndexedField(token(restored), 'language'), 'fr', 'indexed rows are restored');
      assert.strictEqual(report.uniqueValuesLost, 1);
      assert.ok(warnings.some((w) => /1 unique value\(s\) held by another account \(fields: email\)/.test(w)), warnings.join('\n'));
    } finally {
      await platform.deleteUserUniqueField('email', taken);
      await platform.deleteUserUniqueField('email', free);
      await platformDB.deleteUserIndexedField(token(restored), 'language');
    }
  });
});
