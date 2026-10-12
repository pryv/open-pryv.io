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
const { Readable } = require('node:stream');
const { RestoreOrchestrator } = require('business/src/backup/RestoreOrchestrator.ts');
const { createFilesystemBackupWriter } = require('storages/interfaces/backup/FilesystemBackupWriter.ts');
const { createFilesystemBackupReader } = require('storages/interfaces/backup/FilesystemBackupReader.ts');

// A backup may come from storage the operator does not control: what it names
// (user ids, usernames, attachment entries) must not choose where the restore
// deletes or writes, nor what it reads.

const CUID1_ID = 'cjld2cjxh0000qzrmn831i7rn';
const CUID2_ID = 'tz4a98xxat96iws9zmbrgj3a';

async function * noItems () { /* nothing */ }

function makeUserReader ({ attachments = [] } = {}) {
  return {
    readStreams: noItems,
    readAccesses: noItems,
    readProfile: noItems,
    readWebhooks: noItems,
    readEvents: noItems,
    readAudit: noItems,
    readSeries: noItems,
    async * readAttachments () { for (const a of attachments) yield a; },
    async readAccountData () { return { accountFields: [{ field: 'language', value: 'en' }] }; }
  };
}

function makeReader (users, userReader = makeUserReader()) {
  return {
    async readManifest () { return { formatVersion: 1, backupType: 'full', users }; },
    async openUser () { return userReader; },
    readPlatformData: noItems,
    readServerMappings: noItems
  };
}

// An orchestrator over recording stubs: `writes` lists every storage call
// that would delete or write data.
function makeOrchestrator () {
  const writes = [];
  const record = (name) => (...args) => {
    writes.push(name);
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(null);
  };
  const collection = (name) => ({ importAll: record(name + '.importAll'), clearAll: record(name + '.clearAll') });
  const o = Object.create(RestoreOrchestrator.prototype);
  o.logger = { info () {}, warn () {}, error () {} };
  o.storageLayer = {
    streams: collection('streams'),
    accesses: collection('accesses'),
    profile: collection('profile'),
    webhooks: collection('webhooks'),
    events: collection('events')
  };
  o.usersLocalIndex = {
    async addUser () { writes.push('usersIndex.addUser'); },
    async getUserId () { return null; },
    async getUsername () { return null; }
  };
  o.userAccountStorage = {
    async _importAll () { writes.push('account._importAll'); },
    async setAccountField () { writes.push('account.setAccountField'); },
    async _clearAll () { writes.push('account._clearAll'); }
  };
  o.saved = [];
  o.eventFiles = {
    async saveAttachmentFromStream (stream, userId, eventId, fileId) { writes.push('eventFiles.save'); o.saved.push({ userId, eventId, fileId }); },
    async removeAllForUser () { writes.push('eventFiles.removeAllForUser'); }
  };
  o.auditStorage = null;
  o.seriesConnection = null;
  o.platformDB = null;
  return { o, writes };
}

describe('[BKRS] restore from a backup that names unsafe locations', function () {
  describe('[BKRM] manifest user entries', function () {
    const invalidEntries = [
      { userId: '../../../../tmp/pryv-escape', username: 'validname' },
      { userId: 'cjld2cjxh0000qzrmn831i7rn/..', username: 'validname' },
      { userId: 'short', username: 'validname' },
      { userId: CUID2_ID, username: '../escape' },
      { userId: CUID2_ID, username: 'Upper-Case' },
      { userId: CUID2_ID, username: null }
    ];

    it('[BKRS1] a full restore with an invalid user id or username is refused before anything is written', async function () {
      for (const bad of invalidEntries) {
        const { o, writes } = makeOrchestrator();
        const users = [{ userId: CUID1_ID, username: 'firstuser' }, bad];
        await assert.rejects(() => o.restoreAllUsers(makeReader(users), { skipPlatform: true }), /invalid user id or username/, JSON.stringify(bad));
        assert.deepStrictEqual(writes, [], JSON.stringify(bad));
      }
    });

    it('[BKRS2] a single-user restore of an invalid entry, or to an invalid target id, is refused before anything is written', async function () {
      const { o, writes } = makeOrchestrator();
      const bad = { userId: '../../x/escape', username: 'validname' };
      await assert.rejects(() => o.restoreUser(bad.userId, makeReader([bad]), { overwrite: true }), /invalid user id or username/);
      await assert.rejects(() => o.restoreUser(CUID2_ID, makeReader([{ userId: CUID2_ID, username: 'validname' }]), { overwrite: true, remapUserId: '../../x/escape' }), /invalid user id or username/);
      assert.deepStrictEqual(writes, []);
    });

    it('[BKRS3] ids and usernames this server issues are restored', async function () {
      const { o, writes } = makeOrchestrator();
      const users = [{ userId: CUID1_ID, username: 'olderaccount' }, { userId: CUID2_ID, username: 'newer-account1' }];
      const report = await o.restoreAllUsers(makeReader(users), { skipPlatform: true });
      assert.strictEqual(report.restored.length, 2);
      assert.ok(writes.includes('usersIndex.addUser'));
    });
  });

  describe('[BKRA] attachment entries', function () {
    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-bkrs-')); });
    afterEach(function () { fs.rmSync(tmp, { recursive: true, force: true }); });

    async function writeBackup (dir, { referencedFileId = 'file-ref' } = {}) {
      const writer = createFilesystemBackupWriter(dir, { compress: false });
      const uw = await writer.openUser(CUID2_ID, 'validname');
      await uw.writeEvents([{ id: 'evt1', streamIds: ['s1'], type: 'file/attached', attachments: [{ id: referencedFileId }] }]);
      await uw.writeAttachment('evt1', referencedFileId, Readable.from([Buffer.from('referenced')]));
      await uw.writeAccountData({ accountFields: [{ field: 'language', value: 'en' }] });
      const userManifest = await uw.close();
      await writer.writeManifest({ coreVersion: 'test', config: {}, backupType: 'full', backupTimestamp: 1, userManifests: [userManifest] });
      return path.join(dir, 'users', CUID2_ID, 'attachments');
    }

    async function collect (iterable) {
      const out = [];
      for await (const a of iterable) {
        const chunks = [];
        for await (const c of a.stream) chunks.push(c);
        out.push({ eventId: a.eventId, fileId: a.fileId, data: Buffer.concat(chunks).toString() });
      }
      return out;
    }

    it('[BKRS4] a symbolic link among the attachment files is refused, its target is never read', async function () {
      const backupDir = path.join(tmp, 'backup');
      const attachDir = await writeBackup(backupDir);
      const outside = path.join(tmp, 'outside-secret.txt');
      fs.writeFileSync(outside, 'SECRET-OUTSIDE-THE-BACKUP');
      fs.symlinkSync(outside, path.join(attachDir, 'file-link'));
      const reader = createFilesystemBackupReader(backupDir);
      await reader.readManifest();
      const userReader = await reader.openUser(CUID2_ID);
      let read = [];
      await assert.rejects(async () => { read = await collect(userReader.readAttachments()); }, /not a regular file/);
      assert.ok(!read.some((a) => a.data.includes('SECRET')), 'the link target is not imported');
    });

    it('[BKRS5] a file no event references is reported with no event and is not restored', async function () {
      const backupDir = path.join(tmp, 'backup');
      const attachDir = await writeBackup(backupDir);
      fs.writeFileSync(path.join(attachDir, 'file-orphan'), 'orphan');
      const reader = createFilesystemBackupReader(backupDir);
      await reader.readManifest();
      const userReader = await reader.openUser(CUID2_ID);
      const read = await collect(userReader.readAttachments());
      const byId = Object.fromEntries(read.map((a) => [a.fileId, a.eventId]));
      assert.deepStrictEqual(byId, { 'file-ref': 'evt1', 'file-orphan': null });

      const { o } = makeOrchestrator();
      const reader2 = createFilesystemBackupReader(backupDir);
      await o.restoreUser(CUID2_ID, reader2, { overwrite: true });
      assert.deepStrictEqual(o.saved.map((s) => s.fileId), ['file-ref'], 'only the referenced file is restored');
      assert.deepStrictEqual(o.saved.map((s) => s.eventId), ['evt1']);
    });

    it('[BKRS6] the reader refuses a user id that leaves the backup users folder', async function () {
      const backupDir = path.join(tmp, 'backup');
      await writeBackup(backupDir);
      const reader = createFilesystemBackupReader(backupDir);
      await reader.readManifest();
      for (const userId of ['../platform', '..', '.', '', 'a/b']) {
        await assert.rejects(() => reader.openUser(userId), /Invalid user id in the backup/, JSON.stringify(userId));
      }
    });
  });
});
