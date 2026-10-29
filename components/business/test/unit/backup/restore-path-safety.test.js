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
const { createBackupEncryptor } = require('storages/interfaces/backup/BackupCipher.ts');

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
    // Reads the stream to its end, as the real one does: an unread file stream
    // would still be opening its file when the test removes the backup.
    async saveAttachmentFromStream (stream, userId, eventId, fileId) {
      writes.push('eventFiles.save');
      o.saved.push({ userId, eventId, fileId });
      if (stream != null) await new Promise((resolve, reject) => stream.on('error', reject).on('close', resolve).resume());
    },
    async removeAllForUser () { writes.push('eventFiles.removeAllForUser'); }
  };
  o.auditStorage = null;
  o.seriesConnection = null;
  o.platformDB = null;
  o.isReservedUsername = (name) => RESERVED_FOR_TESTS.has(name.toLowerCase());
  o.isListedUsername = (name) => RESERVED_FOR_TESTS.has(name.toLowerCase()) || LISTED_FOR_TESTS.has(name.toLowerCase());
  return { o, writes };
}

// Stand in for the platform's checks in these tests: the names it routes
// (refused), and words of the registration list (restored, with a warning).
const RESERVED_FOR_TESTS = new Set(['access', 'pryvsupport']);
const LISTED_FOR_TESTS = new Set(['summer']);

function makeReaderWithPlatform (users, { platformRows = [], serverMappings = [] } = {}) {
  return {
    ...makeReader(users),
    async * readPlatformData () { for (const row of platformRows) yield row; },
    async * readServerMappings () { for (const m of serverMappings) yield m; }
  };
}

// A platform store with one available core, recording its writes.
function recordingPlatformDB (writes) {
  return {
    async importAll (rows) { writes.push('platform.importAll:' + rows.length); },
    async getAllCoreInfos () { return [{ id: 'core-one', available: true }]; }
  };
}

describe('[BKRS] restore from a backup that names unsafe locations', function () {
  describe('[BKRM] manifest user entries', function () {
    const invalidEntries = [
      { userId: '../../../../tmp/pryv-escape', username: 'validname' },
      { userId: 'cjld2cjxh0000qzrmn831i7rn/..', username: 'validname' },
      { userId: '..', username: 'validname' },
      { userId: 'a/b', username: 'validname' },
      { userId: 'a\\b', username: 'validname' },
      { userId: 'abc\0def', username: 'validname' },
      { userId: '', username: 'validname' },
      { userId: 'ab', username: 'validname' },
      { userId: 'x'.repeat(65), username: 'validname' },
      { userId: CUID2_ID + '\n', username: 'validname' },
      { userId: null, username: 'validname' },
      { userId: CUID2_ID, username: '../escape' },
      { userId: CUID2_ID, username: '..' },
      { userId: CUID2_ID, username: 'first.last' },
      { userId: CUID2_ID, username: 'a/b' },
      { userId: CUID2_ID, username: 'name\0' },
      { userId: CUID2_ID, username: '' },
      { userId: CUID2_ID, username: 'n'.repeat(65) },
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

    it('[BKRS3] ids and usernames that are one safe path segment are restored, issued by this server or not', async function () {
      const { o, writes } = makeOrchestrator();
      const users = [
        { userId: CUID1_ID, username: 'olderaccount' },
        { userId: CUID2_ID, username: 'newer-account1' },
        { userId: 'legacy_Id-01', username: 'Old_User' },
        { userId: 'x'.repeat(64), username: 'abc' }
      ];
      const report = await o.restoreAllUsers(makeReader(users), { skipPlatform: true });
      assert.strictEqual(report.restored.length, 4);
      assert.ok(writes.includes('usersIndex.addUser'));
    });

    it('[BKRS9] a single-user restore of an id this server does not issue, remapped or not, is restored', async function () {
      const { o, writes } = makeOrchestrator();
      const report = await o.restoreUser('legacy_Id-01', makeReader([{ userId: 'legacy_Id-01', username: 'Old_User' }]), { overwrite: true });
      assert.deepStrictEqual(report.restored, [{ userId: 'legacy_Id-01', username: 'Old_User' }]);
      assert.ok(writes.includes('usersIndex.addUser'));
      const { o: o2 } = makeOrchestrator();
      const report2 = await o2.restoreUser(CUID2_ID, makeReader([{ userId: CUID2_ID, username: 'validname' }]), { overwrite: true, remapUserId: 'remapped_id' });
      assert.deepStrictEqual(report2.restored, [{ userId: 'remapped_id', username: 'validname' }]);
    });
  });

  describe('[BKRV] usernames named by the platform part of a backup', function () {
    it('[BKRN1] a manifest username this platform reserves is refused before anything is written', async function () {
      const { o, writes } = makeOrchestrator();
      const users = [{ userId: CUID1_ID, username: 'firstuser' }, { userId: CUID2_ID, username: 'access' }];
      await assert.rejects(() => o.restoreAllUsers(makeReader(users), { skipPlatform: true }), /invalid or reserved username: "access"/);
      await assert.rejects(() => o.restoreUser(CUID2_ID, makeReader(users), { overwrite: true }), /invalid or reserved username/);
      assert.deepStrictEqual(writes, []);
    });

    it('[BKRL1] an alias this platform reserves, or one that is not a name, refuses the restore before anything is written', async function () {
      for (const aliases of [['r-abcdefgh', 'access'], ['r-abcdefgh', '../x'], [42]]) {
        const { o, writes } = makeOrchestrator();
        const users = [{ userId: CUID1_ID, username: 'firstuser', aliases }];
        await assert.rejects(() => o.restoreAllUsers(makeReader(users), { skipPlatform: true }), /alias\(es\) of the backup manifest/);
        await assert.rejects(() => o.restoreUser(CUID1_ID, makeReader(users)), /alias\(es\) of the backup manifest/);
        assert.deepStrictEqual(writes, []);
      }
    });

    it('[BKRL2] the aliases of each restored account are reserved again, after its data', async function () {
      const { o, writes } = makeOrchestrator();
      o.usersRepository = {
        async restoreAliases (username, userId, aliases) {
          writes.push('aliases:' + username + ':' + aliases.join(','));
          return aliases.filter((a) => a === 'held-elsewhere');
        }
      };
      const users = [{ userId: CUID1_ID, username: 'firstuser', aliases: ['r-abcdefgh', 'held-elsewhere'] }, { userId: CUID2_ID, username: 'seconduser' }];
      const report = await o.restoreAllUsers(makeReader(users), { skipPlatform: true });
      assert.deepStrictEqual(report.aliases, { restored: 1, refused: [{ userId: CUID1_ID, username: 'firstuser', alias: 'held-elsewhere' }] });
      assert.strictEqual(writes[writes.length - 1], 'aliases:firstuser:r-abcdefgh,held-elsewhere', 'reserved last: ' + JSON.stringify(writes));
      assert.strictEqual(writes.filter((w) => w.startsWith('aliases:')).length, 1, 'an entry without aliases reserves nothing');
    });

    it('[BKRN2] a username that is only a word of the registration list is restored, with a warning', async function () {
      const { o, writes } = makeOrchestrator();
      const warnings = [];
      o.logger = { info () {}, warn (msg) { warnings.push(msg); }, error () {} };
      const users = [{ userId: CUID1_ID, username: 'firstuser' }, { userId: CUID2_ID, username: 'summer' }];
      const report = await o.restoreAllUsers(makeReader(users), { skipPlatform: true });
      assert.strictEqual(report.restored.length, 2);
      assert.ok(writes.includes('usersIndex.addUser'));
      assert.deepStrictEqual(warnings.filter((w) => w.includes('"summer"')).length, 1, JSON.stringify(warnings));
      assert.ok(!warnings.some((w) => w.includes('"firstuser"')), JSON.stringify(warnings));
    });

    it('[BKRP1] a platform row or a server mapping naming an invalid or reserved username refuses the restore before any user is written', async function () {
      const users = [{ userId: CUID1_ID, username: 'firstuser' }];
      const goodRow = { username: 'firstuser', field: 'email', value: 'first@example.com', isUnique: true };
      const cases = [
        { platformRows: [goodRow, { username: 'bad.name', field: 'email', value: 'x@example.com', isUnique: true }] },
        { platformRows: [goodRow, { username: 'PryvSupport', field: 'language', value: 'en', isUnique: false }] },
        { platformRows: [goodRow, { key: 'user-unique/email/y@example.com', value: '../escape' }] },
        { platformRows: [goodRow, { field: 'email', value: 'z@example.com', isUnique: true }] },
        { platformRows: [goodRow], serverMappings: [{ username: 'firstuser' }, { username: 'access' }] },
        { platformRows: [goodRow], serverMappings: [{ username: 'first/user' }] }
      ];
      for (const backup of cases) {
        const { o, writes } = makeOrchestrator();
        o.platformDB = recordingPlatformDB(writes);
        await assert.rejects(() => o.restoreAllUsers(makeReaderWithPlatform(users, backup)), /invalid or reserved username/, JSON.stringify(backup));
        assert.deepStrictEqual(writes, [], JSON.stringify(backup));
      }
      // control: valid rows are restored after the users
      const { o, writes } = makeOrchestrator();
      o.platformDB = recordingPlatformDB(writes);
      await o.restoreAllUsers(makeReaderWithPlatform(users, { platformRows: [goodRow, { key: 'user-indexed/language/firstuser', value: 'en' }] }));
      assert.strictEqual(writes[writes.length - 1], 'platform.importAll:2');
      assert.ok(writes.indexOf('usersIndex.addUser') < writes.indexOf('platform.importAll:2'));
    });

    it('[RSOW1] a single-user restore never overwrites an account that now holds the username, even with overwrite', async function () {
      const { o, writes } = makeOrchestrator();
      o.usersLocalIndex.getUserId = async () => 'another-account-id';
      await assert.rejects(() => o.restoreUser(CUID2_ID, makeReader([{ userId: CUID2_ID, username: 'validname' }]), { overwrite: true }),
        /already exists with userId "another-account-id".*Nothing was restored/);
      assert.deepStrictEqual(writes, []);
      // the same account restored over itself still is
      const { o: same, writes: sameWrites } = makeOrchestrator();
      same.usersLocalIndex.getUserId = async () => CUID2_ID;
      await same.restoreUser(CUID2_ID, makeReader([{ userId: CUID2_ID, username: 'validname' }]), { overwrite: true });
      assert.ok(sameWrites.includes('usersIndex.addUser'));
    });
  });

  describe('[BKRA] attachment entries', function () {
    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-bkrs-')); });
    afterEach(function () { fs.rmSync(tmp, { recursive: true, force: true }); });

    async function writeBackup (dir, { referencedFileId = 'file-ref', encryptor = null, orphan = null } = {}) {
      const writer = createFilesystemBackupWriter(dir, { compress: false, encryptor });
      const uw = await writer.openUser(CUID2_ID, 'validname');
      await uw.writeEvents([{ id: 'evt1', streamIds: ['s1'], type: 'file/attached', attachments: [{ id: referencedFileId }] }]);
      await uw.writeAttachment('evt1', referencedFileId, Readable.from([Buffer.from('referenced')]));
      // A file no event references, written (and encrypted) like the others
      if (orphan != null) await uw.writeAttachment('evt1', 'file-orphan', Readable.from([orphan]));
      await uw.writeAccountData({ accountFields: [{ field: 'language', value: 'en' }] });
      const userManifest = await uw.close();
      await writer.writeManifest({ coreVersion: 'test', config: {}, backupType: 'full', backupTimestamp: 1, userManifests: [userManifest] });
      if (encryptor != null) await writer.close();
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
      // Every attachment stream the reader hands out, to check none is left open
      const reader2 = createFilesystemBackupReader(backupDir);
      const handedOut = [];
      const openUser = reader2.openUser.bind(reader2);
      reader2.openUser = async (...args) => {
        const userReader = await openUser(...args);
        const readAttachments = userReader.readAttachments.bind(userReader);
        userReader.readAttachments = async function * () {
          for await (const a of await readAttachments()) { handedOut.push(a); yield a; }
        };
        return userReader;
      };
      await o.restoreUser(CUID2_ID, reader2, { overwrite: true });
      assert.deepStrictEqual(o.saved.map((s) => s.fileId), ['file-ref'], 'only the referenced file is restored');
      assert.deepStrictEqual(o.saved.map((s) => s.eventId), ['evt1']);
      // The file not restored included: its stream is closed by the time the
      // restore returns, so removing the backup next cannot fail under it.
      assert.deepStrictEqual(handedOut.map((a) => [a.fileId, a.stream.closed]).sort(), [['file-orphan', true], ['file-ref', true]]);
    });

    it('[BKRSA] the restore returns only once the stream of a file it does not restore is closed', async function () {
      // A stream whose opening completes later, as a file stream's open does on
      // a busy server: destroying it does not cancel that opening.
      let closedAt = null;
      const slowToOpen = new Readable({
        construct (callback) { setTimeout(callback, 50); },
        read () { this.push(null); }
      });
      slowToOpen.once('close', () => { closedAt = Date.now(); });
      const userReader = makeUserReader({ attachments: [{ eventId: null, fileId: 'file-orphan', stream: slowToOpen }] });
      const { o } = makeOrchestrator();
      await o.restoreUser(CUID2_ID, makeReader([{ userId: CUID2_ID, username: 'validname' }], userReader), { overwrite: true });
      assert.ok(closedAt != null && slowToOpen.closed, 'the stream is closed when the restore returns');
      assert.deepStrictEqual(o.saved, [], 'nothing restored');
    });

    // Open descriptors of this process (macOS and Linux)
    function openFds () { return fs.readdirSync('/dev/fd').length; }

    async function fdsBackTo (count, withinMs) {
      const until = Date.now() + withinMs;
      while (openFds() > count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      return openFds();
    }

    it('[BKRSB] in an encrypted backup, a file the restore does not restore leaves no descriptor open and raises nothing once the backup is gone', async function () {
      const backupDir = path.join(tmp, 'backup');
      const encryptor = createBackupEncryptor({ passphrase: 'pw' });
      // Larger than one read, so the file is still open when the restore lets it go
      await writeBackup(backupDir, { encryptor, orphan: Buffer.alloc(1024 * 1024, 7) });
      const before = openFds();
      const { o } = makeOrchestrator();
      await o.restoreUser(CUID2_ID, createFilesystemBackupReader(backupDir, { secrets: { passphrase: 'pw' } }), { overwrite: true });
      assert.deepStrictEqual(o.saved.map((s) => s.fileId), ['file-ref'], 'only the referenced file is restored');
      // The backup removed at once, as a cleanup would: nothing may still be opening a file in it
      fs.rmSync(backupDir, { recursive: true, force: true });
      assert.strictEqual(await fdsBackTo(before, 2000), before, 'every descriptor the restore opened is closed');
    });

    it('[BKRSC] a stream that never closes does not stall the restore; it is reported', async function () {
      const neverCloses = new Readable({ emitClose: false, read () {} });
      const userReader = makeUserReader({ attachments: [{ eventId: null, fileId: 'file-orphan', stream: neverCloses }] });
      const { o } = makeOrchestrator();
      const warnings = [];
      o.logger = { info () {}, warn (msg) { warnings.push(msg); }, error () {} };
      o.discardTimeoutMs = 50;
      await o.restoreUser(CUID2_ID, makeReader([{ userId: CUID2_ID, username: 'validname' }], userReader), { overwrite: true });
      assert.ok(warnings.some((w) => w.includes('file-orphan') && w.includes('did not close')), JSON.stringify(warnings));
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

    // Moves `dir` out of the backup (into `tmp`) and leaves a symbolic link to it in its place.
    function replaceByLink (dir, outsideName) {
      const outside = path.join(tmp, outsideName);
      fs.renameSync(dir, outside);
      fs.symlinkSync(outside, dir);
      return outside;
    }

    it('[BKRS7] an attachments directory, a user directory or a users directory that is a symbolic link is refused before any file is read through it', async function () {
      // attachments/ is a link to a directory holding a file named like a referenced attachment
      const backupDir = path.join(tmp, 'backup');
      const attachDir = await writeBackup(backupDir);
      const outsideAttach = path.join(tmp, 'outside-attach');
      fs.mkdirSync(outsideAttach);
      fs.writeFileSync(path.join(outsideAttach, 'file-ref'), 'SECRET-OUTSIDE-THE-BACKUP');
      fs.rmSync(attachDir, { recursive: true });
      fs.symlinkSync(outsideAttach, attachDir);
      const reader = createFilesystemBackupReader(backupDir);
      await reader.readManifest();
      const userReader = await reader.openUser(CUID2_ID);
      let read = [];
      await assert.rejects(async () => { read = await collect(userReader.readAttachments()); }, /not a directory of the backup/);
      assert.deepStrictEqual(read, [], 'nothing is yielded from the link target');
      const { o } = makeOrchestrator();
      await assert.rejects(() => o.restoreUser(CUID2_ID, createFilesystemBackupReader(backupDir), { overwrite: true }), /not a directory of the backup/);
      assert.deepStrictEqual(o.saved, [], 'no attachment is restored');

      // users/<id> is a link to a user directory outside the backup
      const backupDir2 = path.join(tmp, 'backup2');
      await writeBackup(backupDir2);
      replaceByLink(path.join(backupDir2, 'users', CUID2_ID), 'outside-user');
      const reader2 = createFilesystemBackupReader(backupDir2);
      await reader2.readManifest();
      await assert.rejects(() => reader2.openUser(CUID2_ID), /not a directory of the backup/);

      // users/ is a link to a directory outside the backup
      const backupDir3 = path.join(tmp, 'backup3');
      await writeBackup(backupDir3);
      replaceByLink(path.join(backupDir3, 'users'), 'outside-users');
      const reader3 = createFilesystemBackupReader(backupDir3);
      await reader3.readManifest();
      await assert.rejects(() => reader3.openUser(CUID2_ID), /not a directory of the backup/);
    });

    it('[BKRS8] a user data file or an events directory that is a symbolic link is refused, a backup root that is a link is read', async function () {
      const backupDir = path.join(tmp, 'backup');
      await writeBackup(backupDir);
      const userDir = path.join(backupDir, 'users', CUID2_ID);

      // the account file is a link to a file outside the backup
      const outsideAccount = path.join(tmp, 'outside-account.jsonl');
      fs.writeFileSync(outsideAccount, JSON.stringify({ secret: 'SECRET-OUTSIDE-THE-BACKUP' }) + '\n');
      fs.rmSync(path.join(userDir, 'account.jsonl'));
      fs.symlinkSync(outsideAccount, path.join(userDir, 'account.jsonl'));
      // events/ is a link to a directory outside the backup holding an events chunk
      const outsideEvents = path.join(tmp, 'outside-events');
      fs.mkdirSync(outsideEvents);
      fs.writeFileSync(path.join(outsideEvents, 'events-0001.jsonl'), JSON.stringify({ id: 'outside', content: 'SECRET-OUTSIDE-THE-BACKUP' }) + '\n');
      fs.rmSync(path.join(userDir, 'events'), { recursive: true });
      fs.symlinkSync(outsideEvents, path.join(userDir, 'events'));

      const reader = createFilesystemBackupReader(backupDir);
      await reader.readManifest();
      const userReader = await reader.openUser(CUID2_ID);
      await assert.rejects(() => userReader.readAccountData(), /is a symbolic link: refused/);
      const events = [];
      await assert.rejects(async () => { for await (const e of userReader.readEvents()) events.push(e); }, /not a directory of the backup/);
      assert.deepStrictEqual(events, []);

      // positive control: the operator may point the restore at a link to the backup
      const cleanDir = path.join(tmp, 'clean');
      await writeBackup(cleanDir);
      const rootLink = path.join(tmp, 'root-link');
      fs.symlinkSync(cleanDir, rootLink);
      const linkedReader = createFilesystemBackupReader(rootLink);
      await linkedReader.readManifest();
      const linkedUser = await linkedReader.openUser(CUID2_ID);
      assert.deepStrictEqual((await collect(linkedUser.readAttachments())).map((a) => [a.fileId, a.eventId, a.data]), [['file-ref', 'evt1', 'referenced']]);
      assert.ok(await linkedUser.readAccountData());
    });
  });
});
