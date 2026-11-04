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
const zlib = require('node:zlib');
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

  // Before the per-test platform consistency check: the restored accounts and
  // their platform rows are removed.
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
  async function backedUpAccount (attrs = {}, beforeBackup = async () => {}) {
    const fx = getNewFixture();
    fixtures.push(fx);
    const username = ('rxcr' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await fx.user(username, attrs);
    const stream = await fu.stream({ id: 'rxcr-' + cuid().slice(-10), name: 'RXCR ' + cuid().slice(-6) });
    await stream.event({ type: 'note/txt', content: 'backed up' });
    await beforeBackup(username);
    const dir = path.join(tmpDir, username);
    assertOk(runCli(['--output', dir, '--user', username]), 'backup');
    // Its platform rows as its registration wrote them (storage form).
    const rows = await platformDB.getAllForUser(platform.hashFor('username', username));
    const u = { id: fu.attrs.id, username, dir, rows };
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

    const whole = runCliMultiCore(['--restore', u.dir, '--overwrite']);
    assertOk(whole, 'whole-backup restore over the account routed here');
    assert.match(whole.stdout, /Restored: 1 users/);
    assert.strictEqual(await platform.getUserCore(u.username), THIS_CORE);
  });

  it('[RXCR4] on a single core, a routing row naming another core id does not refuse the restore', async function () {
    const u = await backedUpAccount();
    await platform.setUserCore(u.username, OTHER_CORE);

    const res = runCli(['--restore', u.dir, '--user', u.username]);
    assertOk(res, 'restore on a single core');
    assert.strictEqual(await exists(u), true, 'indexed on this core');
    // Routed to the CLI's own core id: the one this process runs as (the
    // suites before this one put back the core id they changed).
    assert.strictEqual(await platform.getUserCore(u.username), platform.coreId, 'routed to the restoring core');
  });

  it('[RXCR5] a platform restore keeps a unique value another account holds now, and writes the free ones', async function () {
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
      await o.restorePlatform(reader);
      assert.strictEqual(await platform.getUsersUniqueField('email', taken), token(holder), 'the holder keeps its email');
      assert.strictEqual(await platform.getUsersUniqueField('email', free), token(restored), 'a free email is restored');
      assert.strictEqual(await platformDB.getUserIndexedField(token(restored), 'language'), 'fr', 'indexed rows are restored');
      assert.ok(warnings.some((w) => /1 unique value\(s\) held by another account \(fields: email\)/.test(w)), warnings.join('\n'));
    } finally {
      await platform.deleteUserUniqueField('email', taken);
      await platform.deleteUserUniqueField('email', free);
      await platformDB.deleteUserIndexedField(token(restored), 'language');
    }
  });

  it('[RXCR18] a single-account restore of a backup of that account reserves its email and writes its indexed values; an email another account holds now stays with it and the account is listed', async function () {
    const token = (name) => platform.hashFor('username', name);
    const email = 'rxcr18-' + cuid.slug().toLowerCase() + '@rxcr.example';
    const u = await backedUpAccount({ email, language: 'fr' });
    assert.strictEqual(await platform.getUsersUniqueField('email', email), null, 'removed with the account');

    const res = runCliMultiCore(['--restore', u.dir, '--user', u.username]);
    assertOk(res, 'restore');
    assert.strictEqual(await platform.getUsersUniqueField('email', email), token(u.username), 'its email is reserved for it');
    assert.strictEqual(await platformDB.getUserIndexedField(token(u.username), 'language'), 'fr', 'its indexed values are written');
    assert.doesNotMatch(res.stdout, /Email held by another account/);

    // An account restored by a release that wrote no email row: a restore
    // over it with --overwrite writes the row.
    await platform.deleteUserUniqueField('email', email);
    const over = runCliMultiCore(['--restore', u.dir, '--user', u.username, '--overwrite']);
    assertOk(over, 'restore with --overwrite');
    assert.strictEqual(await platform.getUsersUniqueField('email', email), token(u.username), 'the row is written again');

    // The email of another backed-up account changed hands meanwhile.
    const heldEmail = 'rxcr18h-' + cuid.slug().toLowerCase() + '@rxcr.example';
    const v = await backedUpAccount({ email: heldEmail });
    const holder = 'rxcrholder' + cuid.slug().toLowerCase();
    await platform.setUserUniqueField(holder, 'email', heldEmail);
    try {
      const held = runCliMultiCore(['--restore', v.dir, '--user', v.username]);
      assertOk(held, 'restore with a held email');
      assert.strictEqual(await exists(v), true, 'restored');
      assert.strictEqual(await platform.getUsersUniqueField('email', heldEmail), token(holder), 'the holder keeps its email');
      assert.match(held.stdout, /Unique values of the platform rows: 1 held by another account/);
      assert.match(held.stdout, new RegExp(`Email held by another account \\(password reset does not send to it until the account's email is changed\\): 1 users\\s+- ${v.username} \\(${v.id}\\)`));
    } finally {
      await platform.deleteUserUniqueField('email', heldEmail);
    }
  });

  /** Rewrites the events of `u`'s backup so that they no longer match their integrity. */
  function tamperBackupEvents (u) {
    const files = fs.readdirSync(u.dir, { recursive: true }).map(String).filter((f) => /(^|\/)events-[0-9]+\.jsonl(\.gz)?$/.test(f));
    assert.ok(files.length > 0, 'events file of the backup');
    for (const f of files) {
      const file = path.join(u.dir, f);
      const gz = f.endsWith('.gz');
      const text = gz ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
      const out = Buffer.from(text.split('\n').map((line) => line.trim() === '' ? line : JSON.stringify({ ...JSON.parse(line), content: 'tampered' })).join('\n'), 'utf8');
      fs.writeFileSync(file, gz ? zlib.gzipSync(out) : out);
    }
  }

  it('[RXCR24] an account rolled back by --verify-integrity is removed with its routing row, its platform rows and its index entry; a value another account holds stays with it', async function () {
    const token = (name) => platform.hashFor('username', name);
    const slug = () => cuid.slug().toLowerCase();
    const rolledBack = async (u, args) => {
      const res = runCliMultiCore(['--restore', u.dir, '--user', u.username, '--verify-integrity', ...args]);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, new RegExp(`Rolled back: ${u.username} \\(${u.id}\\), the account removed`));
      assert.strictEqual(await exists(u), false, 'not indexed on this core');
      assert.strictEqual(await platform.getUserCore(u.username), null, 'its routing row is removed: the name is free');
      assert.deepStrictEqual(await platformDB.getAllForUser(token(u.username)), [], 'no platform row of the account is left');
    };

    const email = 'rxcr24-' + slug() + '@rxcr.example';
    const u = await backedUpAccount({ email, language: 'fr' });
    tamperBackupEvents(u);
    await rolledBack(u, []);
    assert.strictEqual(await platform.getUsersUniqueField('email', email), null, 'its email is free again');

    // Its email changed hands since the backup: the holder keeps it.
    const heldEmail = 'rxcr24h-' + slug() + '@rxcr.example';
    const v = await backedUpAccount({ email: heldEmail });
    const holder = 'rxcrholder' + slug();
    await platform.setUserUniqueField(holder, 'email', heldEmail);
    try {
      tamperBackupEvents(v);
      await rolledBack(v, []);
      assert.strictEqual(await platform.getUsersUniqueField('email', heldEmail), token(holder), 'the holder keeps its email');
    } finally {
      await platform.deleteUserUniqueField('email', heldEmail);
    }

    // Over the account restored before (--overwrite): the account, whose data
    // the restore cleared, is removed as well.
    const w = await backedUpAccount({ email: 'rxcr24w-' + slug() + '@rxcr.example' });
    // (Not read from this process before the rollback: its users index cache
    // would keep the name the other process removes.)
    assert.match(runCliMultiCore(['--restore', w.dir, '--user', w.username]).stdout, /Restored: 1 users/);
    tamperBackupEvents(w);
    await rolledBack(w, ['--overwrite']);
  });

  it('[RXCR27] a single-account backup carries the account\'s SSO bindings and a single-account restore links them again; a binding another account holds now stays with it', async function () {
    const token = (name) => platform.hashFor('username', name);
    const sub = 'rxcr27-' + cuid.slug().toLowerCase();
    const takenSub = 'rxcr27t-' + cuid.slug().toLowerCase();
    const holder = 'rxcrholder' + cuid.slug().toLowerCase();
    const u = await backedUpAccount({}, async (username) => {
      assert.strictEqual(await platform.reserveUserUniqueValue(username, 'sso-rxcr', sub), true);
      assert.strictEqual(await platform.reserveUserUniqueValue(username, 'sso-rxcrb', takenSub), true);
    });
    try {
      assert.strictEqual(await platform.getUsersUniqueField('sso-rxcr', sub), null, 'released with the account');
      // One of its bindings changed hands meanwhile.
      await platform.setUserUniqueField(holder, 'sso-rxcrb', takenSub);

      const res = runCli(['--restore', u.dir, '--user', u.username]);
      assertOk(res, 'restore');
      assert.strictEqual(await exists(u), true);
      assert.strictEqual(await platform.getUsersUniqueField('sso-rxcr', sub), token(u.username), 'its binding is linked again');
      assert.strictEqual(await platform.getUsersUniqueField('sso-rxcrb', takenSub), token(holder), 'the holder keeps its binding');
      assert.match(res.stdout, /Unique values of the platform rows: 1 held by another account/);
    } finally {
      await platform.deleteUserUniqueField('sso-rxcr', sub);
      await platform.deleteUserUniqueField('sso-rxcrb', takenSub);
    }
  });

  it('[RXCR19] the platform rows a single-account restore derives are the rows its registration wrote', async function () {
    const u = await backedUpAccount({ email: 'rxcr19-' + cuid.slug().toLowerCase() + '@rxcr.example', language: 'de' });
    assert.ok(u.rows.length > 0, 'registration wrote rows');
    const res = runCliMultiCore(['--restore', u.dir, '--user', u.username]);
    assertOk(res, 'restore');
    const sorted = (rows) => rows.map((r) => JSON.stringify([r.field, r.isUnique, r.value, r.username])).sort();
    const restored = await platformDB.getAllForUser(platform.hashFor('username', u.username));
    assert.deepStrictEqual(sorted(restored), sorted(u.rows));
    // Registration writes no `username` row (the name is routed by its user-core row).
    assert.ok(!restored.some((r) => r.field === 'username'), JSON.stringify(restored));
  });

  it('[RXCR20] the email row reconcile (usersRepository.reconcileEmailRows, bin/reconcile-user-cores.js --emails) claims the missing email rows of this core\'s accounts and lists those another account holds', async function () {
    // The command line: a dry run reports; combined with --ext-ids it is refused.
    const reconcile = (args) => spawnSync('node', [path.resolve(__dirname, '../../../bin/reconcile-user-cores.js'), ...args],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...childStorageEngineEnv() }, timeout: 90000 });
    const dryCli = reconcile(['--emails', '--dry-run']);
    assert.strictEqual(dryCli.status, 0, dryCli.stdout + dryCli.stderr);
    assert.match(dryCli.stdout, /reconcile-user-cores --emails: DRY-RUN \(no writes\)/);
    const both = reconcile(['--emails', '--ext-ids']);
    assert.strictEqual(both.status, 1, both.stdout + both.stderr);
    assert.match(both.stderr, /--emails and --ext-ids are separate passes/);

    const token = (name) => platform.hashFor('username', name);
    const slug = cuid.slug().toLowerCase();
    const fx = getNewFixture();
    fixtures.push(fx);
    const missing = { username: 'rxcrmiss' + slug, email: 'rxcr20m-' + slug + '@rxcr.example' };
    const held = { username: 'rxcrheld' + slug, email: 'rxcr20h-' + slug + '@rxcr.example' };
    const holder = 'rxcrhold' + slug;
    for (const a of [missing, held]) a.id = (await fx.user(a.username, { email: a.email })).attrs.id;
    // As restored by a release that wrote no email row; the other address changed hands.
    await platform.deleteUserUniqueField('email', missing.email);
    await platform.deleteUserUniqueField('email', held.email);
    await platform.setUserUniqueField(holder, 'email', held.email);
    try {
      const dry = await usersRepository.reconcileEmailRows(true);
      assert.ok(dry.missing.includes(missing.username) && dry.heldElsewhere.includes(held.username), JSON.stringify(dry));
      assert.strictEqual(await platform.getUsersUniqueField('email', missing.email), null, 'a dry run writes nothing');

      const applied = await usersRepository.reconcileEmailRows(false);
      assert.ok(applied.claimed.includes(missing.username), JSON.stringify(applied));
      assert.ok(applied.heldElsewhere.includes(held.username), JSON.stringify(applied));
      assert.strictEqual(await platform.getUsersUniqueField('email', missing.email), token(missing.username), 'the missing row is claimed');
      assert.strictEqual(await platform.getUsersUniqueField('email', held.email), token(holder), 'a held row is never taken');
    } finally {
      await platform.deleteUserUniqueField('email', held.email);
      await platform.setUserUniqueField(held.username, 'email', held.email);
      for (const a of [missing, held]) await usersRepository.deleteOne(a.id, a.username);
    }
  });
});
