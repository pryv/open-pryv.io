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
 * [AARS] the record of an account's restore from a backup, in the restored
 * account's trail, written once the restore keeps the account; and, where the
 * trails outlive the accounts (`audit.onUserDelete: keep`), a restore that
 * keeps the trail it finds.
 */

/* global initTests, initCore, getNewFixture, assert, cuid, sinon */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { childStorageEngineEnv, withInjectedConfig } = require('test-helpers');
const { Deletion } = require('business/src/auth/deletion.ts');
const { getErasuresLocal } = require('business/src/auth/erasures.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const ledger = require('business/src/erasureLedger/index.ts');
const RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator.ts').default;
const { createFilesystemBackupReader } = require('storages/interfaces/backup/index.ts');

const CLI = path.resolve(__dirname, '../../../bin/backup.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');
const STALE_MS = 16 * 60 * 1000;

function runCli (args) {
  const env = { ...process.env, ...childStorageEngineEnv() };
  delete env.PRYV_BACKUP_PASSPHRASE;
  const res = spawnSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 90000 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function assertOk (res, what) {
  assert.strictEqual(res.status, 0, what + '\n' + res.stdout + res.stderr);
}

describe('[AARS] audit record of an account restore', function () {
  this.timeout(300000);

  let config, storageLayer, usersRepository, audit, auditStorage, originalForUser, lossCounter, platform, key, userLocalDirectory, tmpDir;
  const fixtures = [];
  const cleanups = [];

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();
    if (config.get('audit:active') !== true) this.skip();
    storageLayer = await getStorageLayer();
    usersRepository = await getUsersRepository();
    audit = require('audit').default;
    auditStorage = require('storages').auditStorage;
    originalForUser = auditStorage.forUser;
    lossCounter = require('audit/src/lossCounter.ts');
    platform = await require('platform').getPlatform();
    key = ledger.ledgerKey(config);
    userLocalDirectory = require('storage').userLocalDirectory;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-account-restored-'));
  });

  afterEach(function () {
    if (auditStorage != null) auditStorage.forUser = originalForUser;
    sinon.restore();
  });

  after(async function () {
    for (const u of cleanups) {
      try { await cleanUp(u); } catch (_e) { /* best-effort */ }
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const f of fixtures) {
      try { await f.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  function auditRow (action = 'mfa.recovered') {
    return { streamIds: [':_audit:action-' + action], type: 'audit-log/mfa', time: Date.now() / 1000, created: Date.now() / 1000, createdBy: 'system', modified: Date.now() / 1000, modifiedBy: 'system', content: { action, source: { name: 'test' } } };
  }

  /** An account with a stream, an event and one audit record, backed up with bin/backup.js. */
  async function backedUpAccount () {
    const fx = getNewFixture();
    fixtures.push(fx);
    const username = ('aars' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await fx.user(username);
    const streamId = 'aars-' + cuid().slice(-10);
    const stream = await fu.stream({ id: streamId, name: 'AARS ' + streamId });
    await stream.event({ type: 'note/txt', content: 'before the backup' });
    await audit.eventForUser(fu.attrs.id, auditRow());
    const dir = path.join(tmpDir, username);
    assertOk(runCli(['--output', dir, '--user', username]), 'backup');
    const u = { id: fu.attrs.id, username, streamId, dir };
    cleanups.push(u);
    return u;
  }

  async function exists (u) {
    return (await usersRepository.getUserIdForUsername(u.username)) === u.id;
  }

  async function cleanUp (u) {
    const store = await getErasuresLocal();
    await store.delete(u.id);
    if (await exists(u)) await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { teardown: false });
    await store.delete(u.id);
    await platform.deletePlatformKv(ledger.LEDGER_PREFIX + ledger.userIdHash(key, u.id));
    await auditStorage.deleteUser(u.id);
    await userLocalDirectory.deleteUserDirectory(u.id);
  }

  async function erase (u) {
    await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'admin' });
    assert.equal(await exists(u), false);
  }

  /** A restore orchestrator of this process, its log lines captured. */
  async function orchestrator () {
    const o = await new RestoreOrchestrator().init();
    const lines = [];
    o.logger = {};
    for (const level of ['debug', 'info', 'warn', 'error']) o.logger[level] = (msg) => lines.push({ level, msg });
    return { o, lines };
  }

  /** `u`'s backup, its manifest changed by `change`. */
  function readerOf (u, change = null) {
    const reader = createFilesystemBackupReader(u.dir);
    if (change == null) return reader;
    return {
      async readManifest () { return change(await reader.readManifest()); },
      openUser: (id) => reader.openUser(id),
      readPlatformData: () => reader.readPlatformData(),
      readServerMappings: () => reader.readServerMappings(),
      close: () => reader.close()
    };
  }

  async function restoreUser (u, options, change = null) {
    const { o, lines } = await orchestrator();
    const reader = readerOf(u, change);
    try {
      return { report: await o.restoreUser(u.id, reader, { skipPlatform: true, ...options }), lines };
    } finally {
      await reader.close();
    }
  }

  async function trail (userId) {
    try {
      return (await (await originalForUser.call(auditStorage, userId)).getEvents({ query: [], options: { limit: 1000 } })) ?? [];
    } catch (err) {
      if (/erased/.test(String(err?.message))) return [];
      throw err;
    }
  }

  async function restoreRecords (userId) {
    return (await trail(userId)).filter((e) => e.content?.action === 'account.restored');
  }

  /** The UTC date of the backup's data of `u`, as the record must give it. */
  async function backupDateOf (u) {
    const reader = createFilesystemBackupReader(u.dir);
    const m = await reader.readManifest();
    await reader.close();
    const perUser = m.snapshotBeforeByUser?.[u.id];
    const seconds = typeof perUser === 'number' ? perUser : m.snapshotBefore;
    const ms = typeof seconds === 'number' ? seconds * 1000 : m.backupTimestamp;
    return new Date(ms).toISOString().slice(0, 10);
  }

  async function withKeep (body) {
    const restore = require('test-helpers').injectTestConfigSnapshot({ audit: { onUserDelete: 'keep' } });
    try {
      await audit.reloadConfig();
      return await body();
    } finally {
      restore();
      await audit.reloadConfig();
    }
  }

  function assertNoneOf (record, values) {
    const serialized = JSON.stringify(record);
    for (const value of values) {
      if (value == null || value === '') continue;
      assert.ok(!serialized.includes(value), 'the record holds ' + JSON.stringify(value) + ': ' + serialized);
    }
  }

  // Mutations caught: the record written before the trail is imported; a time of day in the date.
  it('[AARS1] an erased account restored: the backup\'s records, then one record of the restore, ids and fixed words only', async function () {
    const u = await backedUpAccount();
    await erase(u);
    const { report } = await restoreUser(u, { restoreErased: true });
    assert.deepEqual(report.restored.map((r) => r.userId), [u.id]);
    const rows = await trail(u.id);
    const found = rows.filter((e) => e.content?.action === 'account.restored');
    assert.strictEqual(found.length, 1, JSON.stringify(rows));
    const record = found[0];
    assert.ok(rows.some((e) => e.content?.action === 'mfa.recovered'), 'the backup\'s record');
    for (const e of rows) assert.ok(e.time <= record.time, 'the newest record');
    assert.strictEqual(record.type, 'audit-log/account');
    assert.strictEqual(record.createdBy, 'system');
    assert.deepStrictEqual(record.streamIds, ['action-account.restored']);
    assert.deepStrictEqual(record.content.source, { name: 'backup' });
    assert.deepStrictEqual(record.content.record, { backupDate: await backupDateOf(u), target: 'new', afterErasure: 'completed' });
    assert.match(record.content.record.backupDate, /^\d{4}-\d{2}-\d{2}$/);
    assertNoneOf(record, [u.username, u.dir, path.basename(u.dir), u.streamId]);
  });

  // Mutation caught: the record written before the overwrite clears the trail.
  it('[AARS2] an overwrite of a live account: `existing`, one record, after the clear and the import', async function () {
    const u = await backedUpAccount();
    await restoreUser(u, { overwrite: true });
    const found = await restoreRecords(u.id);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.deepStrictEqual(found[0].content.record, { backupDate: await backupDateOf(u), target: 'existing' });
  });

  // Mutation caught: `1970-01-01` or `Invalid Date` written.
  it('[AARS3] a backup that does not say when it was taken, or says it wrongly: no date', async function () {
    const u = await backedUpAccount();
    const cases = {
      none: (m) => ({ ...m, snapshotBefore: undefined, snapshotBeforeByUser: undefined, backupTimestamp: undefined }),
      infinite: (m) => ({ ...m, snapshotBefore: undefined, snapshotBeforeByUser: undefined, backupTimestamp: Infinity }),
      zero: (m) => ({ ...m, snapshotBefore: 0, snapshotBeforeByUser: undefined }),
      future: (m) => ({ ...m, snapshotBefore: Date.now() / 1000 + 10 * 24 * 3600, snapshotBeforeByUser: undefined })
    };
    for (const [name, change] of Object.entries(cases)) {
      await restoreUser(u, { overwrite: true }, change);
      const found = await restoreRecords(u.id);
      assert.strictEqual(found.length, 1, name + ': ' + JSON.stringify(found));
      assert.deepStrictEqual(found[0].content.record, { target: 'existing' }, name);
    }
  });

  // Mutation caught: the snapshot of the whole backup used for every account.
  it('[AARS4] a chain: the date of the account\'s own snapshot, not the last run\'s', async function () {
    const u = await backedUpAccount();
    const own = Date.UTC(2024, 0, 15, 23, 30) / 1000;
    const last = Date.UTC(2025, 5, 1) / 1000;
    await restoreUser(u, { overwrite: true }, (m) => ({ ...m, snapshotBefore: last, snapshotBeforeByUser: { [u.id]: own } }));
    const found = await restoreRecords(u.id);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.strictEqual(found[0].content.record.backupDate, '2024-01-15');
  });

  // Mutations caught: `afterErasure` missing; the kept trail lost, or the
  // backup's records added twice.
  it('[AARS5] under `keep`: a restore of an erased account reads its records, `account.deleted`, then `account.restored`', async function () {
    const u = await backedUpAccount();
    await withKeep(async () => {
      await erase(u);
      assert.strictEqual((await trail(u.id)).filter((e) => e.content?.action === 'account.deleted').length, 1, 'the kept trail ends with the deletion');
      await restoreUser(u, { restoreErased: true });
      const rows = await trail(u.id);
      const actions = rows.map((e) => e.content?.action);
      assert.strictEqual(actions.filter((a) => a === 'mfa.recovered').length, 1, 'the backup\'s record, once: ' + JSON.stringify(actions));
      const deleted = rows.find((e) => e.content?.action === 'account.deleted');
      const restored = rows.filter((e) => e.content?.action === 'account.restored');
      assert.ok(deleted != null, JSON.stringify(actions));
      assert.strictEqual(restored.length, 1, JSON.stringify(actions));
      assert.ok(deleted.time <= restored[0].time);
      assert.deepStrictEqual(restored[0].content.record, { backupDate: await backupDateOf(u), target: 'new', afterErasure: 'completed' });
    });
  });

  // Mutation caught: an overwrite under `keep` that clears the trail (the
  // records written since the backup lost).
  it('[AARSC] under `keep`, an overwrite keeps the trail it finds and adds the backup\'s records it lacks', async function () {
    const u = await backedUpAccount();
    await audit.eventForUser(u.id, auditRow('mfa.deactivatedByAdmin'));
    await withKeep(async () => {
      await restoreUser(u, { overwrite: true });
      const actions = (await trail(u.id)).map((e) => e.content?.action).sort();
      assert.deepStrictEqual(actions, ['account.restored', 'mfa.deactivatedByAdmin', 'mfa.recovered']);
    });
    // under `erase` (the default): the trail is the backup's
    await restoreUser(u, { overwrite: true });
    assert.deepStrictEqual((await trail(u.id)).map((e) => e.content?.action).sort(), ['account.restored', 'mfa.recovered']);
  });

  // Mutation caught: a roll-back under `keep` that removes the trail.
  it('[AARSD] under `keep`, the roll-back of a restore keeps the trail', async function () {
    const u = await backedUpAccount();
    await audit.eventForUser(u.id, auditRow('mfa.deactivatedByAdmin'));
    await withKeep(async () => {
      const { o } = await orchestrator();
      const reader = readerOf(u);
      try {
        await o.restoreUser(u.id, reader, { overwrite: true, skipPlatform: true, deferRestoredStamp: true });
      } finally {
        await reader.close();
      }
      assert.strictEqual(await o.rollBackAccount(u.id, u.username), 'emptied');
      const actions = (await trail(u.id)).map((e) => e.content?.action).sort();
      assert.deepStrictEqual(actions, ['mfa.deactivatedByAdmin', 'mfa.recovered'], 'kept, and no record of a restore rolled back');
    });
  });

  /** Whether `userId` has an audit trail left: for a file-backed audit, its file (read without opening it, which would create it). */
  async function hasTrail (userId) {
    if (typeof auditStorage.existingPathForUser === 'function') return fs.existsSync(auditStorage.existingPathForUser(userId));
    return (await trail(userId)).length > 0;
  }

  /** Under `keep`: `u` erased, restored by an orchestrator of this process (deferred, as bin/backup.js does). */
  async function restoredErased (u, eraseUnderKeep) {
    if (eraseUnderKeep) await withKeep(() => erase(u));
    else await erase(u);
    const { o } = await orchestrator();
    const reader = readerOf(u);
    try {
      await withKeep(() => o.restoreUser(u.id, reader, { restoreErased: true, skipPlatform: true, deferRestoredStamp: true }));
    } finally {
      await reader.close();
    }
    return o;
  }

  // Mutations caught: the trail the restore created kept after the account is
  // removed; a trail the account had before the restore removed with it.
  it('[AARSE] under `keep`, a roll-back that removes the account removes the trail the restore created, and only that one', async function () {
    const created = await backedUpAccount();
    let o = await restoredErased(created, false);
    assert.ok(await hasTrail(created.id), 'the import wrote the backup\'s records');
    await withKeep(async () => {
      assert.strictEqual(await o.rollBackAccount(created.id, created.username), 'removed');
    });
    assert.equal(await exists(created), false);
    assert.strictEqual(await hasTrail(created.id), false, 'the trail the restore created goes with the account');

    const had = await backedUpAccount();
    o = await restoredErased(had, true);
    await withKeep(async () => {
      assert.strictEqual(await o.rollBackAccount(had.id, had.username), 'removed');
      const actions = (await trail(had.id)).map((e) => e.content?.action).sort();
      assert.deepStrictEqual(actions, ['account.deleted', 'mfa.recovered'], 'the trail it had before the restore is kept');
    });
  });

  // Mutation caught: the cleanup of a failed restore that keeps the trail the
  // restore created for an account it removes.
  it('[AARSG] under `keep`, the cleanup of a restore that failed after the audit import removes the trail it created', async function () {
    const u = await backedUpAccount();
    await erase(u);
    const { o } = await orchestrator();
    const reader = readerOf(u);
    let trailAtFailure = null;
    const failing = {
      readManifest: () => reader.readManifest(),
      async openUser (id) {
        const userReader = await reader.openUser(id);
        userReader.readExternalIds = async function * () {
          trailAtFailure = await hasTrail(u.id);
          throw new Error('injected read error after the audit');
        };
        return userReader;
      },
      readPlatformData: () => reader.readPlatformData(),
      readServerMappings: () => reader.readServerMappings(),
      close: () => reader.close()
    };
    try {
      await withKeep(async () => {
        await assert.rejects(o.restoreUser(u.id, failing, { restoreErased: true, skipPlatform: true }), /injected read error after the audit/);
      });
    } finally {
      await reader.close();
    }
    assert.strictEqual(trailAtFailure, true, 'the import wrote the backup\'s records before the failure');
    assert.equal(await exists(u), false);
    assert.strictEqual(await hasTrail(u.id), false);
  });

  // Mutation caught: a single-account restore that fails after the account's
  // data was restored keeps the account without its record.
  it('[AARSF] a single-account restore stopped by a failure after its data was restored: the account, kept, has its record', async function () {
    const u = await backedUpAccount();
    const { o } = await orchestrator();
    o._restoreAliases = async () => { throw new Error('injected alias failure'); };
    const reader = readerOf(u);
    try {
      await assert.rejects(o.restoreUser(u.id, reader, { overwrite: true, skipPlatform: true, deferRestoredStamp: true }), /injected alias failure/);
    } finally {
      await reader.close();
    }
    assert.ok(await exists(u));
    const found = await restoreRecords(u.id);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.deepStrictEqual(found[0].content.record, { backupDate: await backupDateOf(u), target: 'existing' });
  });

  // Mutation caught: the withdrawn erasure not carried to the record.
  it('[AARS6] an erasure that stopped unfinished, withdrawn by the restore: `unfinished`', async function () {
    const stopped = async (u) => {
      const fault = sinon.stub(Deletion.prototype, 'deleteAuditDataStorage').callsFake(function (context, params, result, next) { next(new Error('injected fault')); });
      try {
        await assert.rejects(new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' }));
      } finally {
        fault.restore();
      }
      const store = await getErasuresLocal();
      const record = await store.get(u.id);
      await store.put({ ...record, updatedAt: record.updatedAt - STALE_MS });
    };
    // started after the backup: restored with --restore-erased
    const after = await backedUpAccount();
    await stopped(after);
    await restoreUser(after, { overwrite: true, restoreErased: true });
    let found = await restoreRecords(after.id);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.deepStrictEqual(found[0].content.record, { backupDate: await backupDateOf(after), target: 'existing', afterErasure: 'unfinished' });
    // started before the backup: only withdrawn
    const fx = getNewFixture();
    fixtures.push(fx);
    const username = ('aars' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await fx.user(username);
    const before = { id: fu.attrs.id, username, dir: path.join(tmpDir, username) };
    cleanups.push(before);
    await stopped(before);
    assertOk(runCli(['--output', before.dir, '--user', username]), 'backup');
    const { report } = await restoreUser(before, { overwrite: true });
    assert.deepEqual(report.erasuresWithdrawn.map((r) => r.userId), [before.id]);
    found = await restoreRecords(before.id);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.strictEqual(found[0].content.record.afterErasure, 'unfinished');
  });

  /** Rewrites the events of `u`'s plaintext backup so they fail --verify-integrity (listed again in the run's file table). */
  function tamper (u) {
    const files = fs.readdirSync(u.dir, { recursive: true }).map(String).filter((f) => /(^|\/)events-[0-9]+\.jsonl(\.gz)?$/.test(f));
    assert.ok(files.length > 0);
    for (const f of files) {
      const file = path.join(u.dir, f);
      const gz = f.endsWith('.gz');
      const text = gz ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
      const changed = text.split('\n').map((line) => line.trim() === '' ? line : JSON.stringify({ ...JSON.parse(line), content: 'tampered' })).join('\n');
      const out = Buffer.from(changed, 'utf8');
      fs.writeFileSync(file, gz ? zlib.gzipSync(out) : out);
      const manifestPath = path.join(u.dir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const bytes = fs.readFileSync(file);
      const entry = manifest.integrity.files.find((e) => e.path === f.split(path.sep).join('/'));
      entry.size = bytes.length;
      entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
  }

  // Mutation caught: the record written inside the restore of the account,
  // before --verify-integrity kept it.
  it('[AARS7] bin/backup.js --verify-integrity: a kept account has its record, a rolled-back or emptied one none', async function () {
    const kept = await backedUpAccount();
    const emptied = await backedUpAccount();
    const removed = await backedUpAccount();
    tamper(emptied);
    tamper(removed);
    await erase(removed);
    assertOk(runCli(['--restore', kept.dir, '--user', kept.username, '--overwrite', '--verify-integrity']), 'kept');
    const e = runCli(['--restore', emptied.dir, '--user', emptied.username, '--overwrite', '--verify-integrity']);
    assert.strictEqual(e.status, 1, e.stdout + e.stderr);
    assert.match(e.stderr, /EMPTIED, NOT REMOVED/);
    const r = runCli(['--restore', removed.dir, '--user', removed.username, '--restore-erased', '--verify-integrity']);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /the account removed/);
    const found = await restoreRecords(kept.id);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.deepStrictEqual(found[0].content.record, { backupDate: await backupDateOf(kept), target: 'existing' });
    assert.deepStrictEqual(await restoreRecords(emptied.id), []);
    assert.deepStrictEqual(await restoreRecords(removed.id), []);
  });

  // Mutation caught: the failure path of a whole-backup restore forgotten.
  it('[AARS8] a whole-backup restore stopped by a failure on its second account: the first, kept, has its record', async function () {
    const a = await backedUpAccount();
    const b = await backedUpAccount();
    const readers = [a, b].map((u) => createFilesystemBackupReader(u.dir));
    const manifests = [];
    for (const r of readers) manifests.push(await r.readManifest());
    const combined = {
      async readManifest () { return { ...manifests[0], users: manifests.flatMap((m) => m.users) }; },
      async openUser (userId) {
        if (userId === b.id) throw new Error('injected backup read error');
        return readers[0].openUser(userId);
      },
      async * readPlatformData () {},
      async * readServerMappings () {},
      async close () { for (const r of readers) await r.close(); }
    };
    const { o } = await orchestrator();
    try {
      // deferred, as bin/backup.js does: the caller never sees the report of a run that throws
      await assert.rejects(o.restoreAllUsers(combined, { overwrite: true, skipPlatform: true, deferRestoredStamp: true }), /injected backup read error/);
    } finally {
      await combined.close();
    }
    assert.strictEqual((await restoreRecords(a.id)).length, 1);
    assert.deepStrictEqual(await restoreRecords(b.id), []);
  });

  // Mutation caught: the restore failing on an audit error.
  it('[AARS9] a record that cannot be written does not fail the restore, and is counted once', async function () {
    const u = await backedUpAccount();
    let failing = false;
    auditStorage.forUser = async function (userId) {
      if (failing && userId === u.id) throw new Error('staged: no audit storage');
      return await originalForUser.call(auditStorage, userId);
    };
    const original = audit.eventForUser;
    sinon.stub(audit, 'eventForUser').callsFake(async function (userId, event, methodId, ...rest) {
      failing = methodId === 'account.restored' && userId === u.id;
      try {
        return await original.call(audit, userId, event, methodId, ...rest);
      } finally {
        failing = false;
      }
    });
    const before = lossCounter.snapshot().lost.total;
    const { report } = await restoreUser(u, { overwrite: true });
    assert.deepEqual(report.restored.map((r) => r.userId), [u.id]);
    assert.strictEqual(lossCounter.snapshot().lost.total, before + 1);
    assert.ok(await exists(u));
    assert.deepStrictEqual(await restoreRecords(u.id), []);
  });

  // Mutations caught: a record with the audit off; the record written under the backup's id.
  it('[AARSA] the audit off writes none; a remapped restore writes it under the id restored', async function () {
    const off = await backedUpAccount();
    await withInjectedConfig({ audit: { active: false } }, async () => {
      await restoreUser(off, { overwrite: true });
    });
    assert.deepStrictEqual(await restoreRecords(off.id), []);

    const u = await backedUpAccount();
    const target = { id: 'aarstgt' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-12), username: u.username };
    await erase(u);
    cleanups.push(target);
    const { o } = await orchestrator();
    const reader = readerOf(u);
    try {
      await o.restoreUser(u.id, reader, { overwrite: true, remapUserId: target.id, restoreErased: true, skipPlatform: true });
    } finally {
      await reader.close();
    }
    const found = await restoreRecords(target.id);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.deepStrictEqual(await restoreRecords(u.id), [], 'none under the backed-up id');
  });
});
