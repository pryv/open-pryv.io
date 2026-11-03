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
 * restored is left alone, and an erasure running now refuses the restore.
 */

/* global initTests, initCore, getNewFixture, assert, cuid */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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
      assert.ok(lines.some((l) => l.level === 'info' && l.msg.includes('nothing to complete') && l.msg.includes(u.username)), JSON.stringify(lines));
    } finally {
      await cleanUp(u);
    }
  });
});
