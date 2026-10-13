/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createFilesystemBackupWriter } = require('storages/interfaces/backup/FilesystemBackupWriter.ts');
const { createFilesystemBackupReader } = require('storages/interfaces/backup/FilesystemBackupReader.ts');
const { createBackupEncryptor, createBackupDecryptor } = require('storages/interfaces/backup/BackupCipher.ts');
const { BackupOrchestrator } = require('business/src/backup/BackupOrchestrator.ts');

// The chain helpers are loaded where a test needs them.
const chainApi = () => require('storages/interfaces/backup/chain.ts');

// A full backup and the incremental runs written after it into the same
// directory: each run in its own directory, restore merging them newest first.

const CHAIN_ID = 'c0ffee'.padEnd(32, '0');
const INC1_ID = '20261013T142501Z-3f9a1c7e';
const INC2_ID = '20261014T142501Z-0a0b0c0d';
const FULL = { runId: 'full', path: '.', parentRunId: null, chainId: CHAIN_ID };
const INC1 = { runId: INC1_ID, path: 'incrementals/' + INC1_ID, parentRunId: 'full', chainId: CHAIN_ID };
const INC2 = { runId: INC2_ID, path: 'incrementals/' + INC2_ID, parentRunId: INC1_ID, chainId: CHAIN_ID };

/** Write one run with the filesystem writer: `users` per user, then platform rows and the manifest. */
async function writeRun (dir, { run = null, encryptor = null, compress = false, snapshotBefore = 1000, users = [], platform = null, backupType, scope } = {}) {
  const writer = createFilesystemBackupWriter(dir, { compress, encryptor, run });
  const manifests = [];
  for (const u of users) {
    const uw = await writer.openUser(u.userId, u.username);
    await uw.writeStreams(u.streams ?? []);
    await uw.writeAccesses(u.accesses ?? []);
    await uw.writeProfile(u.profile ?? []);
    await uw.writeWebhooks(u.webhooks ?? []);
    await uw.writeEvents(u.events ?? []);
    for (const a of u.attachments ?? []) await uw.writeAttachment(a.eventId, a.fileId, Readable.from([Buffer.from(a.data)]));
    if (u.account) await uw.writeAccountData(u.account);
    if (u.audit) await uw.writeAudit(u.audit);
    if (u.series) await uw.writeSeries(u.series);
    manifests.push(await uw.close());
  }
  if (platform) await writer.writePlatformData(platform);
  await writer.writeManifest({
    coreVersion: 'test',
    config: {},
    backupType: backupType ?? (run != null && run.path !== '.' ? 'incremental' : 'full'),
    snapshotBefore,
    backupTimestamp: snapshotBefore * 1000 + 5000,
    userManifests: manifests,
    scope
  });
  await writer.close();
}

async function collect (iterable) {
  const out = [];
  for await (const item of await iterable) out.push(item);
  return out;
}

async function collectAttachments (iterable) {
  const out = {};
  for await (const a of await iterable) {
    const chunks = [];
    for await (const c of a.stream) chunks.push(Buffer.from(c));
    out[a.fileId] = { eventId: a.eventId, data: Buffer.concat(chunks).toString() };
  }
  return out;
}

const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

/** Every file below `root` (relative path -> sha256), skipping `skip` (relative paths or prefixes). */
function snapshotFiles (root, skip = []) {
  const out = {};
  (function walk (dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p);
      if (skip.some((s) => rel === s || rel.startsWith(s + path.sep))) continue;
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  })(root);
  return out;
}

// The full run and one incremental run of account u1 (and u2, u3) used by several tests.
const fullUsers = () => [{
  userId: 'u1-full-and-inc',
  username: 'alice',
  streams: [{ id: 's1', name: 'One', modified: 10 }, { id: 's2', name: 'Two', modified: 10 }, { id: 's3', name: 'Three', modified: 10 }],
  accesses: [{ id: 'a1', name: 'app', modified: 10 }, { id: 'a2', name: 'other', modified: 10 }],
  webhooks: [{ id: 'w1', url: 'https://example.com/one', modified: 10 }, { id: 'w2', url: 'https://example.com/two', modified: 10 }],
  events: [
    { id: 'e1', streamIds: ['s1'], content: 'e1 unchanged', modified: 10, attachments: [{ id: 'f1' }] },
    { id: 'e2', streamIds: ['s1'], content: 'e2 old', modified: 10, attachments: [{ id: 'f2' }] },
    { id: 'e3', streamIds: ['s1'], content: 'e3 old', modified: 10, attachments: [{ id: 'f3' }] },
    { id: 'e4', streamIds: ['s1'], content: 'e4 to delete', modified: 10 },
    { id: 'e5', streamIds: ['s2'], content: 'e5 unchanged', modified: 10 }
  ],
  attachments: [
    { eventId: 'e1', fileId: 'f1', data: 'F1 from the full run' },
    { eventId: 'e2', fileId: 'f2', data: 'F2 from the full run' },
    { eventId: 'e3', fileId: 'f3', data: 'F3 from the full run' }
  ],
  audit: [{ eventid: 'au1', type: 'audit/log', time: 10, content: 'first' }],
  profile: [{ id: 'public', data: { v: 1 } }],
  account: { accountFields: [{ field: 'language', value: 'en' }] },
  series: [{ measurement: 'm', value: 1 }]
}, {
  userId: 'u2-full-only',
  username: 'bob',
  streams: [{ id: 'b1', name: 'Bob stream', modified: 10 }]
}];

const incUsers = () => [{
  userId: 'u1-full-and-inc',
  username: 'alice',
  streams: [{ id: 's1', name: 'One renamed', modified: 1100 }, { id: 's3', deleted: 1100 }],
  accesses: [{ id: 'a1', name: 'app renamed', modified: 1100 }, { id: 'a2', name: 'other', modified: 10, deleted: 1100 }],
  webhooks: [{ id: 'w2', url: 'https://example.com/two', modified: 10, deleted: 1100 }],
  events: [
    { id: 'e2', streamIds: ['s1'], content: 'e2 new', modified: 1100, attachments: [{ id: 'f2' }] },
    { id: 'e3', streamIds: ['s1'], content: 'e3 without its file', modified: 1100 },
    { id: 'e4', deleted: 1100 },
    { id: 'e6', streamIds: ['s2'], content: 'e6 new', modified: 1100 }
  ],
  attachments: [{ eventId: 'e2', fileId: 'f2', data: 'F2 from the incremental run' }],
  audit: [{ eventid: 'au2', type: 'audit/log', time: 1100, content: 'second' }],
  profile: [{ id: 'public', data: { v: 2 } }],
  account: { accountFields: [{ field: 'language', value: 'fr' }] }
}, {
  userId: 'u3-inc-only',
  username: 'carol',
  streams: [{ id: 'c1', name: 'Carol stream', modified: 1100 }]
}];

describe('[BKCH] backup chain: incremental runs next to the full backup', function () {
  let tmp;
  beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-bkch-')); });
  afterEach(function () { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('[BKC1] an incremental run leaves every file of the full run byte-identical and writes under incrementals/<runId>/', async function () {
    const dir = path.join(tmp, 'backup');
    await writeRun(dir, { run: FULL, compress: true, users: fullUsers(), platform: [{ username: 'alice', field: 'email', value: 'a@example.com', isUnique: true }] });
    const before = snapshotFiles(dir, ['chain.json']);
    assert.ok(before[path.join('users', 'u1-full-and-inc', 'streams.jsonl.gz')], 'the full run wrote its streams');

    await writeRun(dir, { run: INC1, compress: true, snapshotBefore: 2000, users: incUsers(), platform: [{ username: 'alice', field: 'email', value: 'a2@example.com', isUnique: true }] });

    const after = snapshotFiles(dir, ['chain.json', 'incrementals']);
    for (const [rel, hash] of Object.entries(before)) {
      assert.strictEqual(after[rel], hash, `${rel} of the full run changed`);
    }
    assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'the incremental run wrote nothing at the root but chain.json');

    const runDir = path.join(dir, 'incrementals', INC1_ID);
    assert.ok(fs.existsSync(path.join(runDir, 'manifest.json')), 'the run has its own manifest');
    assert.ok(fs.existsSync(path.join(runDir, 'users', 'u1-full-and-inc', 'streams.jsonl.gz')), 'the delta is under the run');
    assert.ok(fs.existsSync(path.join(runDir, 'platform', 'platform.jsonl.gz')));

    const chain = JSON.parse(fs.readFileSync(path.join(dir, 'chain.json'), 'utf8'));
    assert.strictEqual(chain.chainId, CHAIN_ID);
    assert.strictEqual(chain.encryption, null);
    assert.deepStrictEqual(chain.runs.map((r) => [r.runId, r.path, r.backupType, r.parentRunId]), [
      ['full', '.', 'full', null],
      [INC1_ID, 'incrementals/' + INC1_ID, 'incremental', 'full']
    ]);
    assert.deepStrictEqual(chain.runs[0].users, ['u1-full-and-inc', 'u2-full-only']);
    assert.deepStrictEqual(chain.runs[1].users, ['u1-full-and-inc', 'u3-inc-only']);
    assert.deepStrictEqual(chain.runs.map((r) => r.snapshotBefore), [1000, 2000]);
    const incManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual([incManifest.chainId, incManifest.runId, incManifest.parentRunId, incManifest.backupType], [CHAIN_ID, INC1_ID, 'full', 'incremental']);
  });

  it('[BKC2] restore reads the merged chain: newer versions and deletions replace older ones, whole files from the newest run', async function () {
    const dir = path.join(tmp, 'backup');
    await writeRun(dir, { run: FULL, users: fullUsers(), platform: [{ username: 'alice', field: 'email', value: 'a@example.com', isUnique: true }] });
    await writeRun(dir, { run: INC1, snapshotBefore: 2000, users: incUsers(), platform: [{ username: 'alice', field: 'email', value: 'a2@example.com', isUnique: true }] });

    const reader = createFilesystemBackupReader(dir);
    const manifest = await reader.readManifest();
    assert.deepStrictEqual(manifest.users.map((u) => u.userId), ['u1-full-and-inc', 'u2-full-only', 'u3-inc-only'], 'every user of the chain');
    assert.deepStrictEqual(manifest.runs.map((r) => r.runId), ['full', INC1_ID]);

    const ur = await reader.openUser('u1-full-and-inc');
    const streams = await collect(ur.readStreams());
    assert.strictEqual(streams.length, 3, 'one version per stream');
    const s = byId(streams);
    assert.strictEqual(s.s1.name, 'One renamed');
    assert.strictEqual(s.s2.name, 'Two', 'a stream only in the full run stays');
    assert.deepStrictEqual(s.s3, { id: 's3', deleted: 1100 }, 'a deletion replaces the stream');

    const a = byId(await collect(ur.readAccesses()));
    assert.deepStrictEqual(Object.keys(a).sort(), ['a1', 'a2']);
    assert.strictEqual(a.a1.name, 'app renamed');
    assert.strictEqual(a.a2.deleted, 1100);

    const w = byId(await collect(ur.readWebhooks()));
    assert.strictEqual(w.w1.url, 'https://example.com/one');
    assert.strictEqual(w.w2.deleted, 1100);

    const events = await collect(ur.readEvents());
    assert.strictEqual(events.length, 6, 'one version per event');
    const e = byId(events);
    assert.strictEqual(e.e1.content, 'e1 unchanged');
    assert.strictEqual(e.e2.content, 'e2 new');
    assert.strictEqual(e.e3.content, 'e3 without its file');
    assert.deepStrictEqual(e.e4, { id: 'e4', deleted: 1100 });
    assert.strictEqual(e.e5.content, 'e5 unchanged');
    assert.strictEqual(e.e6.content, 'e6 new');

    const audit = await collect(ur.readAudit());
    assert.deepStrictEqual(audit.map((r) => r.eventid).sort(), ['au1', 'au2']);

    assert.deepStrictEqual(await collectAttachments(ur.readAttachments()), {
      f1: { eventId: 'e1', data: 'F1 from the full run' },
      f2: { eventId: 'e2', data: 'F2 from the incremental run' },
      f3: { eventId: null, data: 'F3 from the full run' }
    });

    assert.deepStrictEqual(await collect(ur.readProfile()), [{ id: 'public', data: { v: 2 } }]);
    assert.deepStrictEqual(await ur.readAccountData(), { accountFields: [{ field: 'language', value: 'fr' }] });
    assert.deepStrictEqual(await collect(ur.readSeries()), [{ measurement: 'm', value: 1 }], 'series from the newest run that has them');

    assert.deepStrictEqual((await collect((await reader.openUser('u2-full-only')).readStreams())).map((x) => x.id), ['b1']);
    assert.deepStrictEqual((await collect((await reader.openUser('u3-inc-only')).readStreams())).map((x) => x.id), ['c1']);
    assert.deepStrictEqual(await collect(reader.readPlatformData()), [{ username: 'alice', field: 'email', value: 'a2@example.com', isUnique: true }]);
  });

  it('[BKC3] the window of an incremental run starts at the previous run\'s snapshot time minus the overlap, not at its close time', function () {
    const orch = Object.create(BackupOrchestrator.prototype);
    const chain = {
      formatVersion: 1,
      chainId: CHAIN_ID,
      encryption: null,
      runs: [
        { runId: 'full', path: '.', backupType: 'full', parentRunId: null, snapshotBefore: 100, users: ['u1', 'u2'] },
        { runId: INC1_ID, path: 'incrementals/' + INC1_ID, backupType: 'incremental', parentRunId: 'full', snapshotBefore: 500, users: ['u2'] }
      ]
    };
    // The previous run closed at 105 s (its per-user backupTimestamp), after its export.
    const previousManifest = { users: [{ userId: 'u1', backupTimestamp: 105000 }, { userId: 'u2', backupTimestamp: 505000 }] };
    const since = orch._buildPerUserSince({ incremental: true, previousManifest, chain });
    assert.deepStrictEqual(since, { u1: 100 - 60, u2: 500 - 60 });
    // Written at 103 s, after the full run's snapshot (100) and before its close (105): in no run until now.
    assert.strictEqual(orch._passesTimestampFilter({ id: 'x', modified: 103 }, 1000, since.u1), true);
    assert.strictEqual(since.u3, undefined, 'a user no run exported is exported in full');
  });

  it('[BKC4] a deletion counts as a change of the item', function () {
    const orch = Object.create(BackupOrchestrator.prototype);
    assert.strictEqual(orch._passesTimestampFilter({ modified: 50, deleted: 150 }, 1000, 100), true);
    assert.strictEqual(orch._passesTimestampFilter({ modified: 50 }, 1000, 100), false, 'control: unchanged since');
    assert.strictEqual(orch._passesTimestampFilter({ modified: 50, deleted: 1500 }, 1000, 100), false, 'deleted after the snapshot: next run');
    assert.strictEqual(orch._passesTimestampFilter({ id: 'x', deleted: 150 }, 1000, 100), true, 'a deletion row without modified');
  });

  describe('[BKC5] encrypted chains', function () {
    function rsaKeypair () {
      return crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
    }

    // The encrypted files of a run (relative to the backup root), cleartext files left out.
    function runFiles (dir, runPath) {
      const root = path.join(dir, runPath);
      const cleartext = new Set(['encryption.json', 'chain.json', 'RESTORE-README.md', 'decrypt-backup.mjs']);
      return Object.keys(snapshotFiles(root, runPath === '.' ? ['incrementals'] : []))
        .filter((rel) => !cleartext.has(path.basename(rel)))
        .map((rel) => path.join(runPath, rel));
    }

    it('[BKC5] each run has its own envelope and key, the key model of the chain is kept, a wrong secret is refused before anything is written', async function () {
      // Symmetric: two runs under the same passphrase, two envelopes.
      const dir = path.join(tmp, 'sym');
      const enc1 = createBackupEncryptor({ passphrase: 'pw' });
      await writeRun(dir, { run: FULL, encryptor: enc1, users: fullUsers() });
      const enc2 = createBackupEncryptor({ passphrase: 'pw' });
      await writeRun(dir, { run: INC1, encryptor: enc2, snapshotBefore: 2000, users: incUsers() });
      const incEnvelopePath = path.join(dir, 'incrementals', INC1_ID, 'encryption.json');
      assert.ok(fs.existsSync(incEnvelopePath), 'the incremental run has its own encryption.json');
      const env1 = JSON.parse(fs.readFileSync(path.join(dir, 'encryption.json'), 'utf8'));
      const env2 = JSON.parse(fs.readFileSync(incEnvelopePath, 'utf8'));
      assert.deepStrictEqual(env1, enc1.envelope, 'the full run\'s envelope is untouched');
      assert.notStrictEqual(env1.salt, env2.salt, 'one key per run');
      const dec1 = createBackupDecryptor(env1, { passphrase: 'pw' });
      const dec2 = createBackupDecryptor(env2, { passphrase: 'pw' });
      for (const [runPath, own, other] of [['.', dec1, dec2], ['incrementals/' + INC1_ID, dec2, dec1]]) {
        const files = runFiles(dir, runPath);
        assert.ok(files.length >= 5, runPath + ': several files');
        let checked = 0;
        for (const rel of files) {
          const bytes = fs.readFileSync(path.join(dir, rel));
          // An empty file has no frame to authenticate: it says nothing about its key.
          if (own.decryptBuffer(bytes).length === 0) continue;
          assert.throws(() => other.decryptBuffer(bytes), rel + ' does not decrypt with the other run\'s envelope');
          checked++;
        }
        assert.ok(checked >= 4, runPath + ': files checked against the other key: ' + checked);
      }
      const chainText = fs.readFileSync(path.join(dir, 'chain.json'), 'utf8');
      assert.deepStrictEqual(JSON.parse(chainText).encryption, { mode: 'symmetric' });
      for (const marker of ['alice', 'One renamed', 'e2 new']) assert.ok(!chainText.includes(marker), 'chain.json names no user data: ' + marker);
      // The merged chain reads back with the one passphrase.
      const reader = createFilesystemBackupReader(dir, { secrets: { passphrase: 'pw' } });
      await reader.readManifest();
      const ur = await reader.openUser('u1-full-and-inc');
      assert.strictEqual(byId(await collect(ur.readEvents())).e2.content, 'e2 new');
      assert.strictEqual((await collectAttachments(ur.readAttachments())).f1.data, 'F1 from the full run');

      const { planBackupRun } = chainApi();
      const incDir = path.join(dir, 'incrementals');
      const runsBefore = fs.readdirSync(incDir);
      assert.throws(() => planBackupRun(dir, { incremental: true, passphrase: 'wrong' }), /passphrase does not decrypt/);
      assert.throws(() => planBackupRun(dir, { incremental: true }), /is encrypted \(symmetric\)/, 'an encrypted chain refuses a plaintext run');
      const { publicKey, privateKey } = rsaKeypair();
      assert.throws(() => planBackupRun(dir, { incremental: true, recipientPubKeyPem: publicKey }), /encrypted symmetric and this run asks for hybrid/);
      assert.deepStrictEqual(fs.readdirSync(incDir), runsBefore, 'nothing written by a refused run');
      const plan = planBackupRun(dir, { incremental: true, passphrase: 'pw' });
      assert.strictEqual(plan.parentRunId, INC1_ID);
      assert.match(plan.runId, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
      // The writer refuses a run whose key model is not the chain's.
      assert.throws(() => createFilesystemBackupWriter(dir, { encryptor: null, run: plan }), /key model/);

      // Hybrid: the incremental run needs the public key only.
      const hdir = path.join(tmp, 'hybrid');
      await writeRun(hdir, { run: FULL, encryptor: createBackupEncryptor({ recipientPubKeyPem: publicKey }), users: fullUsers() });
      const hplan = planBackupRun(hdir, { incremental: true, recipientPubKeyPem: publicKey });
      await writeRun(hdir, { run: hplan, encryptor: createBackupEncryptor({ recipientPubKeyPem: publicKey }), snapshotBefore: 2000, users: incUsers() });
      const hreader = createFilesystemBackupReader(hdir, { secrets: { privateKeyPem: privateKey } });
      await hreader.readManifest();
      const hur = await hreader.openUser('u1-full-and-inc');
      assert.strictEqual(byId(await collect(hur.readStreams())).s1.name, 'One renamed');
      const other = rsaKeypair();
      assert.throws(() => planBackupRun(hdir, { incremental: true, recipientPubKeyPem: other.publicKey }), /recipient key differs/);
      assert.throws(() => planBackupRun(hdir, { incremental: true, passphrase: 'pw' }), /encrypted hybrid and this run asks for symmetric/);

      // Plaintext chain: an encrypting run is refused.
      const pdir = path.join(tmp, 'plain');
      await writeRun(pdir, { run: FULL, users: fullUsers() });
      assert.throws(() => planBackupRun(pdir, { incremental: true, passphrase: 'pw' }), /is plaintext/);
      assert.throws(() => planBackupRun(pdir, { incremental: true, recipientPubKeyPem: publicKey }), /is plaintext/);
      assert.ok(!fs.existsSync(path.join(pdir, 'incrementals')));
    });
  });

  it('[BKC6] a full backup written before chains reads as one run and can be continued; a directory an old incremental run overwrote is refused', async function () {
    // Written by the writer as earlier releases did: no run, no chain.json.
    const legacy = path.join(tmp, 'legacy');
    const enc = createBackupEncryptor({ passphrase: 'pw' });
    await writeRun(legacy, { encryptor: enc, users: fullUsers() });
    assert.ok(!fs.existsSync(path.join(legacy, 'chain.json')));

    async function readAll (reader) {
      const manifest = await reader.readManifest();
      const ur = await reader.openUser('u1-full-and-inc');
      return {
        users: manifest.users.map((u) => u.userId),
        streams: await collect(ur.readStreams()),
        accesses: await collect(ur.readAccesses()),
        events: await collect(ur.readEvents()),
        account: await ur.readAccountData(),
        attachments: await collectAttachments(ur.readAttachments())
      };
    }
    const viaDecryptor = await readAll(createFilesystemBackupReader(legacy, { decryptor: createBackupDecryptor(enc.envelope, { passphrase: 'pw' }) }));
    assert.deepStrictEqual(viaDecryptor.streams, fullUsers()[0].streams);
    assert.deepStrictEqual(viaDecryptor.events, fullUsers()[0].events);
    assert.strictEqual(viaDecryptor.attachments.f3.eventId, 'e3');

    // The old in-place incremental left a root manifest saying "incremental" and no chain.json.
    const damaged = path.join(tmp, 'damaged');
    await writeRun(damaged, { users: incUsers(), backupType: 'incremental' });
    await assert.rejects(() => createFilesystemBackupReader(damaged).readManifest(), /holds only the delta of an incremental run that overwrote its full backup/);
    assert.throws(() => chainApi().planBackupRun(damaged, { incremental: true }), /damaged by an incremental run of a version before/);
    const delta = createFilesystemBackupReader(damaged, { allowIncomplete: true });
    assert.deepStrictEqual((await delta.readManifest()).users.map((u) => u.userId), ['u1-full-and-inc', 'u3-inc-only']);
    assert.deepStrictEqual((await collect((await delta.openUser('u1-full-and-inc')).readStreams())).map((x) => x.id), ['s1', 's3']);

    // The same backup read with the secret instead of a decryptor: identical.
    assert.deepStrictEqual(await readAll(createFilesystemBackupReader(legacy, { secrets: { passphrase: 'pw' } })), viaDecryptor);

    // An incremental run into it starts the chain from its manifest, which stays as it is.
    const rootManifest = fs.readFileSync(path.join(legacy, 'manifest.json'));
    const plan = chainApi().planBackupRun(legacy, { incremental: true, passphrase: 'pw' });
    assert.strictEqual(plan.baseChain.runs.length, 1);
    assert.strictEqual(plan.baseChain.runs[0].bootstrapped, true);
    assert.deepStrictEqual(plan.baseChain.runs[0].users, ['u1-full-and-inc', 'u2-full-only']);
    await writeRun(legacy, { run: plan, encryptor: createBackupEncryptor({ passphrase: 'pw' }), snapshotBefore: 2000, users: incUsers() });
    assert.deepStrictEqual(fs.readFileSync(path.join(legacy, 'manifest.json')), rootManifest);
    const chain = JSON.parse(fs.readFileSync(path.join(legacy, 'chain.json'), 'utf8'));
    assert.deepStrictEqual(chain.runs.map((r) => r.runId), ['full', plan.runId]);
    const merged = await readAll(createFilesystemBackupReader(legacy, { secrets: { passphrase: 'pw' } }));
    assert.deepStrictEqual(merged.users, ['u1-full-and-inc', 'u2-full-only', 'u3-inc-only']);
    assert.strictEqual(byId(merged.events).e2.content, 'e2 new');
    assert.strictEqual(byId(merged.events).e5.content, 'e5 unchanged');
  });

  it('[BKC7] a chain with a missing run is refused by name; --through-run restores a prefix; strays and foreign runs', async function () {
    const dir = path.join(tmp, 'backup');
    await writeRun(dir, { run: FULL, users: fullUsers() });
    await writeRun(dir, { run: INC1, snapshotBefore: 2000, users: incUsers() });
    await writeRun(dir, { run: INC2, snapshotBefore: 3000, users: [{ userId: 'u1-full-and-inc', username: 'alice', streams: [{ id: 's2', name: 'Two renamed', modified: 2100 }] }] });

    const manifestPath = path.join(dir, 'incrementals', INC1_ID, 'manifest.json');
    fs.renameSync(manifestPath, manifestPath + '.moved');
    await assert.rejects(() => createFilesystemBackupReader(dir).readManifest(),
      new RegExp(`Run ${INC1_ID} of the backup chain at .* is missing its manifest; later runs assume it: restore --through-run full or recover ${INC1_ID}`));

    // The state as of the full run.
    const first = createFilesystemBackupReader(dir, { throughRun: 'full' });
    assert.deepStrictEqual((await first.readManifest()).users.map((u) => u.userId), ['u1-full-and-inc', 'u2-full-only']);
    const s = byId(await collect((await first.openUser('u1-full-and-inc')).readStreams()));
    assert.strictEqual(s.s1.name, 'One');
    assert.strictEqual(s.s3.name, 'Three');
    await assert.rejects(() => createFilesystemBackupReader(dir, { throughRun: 'nope' }).readManifest(), /--through-run nope: no such run/);
    fs.renameSync(manifestPath + '.moved', manifestPath);

    // Through run 1 / the whole chain.
    const second = createFilesystemBackupReader(dir, { throughRun: INC1_ID });
    await second.readManifest();
    assert.strictEqual(byId(await collect((await second.openUser('u1-full-and-inc')).readStreams())).s2.name, 'Two');
    const warnings = [];
    fs.mkdirSync(path.join(dir, 'incrementals', 'zzz'));
    const whole = createFilesystemBackupReader(dir, { onWarning: (m) => warnings.push(m) });
    await whole.readManifest();
    assert.strictEqual(byId(await collect((await whole.openUser('u1-full-and-inc')).readStreams())).s2.name, 'Two renamed');
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /incrementals\/zzz/);
    assert.match(chainApi().inspectBackup(dir).lines.join('\n'), /stray .*incrementals\/zzz/);

    // A run whose manifest names another chain.
    const inc2Manifest = path.join(dir, 'incrementals', INC2_ID, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(inc2Manifest, 'utf8'));
    fs.writeFileSync(inc2Manifest, JSON.stringify({ ...m, chainId: 'f'.repeat(32) }));
    await assert.rejects(() => createFilesystemBackupReader(dir).readManifest(), new RegExp(`Run ${INC2_ID} of the backup chain at .* does not belong to this chain`));
    fs.writeFileSync(inc2Manifest, JSON.stringify(m));

    // Two incremental runs swapped in chain.json, their parents rewritten to
    // keep it consistent: the older delta would be applied over the newer one.
    const chainPath = path.join(dir, 'chain.json');
    const chain = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
    const [full, run1, run2] = chain.runs;
    fs.writeFileSync(chainPath, JSON.stringify({ ...chain, runs: [full, { ...run2, parentRunId: 'full' }, { ...run1, parentRunId: INC2_ID }] }));
    await assert.rejects(() => createFilesystemBackupReader(dir).readManifest(), /does not belong to this chain/);
  });

  it('[BKCC1] two incremental runs started from the same chain: the second to finish is refused and left as a stray, the chain keeps the first', async function () {
    const dir = path.join(tmp, 'backup');
    await writeRun(dir, { run: FULL, users: fullUsers() });
    const siblingId = '20261013T142502Z-0b0b0b0b';
    const sibling = { runId: siblingId, path: 'incrementals/' + siblingId, parentRunId: 'full', chainId: CHAIN_ID };
    // Both planned before either joined the chain, as two overlapping cron runs would be.
    const first = createFilesystemBackupWriter(dir, { compress: false, run: INC1 });
    const second = createFilesystemBackupWriter(dir, { compress: false, run: sibling });
    const manifest = (snapshotBefore) => ({ coreVersion: 'test', config: {}, backupType: 'incremental', snapshotBefore, backupTimestamp: snapshotBefore * 1000, userManifests: [] });
    await first.writeManifest(manifest(2000));
    await assert.rejects(() => second.writeManifest(manifest(2001)), (err) => {
      assert.strictEqual(err.name, 'BackupChainError');
      assert.match(err.message, new RegExp(`another run joined the backup chain .* run ${siblingId} is left as a stray`));
      return true;
    });
    const chain = JSON.parse(fs.readFileSync(path.join(dir, 'chain.json'), 'utf8'));
    assert.deepStrictEqual(chain.runs.map((r) => r.runId), ['full', INC1_ID]);
    assert.match(chainApi().inspectBackup(dir).lines.join('\n'), new RegExp(`stray .*incrementals/${siblingId}`));
  });

  it('[BKC9] every run directory of a chain is a real directory of the backup, and a run id is one safe segment', async function () {
    const dir = path.join(tmp, 'backup');
    await writeRun(dir, { run: FULL, users: fullUsers() });
    await writeRun(dir, { run: INC1, snapshotBefore: 2000, users: incUsers() });
    const runDir = path.join(dir, 'incrementals', INC1_ID);

    // incrementals/<runId> is a link to a directory outside the backup.
    const outside = path.join(tmp, 'outside-run');
    fs.renameSync(runDir, outside);
    fs.symlinkSync(outside, runDir);
    await assert.rejects(() => createFilesystemBackupReader(dir).readManifest(), /not a directory of the backup/);
    fs.unlinkSync(runDir);
    fs.renameSync(outside, runDir);

    // incrementals/ is a link.
    const incDir = path.join(dir, 'incrementals');
    const outsideInc = path.join(tmp, 'outside-incrementals');
    fs.renameSync(incDir, outsideInc);
    fs.symlinkSync(outsideInc, incDir);
    await assert.rejects(() => createFilesystemBackupReader(dir).readManifest(), /not a directory of the backup/);
    assert.throws(() => createFilesystemBackupWriter(dir, { run: INC2 }), /not a directory/, 'the writer does not write through a link');
    fs.unlinkSync(incDir);
    fs.renameSync(outsideInc, incDir);

    // The user directory of an incremental run is a link.
    const userDir = path.join(runDir, 'users', 'u1-full-and-inc');
    const outsideUser = path.join(tmp, 'outside-user');
    fs.renameSync(userDir, outsideUser);
    fs.symlinkSync(outsideUser, userDir);
    const reader = createFilesystemBackupReader(dir);
    await reader.readManifest();
    await assert.rejects(() => reader.openUser('u1-full-and-inc'), /not a directory of the backup/);
    fs.unlinkSync(userDir);
    fs.renameSync(outsideUser, userDir);

    // A chain.json naming a run outside incrementals/, or a run id that is not one segment.
    const chainPath = path.join(dir, 'chain.json');
    const chain = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
    for (const run of [{ runId: '..', path: 'incrementals/..' }, { runId: INC1_ID, path: '../elsewhere' }, { runId: 'a/b', path: 'incrementals/a/b' }]) {
      fs.writeFileSync(chainPath, JSON.stringify({ ...chain, runs: [chain.runs[0], { ...chain.runs[1], ...run }] }));
      await assert.rejects(() => createFilesystemBackupReader(dir).readManifest(), /chain.json of the backup .* is not valid/, JSON.stringify(run));
    }
  });

  it('[BKCS1] every encrypted run carries the current decrypt script and a README naming the run; the root copies stay as the full run wrote them', async function () {
    const { STANDALONE_DECRYPT_SCRIPT } = require('storages/interfaces/backup/restoreReadme.ts');
    const dir = path.join(tmp, 'backup');
    await writeRun(dir, { run: FULL, encryptor: createBackupEncryptor({ passphrase: 'pw' }), users: fullUsers() });
    const rootScript = fs.readFileSync(path.join(dir, 'decrypt-backup.mjs'));
    const rootReadme = fs.readFileSync(path.join(dir, 'RESTORE-README.md'));
    await writeRun(dir, { run: INC1, encryptor: createBackupEncryptor({ passphrase: 'pw' }), snapshotBefore: 2000, users: incUsers() });

    const runDir = path.join(dir, 'incrementals', INC1_ID);
    assert.strictEqual(fs.readFileSync(path.join(runDir, 'decrypt-backup.mjs'), 'utf8'), STANDALONE_DECRYPT_SCRIPT);
    const readme = fs.readFileSync(path.join(runDir, 'RESTORE-README.md'), 'utf8');
    assert.ok(readme.includes('run `' + INC1_ID + '`'), 'the README names the run');
    assert.ok(readme.includes('`../..`'), 'the README says where the chain root is');
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'decrypt-backup.mjs')), rootScript, 'the root script is the full run\'s');
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'RESTORE-README.md')), rootReadme, 'the root README is the full run\'s');
    assert.ok(!rootReadme.toString('utf8').includes('This directory is run'), 'the full run\'s README is the chain root\'s');
    if (process.platform !== 'win32') {
      for (const name of ['decrypt-backup.mjs', 'RESTORE-README.md']) {
        assert.strictEqual(fs.statSync(path.join(runDir, name)).mode & 0o777, 0o600, name + ' is private');
      }
    }

    // A plaintext chain writes no script anywhere.
    const plain = path.join(tmp, 'plain');
    await writeRun(plain, { run: FULL, users: fullUsers() });
    await writeRun(plain, { run: INC1, snapshotBefore: 2000, users: incUsers() });
    for (const d of [plain, path.join(plain, 'incrementals', INC1_ID)]) {
      assert.ok(!fs.existsSync(path.join(d, 'decrypt-backup.mjs')) && !fs.existsSync(path.join(d, 'RESTORE-README.md')), d);
    }
  });

  describe('[BKCU] accounts deleted along the chain', function () {
    const U1 = 'u1-scope';
    const U2 = 'u2-scope';
    const U3 = 'u3-scope';
    const u = (userId, username) => ({ userId, username, streams: [{ id: 'st-' + username, name: username, modified: 10 }] });

    // full (whole core): u1, u2; inc1 (one account): u3; inc2 (whole core): u1, u3. u2 was deleted before inc2.
    async function writeScopedChain (dir) {
      await writeRun(dir, { run: FULL, scope: 'all', users: [u(U1, 'alice'), u(U2, 'bob')] });
      await writeRun(dir, { run: INC1, scope: 'users', snapshotBefore: 2000, users: [u(U3, 'carol')] });
      await writeRun(dir, { run: INC2, scope: 'all', snapshotBefore: 3000, users: [u(U1, 'alice'), u(U3, 'carol')] });
    }

    it('[BKCU1] a whole-core run drops from the restore an account it does not list; a one-account run or a run without scope drops nobody', async function () {
      const dir = path.join(tmp, 'backup');
      await writeScopedChain(dir);

      const reader = createFilesystemBackupReader(dir);
      const manifest = await reader.readManifest();
      assert.deepStrictEqual(manifest.users.map((x) => x.userId), [U1, U3]);
      assert.deepStrictEqual(manifest.deletedUsers, [{ userId: U2, username: 'bob', lastRunId: 'full', deletedBeforeRunId: INC2_ID }]);
      const chain = JSON.parse(fs.readFileSync(path.join(dir, 'chain.json'), 'utf8'));
      assert.deepStrictEqual(chain.runs.map((r) => r.scope), ['all', 'users', 'all'], 'chain.json records the scope of each run');
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'incrementals', INC1_ID, 'manifest.json'), 'utf8')).scope, 'users', 'and so does the run\'s manifest');
      await assert.rejects(() => reader.openUser(U2),
        new RegExp(`User ${U2} was deleted before run ${INC2_ID} of the chain \\(last exported by run full\\): not restored; --through-run full restores the account as of that run`));
      assert.deepStrictEqual((await collect((await reader.openUser(U3)).readStreams())).map((x) => x.id), ['st-carol']);

      // The state as of inc1: u2 still there.
      const prefix = createFilesystemBackupReader(dir, { throughRun: INC1_ID });
      const pm = await prefix.readManifest();
      assert.deepStrictEqual(pm.users.map((x) => x.userId), [U1, U2, U3]);
      assert.deepStrictEqual(pm.deletedUsers, []);
      assert.deepStrictEqual((await collect((await prefix.openUser(U2)).readStreams())).map((x) => x.id), ['st-bob']);

      // A run without scope is evidence of nothing.
      delete chain.runs[2].scope;
      fs.writeFileSync(path.join(dir, 'chain.json'), JSON.stringify(chain));
      const noScope = await createFilesystemBackupReader(dir).readManifest();
      assert.deepStrictEqual(noScope.users.map((x) => x.userId), [U1, U2, U3]);
      assert.deepStrictEqual(noScope.deletedUsers, []);

      // An unknown scope value is refused.
      chain.runs[2].scope = 'some';
      fs.writeFileSync(path.join(dir, 'chain.json'), JSON.stringify(chain));
      await assert.rejects(() => createFilesystemBackupReader(dir).readManifest(), /chain.json of the backup .* is not valid \(run .*: scope\)/);

      // deletedUsersOf: only a whole-core run newer than the last listing deletes.
      const { deletedUsersOf } = chainApi();
      const run = (runId, users, scope) => ({ runId, users, ...(scope ? { scope } : {}) });
      // The root run of a chain started from an older full backup has no scope.
      assert.deepStrictEqual(deletedUsersOf([run('full', ['a', 'b']), run('i1', ['c'], 'users'), run('i2', ['a'])]), []);
      assert.deepStrictEqual(deletedUsersOf([run('full', ['a', 'b']), run('i1', ['c'], 'users'), run('i2', ['a']), run('i3', ['a'], 'all'), run('i4', ['a'], 'all')]), [
        { userId: 'b', lastRunId: 'full', deletedBeforeRunId: 'i3' },
        { userId: 'c', lastRunId: 'i1', deletedBeforeRunId: 'i3' }
      ]);
      assert.deepStrictEqual(deletedUsersOf([run('full', ['a'], 'all'), run('i1', [], 'all'), run('i2', ['a'], 'users')]), [], 'listed again after the whole-core run that omitted it');
    });

    it('[BKCU2] --inspect shows the scope of each run and the accounts deleted along the chain', async function () {
      const dir = path.join(tmp, 'backup');
      await writeScopedChain(dir);
      const report = chainApi().inspectBackup(dir);
      const text = report.lines.join('\n');
      assert.strictEqual(report.status, 'ok', report.verdict);
      assert.strictEqual(text.match(/ scope all\b/g)?.length, 2, text);
      assert.strictEqual(text.match(/ scope users\b/g)?.length, 1, text);
      assert.ok(text.includes(`deleted before run ${INC2_ID}: ${U2} (last in run full)`), text);

      const chain = JSON.parse(fs.readFileSync(path.join(dir, 'chain.json'), 'utf8'));
      delete chain.runs[0].scope;
      fs.writeFileSync(path.join(dir, 'chain.json'), JSON.stringify(chain));
      assert.match(chainApi().inspectBackup(dir).lines.join('\n'), / scope unknown\b/);
    });
  });

  describe('[BKCE] series emptied after a run', function () {
    const SERIES = [{ measurement: 'm', points: [{ time: 1000, value: 1 }] }];

    // An orchestrator over stub stores: one user, no item but its series.
    function stubOrchestrator (exportDatabase) {
      const orch = Object.create(BackupOrchestrator.prototype);
      const store = { exportAll: (user, cb) => cb(null, []) };
      orch.storageLayer = { streams: store, accesses: store, profile: store, webhooks: store, events: store, engine: 'test' };
      orch.userAccountStorage = { _exportAll: async () => ({}) };
      orch.eventFiles = { getAttachmentStream: async () => { throw new Error('no attachment'); } };
      orch.auditStorage = null;
      orch.seriesConnection = exportDatabase == null ? null : { exportDatabase };
      const warnings = [];
      orch.logger = { info () {}, debug () {}, error () {}, warn: (m) => warnings.push(m) };
      return { orch, warnings };
    }

    // A user writer recording the series it is given.
    function recordingWriter () {
      const series = [];
      const noop = async () => {};
      const drain = async (items) => { for await (const item of items) assert.ok(item != null); };
      const userWriter = {
        writeStreams: noop,
        writeAccesses: noop,
        writeProfile: noop,
        writeWebhooks: drain,
        writeEvents: drain,
        writeAttachment: noop,
        writeAccountData: noop,
        writeAudit: noop,
        writeSeries: async (items) => { series.push(items); },
        close: async () => ({ userId: 'u1-series', username: 'alice' })
      };
      return { series, writer: { openUser: async () => userWriter } };
    }

    it('[BKCE1] the series file is written whenever the export returns, empty included; a failed export writes nothing', async function () {
      const empty = stubOrchestrator(async () => ({ measurements: [] }));
      const rec = recordingWriter();
      await empty.orch._backupSingleUser(rec.writer, 'u1-series', 'alice', 1000, null, {});
      assert.deepStrictEqual(rec.series, [[]], 'an empty series is written');

      const failing = stubOrchestrator(async () => { throw new Error('series engine down'); });
      const rec2 = recordingWriter();
      await failing.orch._backupSingleUser(rec2.writer, 'u1-series', 'alice', 1000, null, {});
      assert.deepStrictEqual(rec2.series, [], 'a failed export is not an empty one');
      assert.strictEqual(failing.warnings.length, 1);
      assert.match(failing.warnings[0], /Series export failed for user u1-series: series engine down/);

      const none = stubOrchestrator(null);
      const rec3 = recordingWriter();
      await none.orch._backupSingleUser(rec3.writer, 'u1-series', 'alice', 1000, null, {});
      assert.deepStrictEqual(rec3.series, [], 'no series engine, no series file');

      const some = stubOrchestrator(async () => ({ measurements: SERIES }));
      const rec4 = recordingWriter();
      await some.orch._backupSingleUser(rec4.writer, 'u1-series', 'alice', 1000, null, {});
      assert.deepStrictEqual(rec4.series, [SERIES]);
    });

    it('[BKCE2] series emptied after the full run do not come back on restore; a later failed export keeps the newest empty file', async function () {
      const dir = path.join(tmp, 'backup');
      async function runWith (run, exportDatabase, snapshotBefore) {
        const { orch } = stubOrchestrator(exportDatabase);
        const writer = createFilesystemBackupWriter(dir, { compress: false, run });
        const userManifest = await orch._backupSingleUser(writer, 'u1-series', 'alice', snapshotBefore, null, {});
        await writer.writeManifest({ coreVersion: 'test', config: {}, backupType: 'unused', snapshotBefore, backupTimestamp: snapshotBefore * 1000, userManifests: [userManifest], scope: 'all' });
      }
      const seriesOf = async () => {
        const reader = createFilesystemBackupReader(dir);
        await reader.readManifest();
        return await collect((await reader.openUser('u1-series')).readSeries());
      };

      await runWith(FULL, async () => ({ measurements: SERIES }), 1000);
      assert.deepStrictEqual(await seriesOf(), SERIES, 'control: the full run holds the series');
      await runWith(INC1, async () => ({ measurements: [] }), 2000);
      assert.deepStrictEqual(await seriesOf(), [], 'emptied after the full run');
      await runWith(INC2, async () => { throw new Error('series engine down'); }, 3000);
      assert.deepStrictEqual(await seriesOf(), [], 'the newest run with a series file is the second one');
    });
  });
});
