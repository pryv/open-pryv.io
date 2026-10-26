/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { BackupOrchestrator } = require('business/src/backup/BackupOrchestrator.ts');
const { RestoreOrchestrator } = require('business/src/backup/RestoreOrchestrator.ts');
const { createFilesystemBackupWriter } = require('storages/interfaces/backup/FilesystemBackupWriter.ts');
const { createFilesystemBackupReader } = require('storages/interfaces/backup/FilesystemBackupReader.ts');
const crypto = require('node:crypto');
const idx = require('platform/src/externalIdIndex.ts');
const { ExternalIdsService } = require('business/src/external-ids/service.ts');
const { ExternalIdConflict } = require('storages/interfaces/baseStorage/ExternalIdsLocalDB.ts');

const TEST_DIR = path.join('/tmp', 'backup-xidb-' + process.pid);

// A PlatformDB with the calls the orchestrators and the namespace functions make.
function fakePlatformDB (userRows = []) {
  const store = new Map();
  const imported = [];
  return {
    store,
    imported,
    coreId: 'core-a',
    hashFor: (field, value) => value,
    async exportAll () { return userRows; },
    async importAll (rows) { imported.push(...rows); },
    async getAllCoreInfos () { return []; },
    async getPlatformKv (key) { return store.get(key) ?? null; },
    async setPlatformKv (key, value) { store.set(key, value); },
    async listPlatformKvEntries (prefix) {
      return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    },
    async claimCoreRow (prefix, key, value) {
      if (!store.has(prefix + key)) store.set(prefix + key, value);
      return store.get(prefix + key) === value;
    },
    async getCoreRow (prefix, key) { return store.get(prefix + key) ?? null; },
    async deleteCoreRowIfValue (prefix, key, value) {
      if (store.get(prefix + key) !== value) return false;
      store.delete(prefix + key);
      return true;
    }
  };
}

// A core's external-ids table with the engine's two unique constraints.
function fakeLocalDB () {
  const rows = [];
  return {
    rows,
    async insert (row) {
      if (rows.some((r) => r.nsToken === row.nsToken && r.valueToken === row.valueToken)) throw new ExternalIdConflict('value-taken');
      if (rows.some((r) => r.userId === row.userId && r.nsToken === row.nsToken)) throw new ExternalIdConflict('namespace-taken');
      rows.push({ ...row });
    },
    async getByUser (userId) { return rows.filter((r) => r.userId === userId).map((r) => ({ ...r })); },
    async getByTokens (ns, v) { const r = rows.find((x) => x.nsToken === ns && x.valueToken === v); return r ? { ...r } : null; },
    async getByUserAndNamespace (u, ns) { const r = rows.find((x) => x.userId === u && x.nsToken === ns); return r ? { ...r } : null; },
    async deleteByUserAndNamespace (u, ns) {
      const i = rows.findIndex((r) => r.userId === u && r.nsToken === ns);
      if (i >= 0) rows.splice(i, 1);
      return i >= 0;
    }
  };
}

function blinded () {
  return crypto.randomBytes(32).toString('base64url');
}

async function collect (iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('[XIDB] external-id namespace rows through a platform backup and restore', function () {
  afterEach(function () {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('[XIDB1] the rows travel with their salts; a live namespace with another salt is kept and reported', async function () {
    const userRow = { isUnique: true, field: 'email', username: 'tok-user', value: 'tok-email' };
    const source = fakePlatformDB([userRow]);
    await idx.setNamespace(source, 'ns-new', { label: 'New' }, 1);
    await idx.setNamespace(source, 'ns-live', { label: 'Live' }, 1);

    const backup = Object.create(BackupOrchestrator.prototype);
    backup.platformDB = source;
    const writer = createFilesystemBackupWriter(TEST_DIR, { compress: true });
    await backup._backupPlatform(writer);
    await writer.writeManifest({ coreVersion: '2.0.0', config: { engine: 'test' }, userManifests: [], backupType: 'full', backupTimestamp: Date.now() });
    await writer.close();

    // The target already holds ns-live, created there with its own salt.
    const target = fakePlatformDB();
    await idx.setNamespace(target, 'ns-live', { label: 'Live here' }, 5);
    const liveRow = target.store.get('ext-id-ns/ns-live');

    const restore = Object.create(RestoreOrchestrator.prototype);
    restore.logger = { info () {}, warn () {} };
    restore.platformDB = target;
    const reader = createFilesystemBackupReader(TEST_DIR);
    await reader.readManifest();
    const read = await restore._readPlatform(reader, () => false);
    const result = await restore._writePlatform(read);
    await reader.close();

    assert.deepStrictEqual(target.imported, [userRow], 'the user rows still go through importAll, without the namespace rows');
    assert.strictEqual(target.store.get('ext-id-ns/ns-new'), source.store.get('ext-id-ns/ns-new'), 'restored with its salt');
    assert.strictEqual(target.store.get('ext-id-ns/ns-live'), liveRow, 'the live namespace is not overwritten');
    assert.deepStrictEqual(result.extIdNamespaceSaltMismatch, ['ns-live']);
    const newRow = await idx.getNamespace(target, 'ns-new');
    const sourceRow = await idx.getNamespace(source, 'ns-new');
    assert.strictEqual(newRow.salt, sourceRow.salt);
  });

  it('[XIDB2] the per-user external-ids file round-trips (compressed or not); a backup without it reads none', async function () {
    const entries = [{ namespace: 'ns-a', blindedValue: blinded(), claimedAt: 12 }, { namespace: 'ns-b', blindedValue: blinded(), claimedAt: 34 }];
    for (const compress of [true, false]) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
      const writer = createFilesystemBackupWriter(TEST_DIR, { compress });
      const uw = await writer.openUser('user-xid1', 'alice');
      await uw.writeExternalIds(entries);
      const userManifest = await uw.close();
      assert.strictEqual(userManifest.stats.externalIds, 2);
      const old = await writer.openUser('user-old1', 'bob');
      await old.writeStreams([]);
      await writer.writeManifest({ coreVersion: '2.0.0', config: {}, userManifests: [userManifest], backupType: 'full', backupTimestamp: Date.now() });
      await writer.close();
      assert.ok(fs.existsSync(path.join(TEST_DIR, 'users', 'user-xid1', compress ? 'external-ids.jsonl.gz' : 'external-ids.jsonl')));

      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      assert.deepStrictEqual(await collect((await reader.openUser('user-xid1')).readExternalIds()), entries);
      assert.deepStrictEqual(await collect((await reader.openUser('user-old1')).readExternalIds()), [], 'no file: no ids');
      await reader.close();
    }
  });

  it('[XIDB3] in a backup chain the newest run that has the file gives the ids (a release after the full run is not undone)', async function () {
    const [kept, released] = [{ namespace: 'ns-a', blindedValue: blinded(), claimedAt: 1 }, { namespace: 'ns-b', blindedValue: blinded(), claimedAt: 2 }];
    const chainId = 'c0ffee'.padEnd(32, '0');
    const incId = '20261013T142501Z-3f9a1c7e';
    const runs = [
      { run: { runId: 'full', path: '.', parentRunId: null, chainId }, ids: [kept, released], snapshotBefore: 1000 },
      { run: { runId: incId, path: 'incrementals/' + incId, parentRunId: 'full', chainId }, ids: [kept], snapshotBefore: 2000 }
    ];
    for (const { run, ids, snapshotBefore } of runs) {
      const writer = createFilesystemBackupWriter(TEST_DIR, { compress: false, run });
      const uw = await writer.openUser('user-xid1', 'alice');
      await uw.writeExternalIds(ids);
      const m = await uw.close();
      await writer.writeManifest({ coreVersion: 'test', config: {}, backupType: 'unused', snapshotBefore, backupTimestamp: snapshotBefore * 1000, userManifests: [m], scope: 'users' });
      await writer.close();
    }
    const reader = createFilesystemBackupReader(TEST_DIR);
    await reader.readManifest();
    assert.deepStrictEqual(await collect((await reader.openUser('user-xid1')).readExternalIds()), [kept]);
    await reader.close();
    const asOfFull = createFilesystemBackupReader(TEST_DIR, { throughRun: 'full' });
    await asOfFull.readManifest();
    assert.deepStrictEqual(await collect((await asOfFull.openUser('user-xid1')).readExternalIds()), [kept, released]);
    await asOfFull.close();
  });

  it('[XIDB4] a whole restore links the ids after the platform rows, with the target\'s tokens; a held id stays with its holder', async function () {
    const source = fakePlatformDB();
    await idx.setNamespace(source, 'ns-ehr', { label: 'EHR' }, 1);
    const sourceIds = new ExternalIdsService(source, fakeLocalDB(), () => 100);
    const [v1, v2] = [blinded(), blinded()];
    await sourceIds.claim('user-xid1', 'ns-ehr', v1);
    await sourceIds.claim('user-xid2', 'ns-ehr', v2);

    const backup = Object.create(BackupOrchestrator.prototype);
    backup.platformDB = source;
    const writer = createFilesystemBackupWriter(TEST_DIR, { compress: true });
    const userManifests = [];
    for (const [userId, username] of [['user-xid1', 'alice'], ['user-xid2', 'bobby']]) {
      const uw = await writer.openUser(userId, username);
      await uw.writeExternalIds(await sourceIds.exportForUser(userId));
      userManifests.push(await uw.close());
    }
    await backup._backupPlatform(writer);
    await writer.writeManifest({ coreVersion: '2.0.0', config: { engine: 'test' }, userManifests, backupType: 'full', backupTimestamp: Date.now() });
    await writer.close();

    // Another platform (another derivation): the namespace is not there
    // before the platform rows are restored; another core holds v2 there.
    const target = fakePlatformDB();
    target.hashFor = (field, value) => crypto.createHash('sha256').update('target\0' + field + '\0' + value).digest('hex');
    const targetIds = new ExternalIdsService(target, fakeLocalDB(), () => 900);
    const restore = Object.create(RestoreOrchestrator.prototype);
    restore.logger = { info () {}, warn () {} };
    restore.platformDB = target;
    restore.externalIds = targetIds;
    restore.isReservedUsername = () => false;
    restore.isListedUsername = () => false;
    restore.usersLocalIndex = { async getUserId () { return null; }, async getUsername () { return null; } };
    restore._restoreSingleUser = async (reader, userId) => {
      assert.strictEqual(await idx.getNamespace(target, 'ns-ehr'), null, 'users are restored before the platform rows');
      return { userId, entries: await collect((await reader.openUser(userId)).readExternalIds()) };
    };
    const reader = createFilesystemBackupReader(TEST_DIR);
    // The other core's claim of v2, made with the namespace's salt once it is restored.
    const writePlatform = restore._writePlatform.bind(restore);
    restore._writePlatform = async (read) => {
      const result = await writePlatform(read);
      const tokens = idx.tokensFor(target, await idx.getNamespace(target, 'ns-ehr'), v2);
      await target.claimCoreRow(idx.ROW_PREFIX, tokens.nsToken + '/' + tokens.valueToken, 'core-other');
      return result;
    };
    const report = await restore.restoreAllUsers(reader, { overwrite: true });
    await reader.close();

    assert.deepStrictEqual(report.externalIds, { restored: 1, lost: 1, namespaceMissing: 0, invalid: 0 });
    assert.strictEqual(await targetIds.holds('user-xid1', 'ns-ehr', v1), true);
    assert.deepStrictEqual(await targetIds.list('user-xid1'), [{ namespace: 'ns-ehr', claimedAt: 100 }], 'the claim date of the backup');
    assert.strictEqual(await idx.getRowCore(target, idx.tokensFor(target, await idx.getNamespace(target, 'ns-ehr'), v2)), 'core-other', 'the holder keeps v2');
    assert.deepStrictEqual(await targetIds.list('user-xid2'), []);
    const sourceToken = idx.tokensFor(source, await idx.getNamespace(source, 'ns-ehr'), v1).valueToken;
    assert.notStrictEqual(targetIds.db.rows[0].valueToken, sourceToken, 'tokens of the target platform');
  });
});
