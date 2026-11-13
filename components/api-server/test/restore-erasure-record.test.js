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
 * [RSER] an account restored from a backup while the core still holds a
 * record of its erasure (an erasure that stopped at a step, or whose record
 * could not be removed): the restore withdraws that record, so the
 * auto-deletion sweep does not erase the restored account again and its CMC
 * background writes are accepted. The record of an account that is not
 * restored is left alone, and an erasure running now refuses the restore. A
 * restore that fails or is rolled back puts the withdrawn record back, and
 * an erasure whose record was withdrawn meanwhile stops.
 */

/* global initTests, initCore, getNewFixture, assert, cuid */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const sinon = require('sinon');
const { getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { getMall } = require('mall');
const { fromCallback } = require('utils');
const { childStorageEngineEnv } = require('test-helpers');
const { Deletion } = require('business/src/auth/deletion.ts');
const { getErasuresLocal } = require('business/src/auth/erasures.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { createAccountAutoDeletionSweep } = require('api-server/src/methods/helpers/autoDeletionSweep.ts');
const { cmcAccountStatus, cmcLoopUserIds, guardCmcBackgroundWrites } = require('api-server/src/methods/helpers/cmcMall.ts');
const RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator.ts').default;
const { createFilesystemBackupReader } = require('storages/interfaces/backup/index.ts');

const CLI = path.resolve(__dirname, '../../../bin/backup.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');
const STALE_MS = 16 * 60 * 1000;
const ALL_STEPS = ['runTeardownSteps', 'deleteUserFiles', 'deleteHFData', 'deleteAttachments', 'deleteAuditDataStorage', 'deleteUser', 'deleteAuditData', 'dropHFDataAgain'];

function runCli (args) {
  const env = { ...process.env, ...childStorageEngineEnv() };
  delete env.PRYV_BACKUP_PASSPHRASE;
  const res = spawnSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 90000 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function assertOk (res, what) {
  assert.strictEqual(res.status, 0, what + '\n' + res.stdout + res.stderr);
}

describe('[RSER] restore of an account with an erasure record', function () {
  this.timeout(300000);

  let config, storageLayer, usersRepository, tmpDir;
  const fixtures = [];

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();
    storageLayer = await getStorageLayer();
    usersRepository = await getUsersRepository();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-erasure-record-'));
  });

  after(async function () {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const f of fixtures) await f.clean();
  });

  /** An account with one stream holding one event, backed up with bin/backup.js. */
  async function backedUpAccount () {
    const fx = getNewFixture();
    fixtures.push(fx);
    const username = ('rser' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await fx.user(username);
    const streamId = 'rser-' + cuid().slice(-10);
    const stream = await fu.stream({ id: streamId, name: 'RSER ' + streamId });
    await stream.event({ type: 'note/txt', content: 'before the erasure' });
    const dir = path.join(tmpDir, username);
    assertOk(runCli(['--output', dir, '--user', username]), 'backup');
    return { id: fu.attrs.id, username, streamId, dir };
  }

  function restore (u) {
    return runCli(['--restore', u.dir, '--user', u.username, '--overwrite']);
  }

  async function streamIdsOf (u) {
    try {
      return (await fromCallback((cb) => storageLayer.streams.exportAll({ id: u.id }, cb))).map((s) => s.id);
    } catch (err) {
      if (err?.code === 'USER_ERASED' || /erased/.test(err?.message)) return [];
      throw err;
    }
  }

  async function exists (u) {
    return (await usersRepository.getUserIdForUsername(u.username)) === u.id;
  }

  /** An erasure that fails before the account's removal: its record stays, steps partly done. */
  async function stoppedErasure (u) {
    const fault = sinon.stub(Deletion.prototype, 'deleteAuditDataStorage').callsFake(function (context, params, result, next) { next(new Error('injected fault')); });
    let err = null;
    try {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' });
    } catch (e) {
      err = e;
    } finally {
      fault.restore();
    }
    assert.ok(err != null, 'the erasure stops at the injected fault');
    const record = await (await getErasuresLocal()).get(u.id);
    assert.ok(record != null && !record.doneSteps.includes('deleteUser'), 'an unfinished erasure is recorded: ' + JSON.stringify(record));
    await ageRecord(u);
  }

  /** As if the erasure had stopped long ago (a record must be idle for 15 minutes to be taken over). */
  async function ageRecord (u) {
    const store = await getErasuresLocal();
    const record = await store.get(u.id);
    if (record != null) await store.put({ ...record, updatedAt: record.updatedAt - STALE_MS });
  }

  /** A sweep that only completes the unfinished erasures of `users`. */
  async function completionPass (users, overrides = {}) {
    const ids = new Set(users.map((u) => u.id));
    const lines = [];
    const logger = {};
    for (const level of ['info', 'warn', 'error']) logger[level] = (msg) => lines.push({ level, msg });
    const sweep = await createAccountAutoDeletionSweep(config, {
      listAccounts: async () => [],
      listPendingErasures: async () => (await (await getErasuresLocal()).listAll()).filter((r) => ids.has(r.userId)),
      logger,
      ...overrides
    });
    const result = await sweep.runPass();
    return { result, lines };
  }

  /** A CMC background write for `u`, through the guarded mall: null when accepted, the refusal otherwise. */
  async function backgroundWrite (u) {
    const mall = guardCmcBackgroundWrites(await getMall());
    try {
      await mall.streams.create(u.id, { id: 'rser-bg-' + cuid().slice(-10), name: 'RSER background ' + cuid().slice(-6), parentId: null });
      return null;
    } catch (err) {
      return err;
    }
  }

  const EXPECTED = {
    cmcStatus: 'active',
    cmcLoopVisits: true,
    cmcBackgroundWriteRefused: null,
    sweepCompleted: 0,
    sweepFailed: 0,
    accountExists: true,
    dataKept: true,
    erasureRecord: null
  };

  /**
   * What holds for a restored account: the CMC background work runs for it,
   * then an auto-deletion pass (its record, if any, aged past the takeover
   * delay) leaves it alone.
   */
  async function afterRestore (u) {
    const cmcStatus = await cmcAccountStatus(u.id);
    const cmcLoopVisits = (await cmcLoopUserIds()).includes(u.id);
    const refused = await backgroundWrite(u);
    await ageRecord(u);
    const { result } = await completionPass([u]);
    return {
      cmcStatus,
      cmcLoopVisits,
      cmcBackgroundWriteRefused: refused?.message ?? null,
      sweepCompleted: result.completed,
      sweepFailed: result.failed,
      accountExists: await exists(u),
      dataKept: (await streamIdsOf(u)).includes(u.streamId),
      erasureRecord: await (await getErasuresLocal()).get(u.id)
    };
  }

  /** Erase `u` for good, whatever state the test left it in. */
  async function cleanUp (u) {
    const store = await getErasuresLocal();
    await store.delete(u.id);
    if (await exists(u)) await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { teardown: false });
    await store.delete(u.id);
  }

  async function recordOf (u) {
    return (await getErasuresLocal()).get(u.id);
  }

  /** `record` is `before` put back by a failed restore: every step to run again, its last update kept. */
  function assertPutBack (record, before) {
    assert.ok(record != null, 'the erasure record is put back');
    assert.match(String(record.lastError), /^restore failed: /);
    assert.deepEqual({ ...record, lastError: null }, { ...before, doneSteps: [], lastError: null });
  }

  /** Rewrites the events file(s) of `u`'s backup with `change(text)`. */
  function breakBackupEvents (u, change) {
    const files = fs.readdirSync(u.dir, { recursive: true }).map(String).filter((f) => /(^|\/)events-[0-9]+\.jsonl(\.gz)?$/.test(f));
    assert.ok(files.length > 0, 'events file of the backup');
    for (const f of files) {
      const file = path.join(u.dir, f);
      const gz = f.endsWith('.gz');
      const text = gz ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
      const out = Buffer.from(change(text), 'utf8');
      fs.writeFileSync(file, gz ? zlib.gzipSync(out) : out);
      relistInRunTable(u.dir, f);
    }
  }

  /**
   * List the rewritten file in its run's file table (a plaintext run): the
   * backup is then one written that way, whose content fails later, not one
   * whose files were changed after it was written.
   */
  function relistInRunTable (backupDir, f) {
    const parts = f.split(path.sep);
    const [runDir, rel] = parts[0] === 'incrementals' ? [path.join(backupDir, parts[0], parts[1]), parts.slice(2).join('/')] : [backupDir, parts.join('/')];
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bytes = fs.readFileSync(path.join(runDir, ...rel.split('/')));
    const entry = manifest.integrity.files.find((e) => e.path === rel);
    entry.size = bytes.length;
    entry.sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  /** A restore orchestrator of this process, its log lines captured. */
  async function orchestrator () {
    const o = await new RestoreOrchestrator().init();
    const lines = [];
    o.logger = {};
    for (const level of ['debug', 'info', 'warn', 'error']) o.logger[level] = (msg) => lines.push({ level, msg });
    return { o, lines };
  }

  /** The backups of `users` as one (platform rows aside); `failOn`'s data cannot be read. */
  async function combinedReader (users, failOn = null) {
    const readers = users.map((u) => createFilesystemBackupReader(u.dir));
    const manifests = [];
    for (const r of readers) manifests.push(await r.readManifest());
    return {
      async readManifest () { return { ...manifests[0], users: manifests.flatMap((m) => m.users) }; },
      async openUser (userId) {
        if (failOn != null && userId === failOn.id) throw new Error('injected backup read error');
        return readers[users.findIndex((u) => u.id === userId)].openUser(userId);
      },
      async * readPlatformData () {},
      async * readServerMappings () {},
      async close () { for (const r of readers) await r.close(); }
    };
  }

  it('[RSER1] an erased account whose erasure record was left behind is restored: the record goes, its CMC background writes are accepted', async function () {
    const u = await backedUpAccount();
    try {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' });
      assert.equal(await exists(u), false);
      // as if the removal of the record had failed after the last step
      const store = await getErasuresLocal();
      const now = Date.now() - STALE_MS;
      await store.put({ userId: u.id, username: u.username, trigger: 'date', startedAt: now, updatedAt: now, doneSteps: ALL_STEPS, seriesNamespaces: null, attempts: 1, lastError: null });

      const res = restore(u);
      assertOk(res, 'restore');
      assert.match(res.stdout, /Restored: 1 users/);
      assert.ok(await exists(u), 'the account is back');
      assert.deepEqual(await afterRestore(u), EXPECTED);
    } finally {
      await cleanUp(u);
    }
  });

  it('[RSER2] an account whose erasure stopped half way is restored: the auto-deletion sweep does not erase it again, its CMC background writes are accepted', async function () {
    const u = await backedUpAccount();
    try {
      await stoppedErasure(u);
      assert.equal(await cmcAccountStatus(u.id), 'erasing', 'control: the stopped erasure pauses the CMC background work');

      assertOk(restore(u), 'restore');
      assert.deepEqual(await afterRestore(u), EXPECTED);
    } finally {
      await cleanUp(u);
    }
  });

  it('[RSER3] the restore leaves alone the erasure record of an account it does not restore: that erasure is still completed', async function () {
    const restored = await backedUpAccount();
    const other = await backedUpAccount();
    try {
      await stoppedErasure(restored);
      await stoppedErasure(other);
      assertOk(restore(restored), 'restore');
      assert.equal(await (await getErasuresLocal()).get(restored.id), null);
      assert.ok(await (await getErasuresLocal()).get(other.id) != null, 'the other account\'s record is kept');
      assert.equal(await cmcAccountStatus(other.id), 'erasing');

      const { result, lines } = await completionPass([restored, other]);
      assert.equal(result.completed, 1, JSON.stringify(lines));
      assert.equal(await exists(other), false, 'the other account\'s erasure is completed');
      assert.equal(await (await getErasuresLocal()).get(other.id), null);
      assert.ok(await exists(restored));
    } finally {
      await cleanUp(restored);
      await cleanUp(other);
    }
  });

  it('[RSER4] an erasure running now refuses the restore of its account: nothing is restored, the record is kept', async function () {
    const u = await backedUpAccount();
    const store = await getErasuresLocal();
    try {
      // a stream created after the backup: an overwriting restore would remove it
      const later = 'rser-later-' + cuid().slice(-8);
      await fromCallback((cb) => storageLayer.streams.insertOne({ id: u.id }, { id: later, name: 'RSER later ' + later, parentId: null }, cb));
      const now = Date.now();
      assert.ok(await store.insertIfAbsent({ userId: u.id, username: u.username, trigger: 'admin', startedAt: now, updatedAt: now, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null }));

      const res = restore(u);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stderr, /an erasure of the account is running now for /);
      assert.doesNotMatch(res.stdout, /Restored:/);
      assert.ok((await streamIdsOf(u)).includes(later), 'nothing restored');
      assert.ok(await store.get(u.id) != null, 'the record is kept');
    } finally {
      await cleanUp(u);
    }
  });

  it('[RSER5] an unfinished erasure listed by the sweep but withdrawn before its turn is not started again', async function () {
    const u = await backedUpAccount();
    try {
      // the sweep read the record, then a restore withdrew it
      const listed = [{ userId: u.id, username: u.username, trigger: 'date', updatedAt: Date.now() - STALE_MS }];
      const { result, lines } = await completionPass([u], { listPendingErasures: async () => listed });
      assert.equal(result.completed, 0, JSON.stringify(lines));
      assert.equal(result.failed, 0, JSON.stringify(lines));
      assert.ok(await exists(u), 'the account is not erased');
      assert.ok((await streamIdsOf(u)).includes(u.streamId), 'with its data');
      assert.equal(await (await getErasuresLocal()).get(u.id), null, 'no erasure started');
      assert.ok(lines.some((l) => l.level === 'warn' && l.msg.includes('nothing erased') && l.msg.includes(u.username)), JSON.stringify(lines));
    } finally {
      await cleanUp(u);
    }
  });

  it('[RSER6] a restore without --overwrite of an account that still exists is refused before its unfinished erasure is touched: that erasure is still completed', async function () {
    const u = await backedUpAccount();
    try {
      await stoppedErasure(u);
      const before = await recordOf(u);

      const res = runCli(['--restore', u.dir, '--user', u.username]);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      assert.deepEqual(await recordOf(u), before, 'the record is untouched');
      assert.match(res.stderr, /exists on this core: use --overwrite to replace it/);

      const { result, lines } = await completionPass([u]);
      assert.equal(result.completed, 1, JSON.stringify(lines));
      assert.equal(await exists(u), false, 'the erasure is completed');
    } finally {
      await cleanUp(u);
    }
  });

  it('[RSER7] a restore that fails after withdrawing an unfinished erasure puts it back, every step to run again: the next pass completes it', async function () {
    const u = await backedUpAccount();
    try {
      await stoppedErasure(u);
      const before = await recordOf(u);
      breakBackupEvents(u, () => 'not a backup line\n');

      const res = restore(u);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      assertPutBack(await recordOf(u), before);

      const { result, lines } = await completionPass([u]);
      assert.equal(result.completed, 1, JSON.stringify(lines));
      assert.equal(await exists(u), false, 'the erasure is completed');
    } finally {
      await cleanUp(u);
    }
  });

  it('[RSER8] an account rolled back by --verify-integrity gets back the unfinished erasure the restore withdrew', async function () {
    const u = await backedUpAccount();
    try {
      await stoppedErasure(u);
      const before = await recordOf(u);
      // the event no longer matches its integrity
      breakBackupEvents(u, (text) => text.split('\n').map((line) => {
        if (line.trim() === '') return line;
        const event = JSON.parse(line);
        return JSON.stringify({ ...event, content: 'tampered' });
      }).join('\n'));

      const res = runCli(['--restore', u.dir, '--user', u.username, '--overwrite', '--verify-integrity']);
      assert.strictEqual(res.status, 1, res.stdout + res.stderr);
      // The account was still indexed (its erasure stopped before removing
      // it): the rollback empties it, the put-back erasure completes it.
      assert.match(res.stderr, new RegExp(`rolled back ${u.username} \\(${u.id}\\): EMPTIED, NOT REMOVED`));
      assert.doesNotMatch(res.stdout, /Unfinished erasures withdrawn/);
      assertPutBack(await recordOf(u), before);

      const { result, lines } = await completionPass([u]);
      assert.equal(result.completed, 1, JSON.stringify(lines));
      assert.equal(await exists(u), false, 'the erasure is completed');
    } finally {
      await cleanUp(u);
    }
  });

  it('[RSER9] a whole-backup restore withdraws the unfinished erasures of the accounts it restores and lists them in its report', async function () {
    const a = await backedUpAccount();
    const b = await backedUpAccount();
    try {
      await stoppedErasure(a);
      const { o, lines } = await orchestrator();
      const reader = await combinedReader([a, b]);
      const report = await o.restoreAllUsers(reader, { overwrite: true, skipPlatform: true });
      await reader.close();
      assert.deepEqual(report.restored.map((r) => r.userId).sort(), [a.id, b.id].sort());
      assert.deepEqual(report.erasuresWithdrawn.map((r) => r.userId), [a.id]);
      assert.ok(lines.some((l) => l.level === 'info' && l.msg.includes('Restore complete: 2 restored, 0 skipped, 1 unfinished erasure(s) withdrawn')), JSON.stringify(lines));
      assert.ok(lines.some((l) => l.level === 'warn' && l.msg.includes('is withdrawn') && l.msg.includes(a.username)), JSON.stringify(lines));
      assert.deepEqual(await afterRestore(a), EXPECTED);
    } finally {
      await cleanUp(a);
      await cleanUp(b);
    }
  });

  it('[RSER10] a whole-backup restore with an erasure running for one of its accounts is refused before anything is written, every record kept', async function () {
    const a = await backedUpAccount();
    const b = await backedUpAccount();
    const store = await getErasuresLocal();
    try {
      await stoppedErasure(a);
      const before = await recordOf(a);
      const later = 'rser-later-' + cuid().slice(-8);
      await fromCallback((cb) => storageLayer.streams.insertOne({ id: a.id }, { id: later, name: 'RSER later ' + later, parentId: null }, cb));
      const now = Date.now();
      assert.ok(await store.insertIfAbsent({ userId: b.id, username: b.username, trigger: 'holder', startedAt: now, updatedAt: now, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null }));

      const { o } = await orchestrator();
      const reader = await combinedReader([a, b]);
      try {
        await assert.rejects(o.restoreAllUsers(reader, { overwrite: true, skipPlatform: true }), new RegExp('an erasure of the account is running now for ' + b.username));
      } finally {
        await reader.close();
      }
      assert.deepEqual(await recordOf(a), before, 'nothing withdrawn');
      assert.ok(await recordOf(b) != null);
      assert.ok((await streamIdsOf(a)).includes(later), 'nothing restored');
    } finally {
      await cleanUp(a);
      await cleanUp(b);
    }
  });

  it('[RSER11] a whole-backup restore that fails at a later account puts back the erasure of that account only: the accounts restored before keep their withdrawal', async function () {
    const a = await backedUpAccount();
    const b = await backedUpAccount();
    try {
      await stoppedErasure(a);
      await stoppedErasure(b);
      const beforeB = await recordOf(b);

      const { o, lines } = await orchestrator();
      const reader = await combinedReader([a, b], b);
      try {
        await assert.rejects(o.restoreAllUsers(reader, { overwrite: true, skipPlatform: true }), /injected backup read error/);
      } finally {
        await reader.close();
      }
      assert.equal(await recordOf(a), null, 'the withdrawal of a restored account stands');
      assertPutBack(await recordOf(b), beforeB);
      assert.ok(lines.some((l) => l.level === 'error' && l.msg.includes('restored before it are kept') && l.msg.includes(a.username)), JSON.stringify(lines));
      assert.ok(lines.some((l) => l.level === 'error' && l.msg.includes('is put back') && l.msg.includes(b.username)), JSON.stringify(lines));
      assert.ok(!lines.some((l) => l.msg.includes('is put back') && l.msg.includes(a.username)), JSON.stringify(lines));

      const { result } = await completionPass([a, b]);
      assert.equal(result.completed, 1);
      assert.equal(await exists(a), true, 'the restored account is not erased');
      assert.equal(await exists(b), false);
      assert.deepEqual(await afterRestore(a), EXPECTED);
    } finally {
      await cleanUp(a);
      await cleanUp(b);
    }
  });

  it('[RSER12] a restore under another user id withdraws the erasure record of that id, not the one of the backed-up id', async function () {
    const u = await backedUpAccount();
    const target = { id: 'rsertgt' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-12), username: u.username };
    const store = await getErasuresLocal();
    try {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' });
      // records left behind after the last step, of both ids
      const old = Date.now() - STALE_MS;
      for (const userId of [u.id, target.id]) {
        await store.put({ userId, username: u.username, trigger: 'date', startedAt: old, updatedAt: old, doneSteps: ALL_STEPS, seriesNamespaces: null, attempts: 1, lastError: null });
      }

      const { o } = await orchestrator();
      const reader = createFilesystemBackupReader(u.dir);
      const report = await o.restoreUser(u.id, reader, { overwrite: true, remapUserId: target.id });
      await reader.close();
      assert.deepEqual(report.erasuresWithdrawn.map((r) => r.userId), [target.id]);
      assert.equal(await store.get(target.id), null);
      assert.ok(await store.get(u.id) != null, 'the record of the backed-up id is kept');
      assert.ok(await exists(target));
    } finally {
      await cleanUp(target);
      await cleanUp(u);
    }
  });

  it('[RSER13] a completion that finds the record taken over since it was listed (a restore claimed it first) erases nothing and counts no failure', async function () {
    const u = await backedUpAccount();
    try {
      await stoppedErasure(u);
      const listed = await recordOf(u);
      // a restore takes the record over (its compare-and-set), not removed yet
      assert.ok(await (await getErasuresLocal()).claim(u.id, listed.updatedAt, Date.now()));

      const { result, lines } = await completionPass([u], { listPendingErasures: async () => [listed] });
      assert.equal(result.completed, 0, JSON.stringify(lines));
      assert.equal(result.failed, 0, JSON.stringify(lines));
      assert.ok(lines.some((l) => l.level === 'warn' && l.msg.includes('nothing erased') && l.msg.includes(u.username)), JSON.stringify(lines));
      assert.ok(!lines.some((l) => l.level === 'error'), JSON.stringify(lines));
      assert.ok(await exists(u));
      assert.ok(await recordOf(u) != null, 'the record is the restore\'s to remove');
    } finally {
      await cleanUp(u);
    }
  });

  it('[RSER14] an erasure that goes on after its record was withdrawn (its process frozen past the takeover delay, the account restored) stops: no record written back, no further step', async function () {
    const u = await backedUpAccount();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const atStep = new Promise((resolve) => { reached = resolve; });
    const original = Deletion.prototype.deleteAttachments;
    const pause = sinon.stub(Deletion.prototype, 'deleteAttachments').callsFake(function (...args) {
      reached();
      return gate.then(() => original.apply(this, args));
    });
    try {
      const erasure = new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' }).then(() => null, (err) => err);
      await atStep;
      // meanwhile: the record went stale, a restore took it over and removed it
      await (await getErasuresLocal()).delete(u.id);
      release();
      const err = await erasure;
      assert.ok(await exists(u), 'no step after the withdrawal: the account is not removed');
      assert.ok((await streamIdsOf(u)).includes(u.streamId), 'with its data');
      assert.equal(await recordOf(u), null, 'no record written back');
      assert.match(String(err?.message), /withdrawn or taken over meanwhile/);
    } finally {
      pause.restore();
      await cleanUp(u);
    }
  });

  it('[RSER15] a restore that loses the record to an erasure resumed meanwhile fails for that account and removes nothing', async function () {
    const o = Object.create(RestoreOrchestrator.prototype);
    const stale = { userId: 'rserx', username: 'rserx', trigger: 'date', startedAt: 0, updatedAt: Date.now() - STALE_MS, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null };
    const removed = [];
    o.erasures = { get: async () => stale, claim: async () => false, delete: async (id) => { removed.push(id); return true; }, insertIfAbsent: async () => true };
    o.staleErasureMs = 15 * 60 * 1000;
    o.logger = { info () {}, warn () {}, error () {} };
    await assert.rejects(o._withdrawStoppedErasure('rserx', 'rserx'), /an erasure of this account is running now/);
    assert.deepEqual(removed, []);
  });
});
