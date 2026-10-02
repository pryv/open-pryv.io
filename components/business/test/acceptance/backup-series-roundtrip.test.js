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
const os = require('node:os');
const path = require('node:path');
const { createId: cuid } = require('@paralleldrive/cuid2');
const { seriesNamespace } = require('business/src/series/namespace.ts');

/**
 * HF series data must survive backup and restore.
 *
 * HFS stores a user's points under the series namespace `user.<username>`.
 * Backup exported, restore imported and restore-overwrite dropped under the
 * bare user id instead, so every backup silently carried zero series, on
 * every engine, and nothing warned. These tests write points where HFS writes
 * them and read them back from the same place.
 */
describe('[BKSR] backup + restore carry HF series data', function () {
  this.timeout(30000);

  const userId = cuid();
  const username = 'bksr' + userId.substring(0, 12);
  const namespace = seriesNamespace(username);
  const measurement = 'event.' + cuid();
  let conn, usersIndex, backupDir, BackupOrchestrator, RestoreOrchestrator, backupIO;

  before(async function () {
    const storages = require('storages');
    conn = storages.seriesConnection;
    if (conn == null) this.skip();
    const { getUsersLocalIndex } = require('storage');
    usersIndex = await getUsersLocalIndex();
    await usersIndex.addUser(username, userId);
    BackupOrchestrator = require('business/src/backup/BackupOrchestrator.ts').default;
    RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator.ts').default;
    backupIO = require('storages/interfaces/backup/index.ts');
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bksr-'));
  });

  after(async function () {
    if (conn == null) return;
    // The restore created default account fields and other per-user rows;
    // the restore's own clearing path removes them along with the series.
    const restore = new RestoreOrchestrator();
    await restore.init();
    await restore._clearUserData({ id: userId }, userId, username);
    await usersIndex.deleteById(userId);
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  // InfluxDB answers "database not found" for a dropped namespace where the
  // other engines return no measurements; both mean "no points".
  async function exportedMeasurements () {
    try {
      return (await conn.exportDatabase(namespace)).measurements;
    } catch (e) {
      if (/database not found/.test(e.message)) return [];
      throw e;
    }
  }

  async function pointValues () {
    const found = (await exportedMeasurements()).find((m) => m.measurement === measurement);
    return found ? found.points.map((p) => p.value) : [];
  }

  // As the HFS series repository does before every write (InfluxDB needs it).
  async function write (name, points) {
    await conn.createDatabase(namespace);
    await conn.writeMeasurement(name, points, { database: namespace });
  }

  it('[BKSR-01] backup exports the points stored under the HFS namespace', async function () {
    await write(measurement, [
      { fields: { value: 1.5 }, timestamp: 1e9 },
      { fields: { value: 2.5 }, timestamp: 2e9 }
    ]);
    assert.deepStrictEqual(await pointValues(), [1.5, 2.5], 'fixture points must be readable before backup');
    // Every engine exports `time` as milliseconds; that shared format is what
    // lets a backup taken on one series engine restore onto another.
    const exported = (await exportedMeasurements()).find((m) => m.measurement === measurement);
    assert.deepStrictEqual(exported.points.map((p) => p.time), [1000, 2000],
      'exported point times must be numbers of milliseconds on every engine');

    const writer = backupIO.createFilesystemBackupWriter(backupDir, { maxChunkSize: 50 * 1024 * 1024, compress: true });
    const backup = new BackupOrchestrator();
    await backup.init();
    await backup.backupUser(userId, writer);

    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    const userManifest = manifest.users.find((u) => u.userId === userId);
    assert.strictEqual(userManifest.stats.series, 1, 'the backup must carry the one series measurement');
  });

  it('[BKSR-02] restore writes the points back where HFS reads them', async function () {
    await conn.dropDatabase(namespace);
    assert.deepStrictEqual(await pointValues(), [], 'points must be gone before restore');

    const reader = backupIO.createFilesystemBackupReader(backupDir, {});
    const restore = new RestoreOrchestrator();
    await restore.init();
    await restore.restoreUser(userId, reader, { overwrite: true });

    assert.deepStrictEqual(await pointValues(), [1.5, 2.5], 'restored points must be readable under the HFS namespace');
    const restored = (await exportedMeasurements()).find((m) => m.measurement === measurement);
    assert.deepStrictEqual(restored.points.map((p) => p.time), [1000, 2000],
      'restored points must keep their times (milliseconds in, milliseconds out)');
  });

  it('[BKSR-03] restore with overwrite clears the existing points first', async function () {
    const stray = 'event.' + cuid();
    await write(stray, [{ fields: { value: 9 }, timestamp: 1e9 }]);

    const reader = backupIO.createFilesystemBackupReader(backupDir, {});
    const restore = new RestoreOrchestrator();
    await restore.init();
    await restore.restoreUser(userId, reader, { overwrite: true });

    const measurements = await exportedMeasurements();
    assert.deepStrictEqual(measurements.map((m) => m.measurement).sort(), [measurement],
      'only the backed-up measurement may remain after an overwrite restore');
  });
});
