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
const idx = require('platform/src/externalIdIndex.ts');

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
    }
  };
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
});
