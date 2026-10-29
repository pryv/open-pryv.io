/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * [BKAL] an account's routable aliases (a minted access alias and a former
 * username) survive a backup, the account's deletion and a restore: the
 * aliased access and the former name route again, and the former name is not
 * free for a new registration.
 */
describe('[BKAL] backup + restore carry the alias index', function () {
  this.timeout(60000);

  let backupDir, usersRepository, platform, backupIO, BackupOrchestrator, RestoreOrchestrator;
  const restored = [];

  before(async function () {
    await initTests();
    await initCore();
    const { getUsersRepository } = require('business/src/users/index.ts');
    usersRepository = await getUsersRepository();
    platform = usersRepository.platform;
    backupIO = require('storages/interfaces/backup/index.ts');
    BackupOrchestrator = require('business/src/backup/BackupOrchestrator.ts').default;
    RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator.ts').default;
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkal-'));
  });

  // A single-user restore writes no platform rows (the backup of one account
  // has none): remove the restored account before the integrity hooks run.
  afterEach(async function () {
    for (const { userId, username } of restored.splice(0)) {
      if (await usersRepository.getUserIdForUsername(username) != null) await usersRepository.deleteOne(userId, username);
    }
  });

  after(async function () {
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  function freshName (prefix) {
    return (prefix + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  }

  it('[BKAL1] the aliased access and the former username route again after a restore, and the former name stays held', async function () {
    const formerName = freshName('bkal');
    const currentName = freshName('bkam');
    const fixtureUser = await getNewFixture().user(formerName);
    await fixtureUser.stream({ id: 'bkal-s', name: 'S' });
    const userId = fixtureUser.attrs.id;
    const masterToken = cuid();
    await fixtureUser.access({ token: masterToken, type: 'app', name: 'bkal master', permissions: [{ streamId: '*', level: 'manage' }] });
    const created = await coreRequest.post('/' + formerName + '/accesses').set('Authorization', masterToken)
      .send({ name: 'bkal aliased', randomAlias: true, permissions: [{ streamId: 'bkal-s', level: 'read' }] });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const { alias, token } = created.body.access;
    await usersRepository.changeUsername(userId, formerName, currentName, 'system');
    restored.push({ userId, username: currentName });

    const writer = backupIO.createFilesystemBackupWriter(backupDir, { maxChunkSize: 50 * 1024 * 1024, compress: true });
    const backup = new BackupOrchestrator();
    await backup.init();
    await backup.backupUser(userId, writer);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    const entry = manifest.users.find((u) => u.userId === userId);
    assert.deepStrictEqual([...entry.aliases].sort(), [alias, formerName].sort(), 'the manifest lists the aliases');

    await usersRepository.deleteOne(userId, currentName);
    assert.strictEqual(await usersRepository.getUserIdForUsername(alias), undefined, 'the alias is released with the account');

    const reader = backupIO.createFilesystemBackupReader(backupDir, {});
    const restore = new RestoreOrchestrator();
    await restore.init();
    // overwrite: the repository deletion leaves the account's accesses rows
    const report = await restore.restoreUser(userId, reader, { overwrite: true });
    await reader.close();
    assert.deepStrictEqual(report.aliases, { restored: 2, refused: [] });

    const viaAlias = await coreRequest.get('/' + alias + '/access-info').set('Authorization', token);
    assert.strictEqual(viaAlias.status, 200, 'the aliased access routes: ' + JSON.stringify(viaAlias.body));
    assert.strictEqual(viaAlias.body.user.username, alias, 'and still reports its alias');
    const viaFormer = await coreRequest.get('/' + formerName + '/access-info').set('Authorization', masterToken);
    assert.strictEqual(viaFormer.status, 200, 'the former username routes: ' + JSON.stringify(viaFormer.body));
    assert.strictEqual(viaFormer.body.user.username, currentName);
    assert.strictEqual(await usersRepository.usernameExistsOnPlatform(formerName), true, 'the former name is not free to register');
    assert.notStrictEqual(await platform.getUsersUniqueField('alias', formerName), null, 'the former name is reserved on the platform');
    assert.notStrictEqual(await platform.getUsersUniqueField('alias', alias), null, 'the alias is reserved on the platform');
  });

  // Series kept under a former username (an account renamed by an earlier
  // release) and the username's own: backed up, then restored over the
  // account while the former namespace holds a point written after the backup.
  async function seriesRoundTrip (formerName, currentName, { pointsBeforeRename = false } = {}) {
    const series = require('storages').seriesConnection;
    assert.ok(series != null, 'series storage is initialised');
    const { seriesNamespace } = require('business/src/series/namespace.ts');
    const point = (value, seconds) => ({ fields: { value }, timestamp: seconds * 1e9 });
    const contentOf = async (name) => {
      const out = {};
      for (const { measurement, points } of (await series.exportDatabase(seriesNamespace(name))).measurements) {
        out[measurement] = [...points].sort((a, b) => Number(a.time) - Number(b.time)).map((p) => p.value);
      }
      return out;
    };
    const fixtureUser = await getNewFixture().user(formerName);
    const userId = fixtureUser.attrs.id;
    if (pointsBeforeRename) {
      await series.writeMeasurement('event.z', [point(7, 1)], { database: seriesNamespace(formerName) });
    }
    await usersRepository.changeUsername(userId, formerName, currentName, 'system');
    restored.push({ userId, username: currentName });
    if (pointsBeforeRename) {
      assert.deepStrictEqual(await contentOf(currentName), { 'event.z': [7] }, 'the rename moved the series');
      assert.deepStrictEqual(await contentOf(formerName), {}, 'nothing left under the former username');
    }
    await series.writeMeasurement('event.a', [point(1, 1), point(2, 2)], { database: seriesNamespace(formerName) });
    await series.writeMeasurement('event.b', [point(3, 1)], { database: seriesNamespace(formerName) });
    await series.writeMeasurement('event.a', [point(20, 2), point(30, 3)], { database: seriesNamespace(currentName) });

    const dir = fs.mkdtempSync(path.join(backupDir, 'bkal3-'));
    const writer = backupIO.createFilesystemBackupWriter(dir, { maxChunkSize: 50 * 1024 * 1024, compress: true });
    const backup = new BackupOrchestrator();
    await backup.init();
    await backup.backupUser(userId, writer);
    // After the backup: a point under the former username the restore must clear.
    await series.writeMeasurement('event.c', [point(99, 1)], { database: seriesNamespace(formerName) });

    const reader = backupIO.createFilesystemBackupReader(dir, {});
    const restore = new RestoreOrchestrator();
    await restore.init();
    await restore.restoreUser(userId, reader, { overwrite: true });
    await reader.close();

    const expected = { 'event.a': [1, 20, 30], 'event.b': [3] };
    if (pointsBeforeRename) expected['event.z'] = [7];
    assert.deepStrictEqual(await contentOf(currentName), expected);
    assert.deepStrictEqual(await contentOf(formerName), {}, 'the former namespace is cleared, nothing restored under it');
    for (const name of [formerName, currentName]) await series.dropDatabase(seriesNamespace(name));
  }

  it('[BKAL3] the series under a former username are backed up and restored under the username, its own points kept on a clash', async function () {
    await seriesRoundTrip(freshName('bkap'), freshName('bkaq'));
  });

  it('[BKAL4] a username that starts with "r-" (not an access alias) is a former username like any other: its series are moved, backed up and restored', async function () {
    const formerName = 'r-' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 6).padEnd(6, 'x');
    await seriesRoundTrip(formerName, freshName('bkar'), { pointsBeforeRename: true });
  });

  it('[BKAL2] an alias another account holds by the time of the restore stays with its holder and is reported', async function () {
    const name = freshName('bkan');
    const fixtureUser = await getNewFixture().user(name);
    const userId = fixtureUser.attrs.id;
    const alias = await usersRepository.mintAlias(name, userId);
    const dir = fs.mkdtempSync(path.join(backupDir, 'bkal2-'));
    const writer = backupIO.createFilesystemBackupWriter(dir, { maxChunkSize: 50 * 1024 * 1024, compress: true });
    const backup = new BackupOrchestrator();
    await backup.init();
    await backup.backupUser(userId, writer);
    await usersRepository.deleteOne(userId, name);

    // Meanwhile another account takes the alias.
    const otherName = freshName('bkao');
    const other = await getNewFixture().user(otherName);
    assert.strictEqual(await usersRepository.reserveSpecificAlias(otherName, other.attrs.id, alias), true);

    const reader = backupIO.createFilesystemBackupReader(dir, {});
    const restore = new RestoreOrchestrator();
    await restore.init();
    const report = await restore.restoreUser(userId, reader, { overwrite: true });
    await reader.close();
    restored.push({ userId, username: name });
    assert.deepStrictEqual(report.aliases, { restored: 0, refused: [{ userId, username: name, alias }] });
    assert.strictEqual(await usersRepository.getUserIdForUsername(alias), other.attrs.id, 'the holder keeps the alias');
  });
});
