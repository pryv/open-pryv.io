/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { createFilesystemBackupWriter } = require('storages/interfaces/backup/FilesystemBackupWriter');
const { createFilesystemBackupReader } = require('storages/interfaces/backup/FilesystemBackupReader');

const TEST_DIR = path.join('/tmp', 'backup-test-' + process.pid);

describe('backup/FilesystemBackupWriter + Reader', function () {
  afterEach(function () {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('compressed mode (default)', function () {
    it('round-trips streams, accesses, profile, webhooks', async function () {
      const streams = [
        { streamId: 's1', name: 'Stream One', parentId: null },
        { streamId: 's2', name: 'Stream Two', parentId: 's1' }
      ];
      const accesses = [
        { id: 'a1', token: 'tok1', type: 'personal' }
      ];
      const profile = [{ key: 'language', value: 'en' }];
      const webhooks = [{ id: 'wh1', url: 'https://example.com/hook' }];

      // Write
      const writer = createFilesystemBackupWriter(TEST_DIR, { compress: true });
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeStreams(streams);
      await userWriter.writeAccesses(accesses);
      await userWriter.writeProfile(profile);
      await userWriter.writeWebhooks(webhooks);
      const userManifest = await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: { engine: 'mongodb' },
        userManifests: [userManifest],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      assert.strictEqual(userManifest.stats.streams, 2);
      assert.strictEqual(userManifest.stats.accesses, 1);
      assert.strictEqual(userManifest.stats.profile, 1);
      assert.strictEqual(userManifest.stats.webhooks, 1);

      // Files should have .gz extension
      assert.ok(fs.existsSync(path.join(TEST_DIR, 'users', 'user1', 'streams.jsonl.gz')));

      // Read back
      const reader = createFilesystemBackupReader(TEST_DIR);
      const manifest = await reader.readManifest();
      assert.strictEqual(manifest.backupType, 'full');
      assert.strictEqual(manifest.compressed, true);

      const userReader = await reader.openUser('user1');
      const readStreams = [];
      for await (const s of await userReader.readStreams()) readStreams.push(s);
      assert.deepStrictEqual(readStreams, streams);

      const readAccesses = [];
      for await (const a of await userReader.readAccesses()) readAccesses.push(a);
      assert.deepStrictEqual(readAccesses, accesses);

      const readProfile = [];
      for await (const p of await userReader.readProfile()) readProfile.push(p);
      assert.deepStrictEqual(readProfile, profile);

      const readWebhooks = [];
      for await (const w of await userReader.readWebhooks()) readWebhooks.push(w);
      assert.deepStrictEqual(readWebhooks, webhooks);

      await reader.close();
    });

    it('round-trips events with chunking', async function () {
      // Plan 28 Phase 1: `maxChunkSize` targets *compressed* output size per
      // the writeChunkedJsonlFiles docstring, so the content must be random /
      // non-compressible for chunking to trigger reliably. Earlier versions
      // used 'Hello world '.repeat(5) which gzipped to ~20 bytes total and
      // produced a single chunk regardless of item count.
      const randomContent = (i) => {
        // 128 bytes of pseudo-random-ish base64 per event — not compressible.
        let s = '';
        for (let k = 0; k < 32; k++) {
          s += ((i * 31 + k * 17 + 5) & 0xff).toString(16).padStart(2, '0');
          s += ((i * 13 + k * 23 + 97) & 0xff).toString(16).padStart(2, '0');
        }
        return s;
      };
      const events = [];
      for (let i = 0; i < 20; i++) {
        events.push({
          id: `evt${i}`,
          streamIds: ['s1'],
          type: 'note/txt',
          content: randomContent(i),
          time: 1000 + i,
          created: 1000 + i,
          modified: 1000 + i
        });
      }

      const writer = createFilesystemBackupWriter(TEST_DIR, {
        compress: true,
        maxChunkSize: 500 // force chunking at 500 bytes compressed
      });
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeEvents(events);
      const userManifest = await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [userManifest],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      assert.strictEqual(userManifest.stats.events, 20);
      assert.ok(userManifest.chunks.events.length > 1, 'should create multiple chunks');

      // Verify chunk files exist
      const eventsDir = path.join(TEST_DIR, 'users', 'user1', 'events');
      for (const chunkFile of userManifest.chunks.events) {
        assert.ok(fs.existsSync(path.join(eventsDir, chunkFile)), `chunk ${chunkFile} should exist`);
      }

      // Read back — chunks should be reassembled transparently
      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');
      const readEvents = [];
      for await (const e of await userReader.readEvents()) readEvents.push(e);

      assert.strictEqual(readEvents.length, 20);
      assert.deepStrictEqual(readEvents, events);
      await reader.close();
    });

    it('round-trips a single event larger than maxChunkSize (soft-limit semantics)', async function () {
      // Plan 28 Phase 1: `maxChunkSize` is a soft limit. A single item cannot
      // be split, so when an individual record exceeds the target the chunk
      // file must still be written and readable — Plan 28 regression.
      const bigEvent = {
        id: 'evt-big',
        streamIds: ['s1'],
        type: 'note/txt',
        content: 'x'.repeat(2048), // 2 KB content — larger than maxChunkSize
        time: 1000
      };

      const writer = createFilesystemBackupWriter(TEST_DIR, {
        compress: true,
        maxChunkSize: 500
      });
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeEvents([bigEvent]);
      const userManifest = await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [userManifest],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      assert.strictEqual(userManifest.stats.events, 1);
      assert.strictEqual(userManifest.chunks.events.length, 1,
        'a single oversized item must produce exactly one chunk');

      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');
      const readEvents = [];
      for await (const e of await userReader.readEvents()) readEvents.push(e);
      assert.strictEqual(readEvents.length, 1);
      assert.deepStrictEqual(readEvents[0], bigEvent);
      await reader.close();
    });

    it('round-trips account data', async function () {
      const accountData = {
        passwords: [{ hash: 'hash1', time: 1000, createdBy: 'system' }],
        storeKeyValues: [{ storeId: 'local', key: 'k1', value: 'v1' }],
        accountFields: [{ field: 'email', value: 'test@example.com', time: 1000, createdBy: 'system' }]
      };

      const writer = createFilesystemBackupWriter(TEST_DIR);
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeAccountData(accountData);
      await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');
      const readAccount = await userReader.readAccountData();

      assert.deepStrictEqual(readAccount, accountData);
      await reader.close();
    });

    it('round-trips file attachments', async function () {
      const fileContent = 'This is a test attachment with binary-like data: \x00\x01\x02\xFF';
      const fileBuffer = Buffer.from(fileContent);

      // Write backup with an event that has an attachment
      const writer = createFilesystemBackupWriter(TEST_DIR);
      const userWriter = await writer.openUser('user1', 'testuser');

      // Write the event that references the attachment
      await userWriter.writeEvents([{
        id: 'evt-with-file',
        streamIds: ['s1'],
        type: 'file/attached',
        attachments: [{ id: 'file-abc', fileName: 'doc.pdf', type: 'application/pdf', size: fileBuffer.length }]
      }]);

      // Write the attachment file
      const readStream = Readable.from([fileBuffer]);
      await userWriter.writeAttachment('evt-with-file', 'file-abc', readStream);

      const userManifest = await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [userManifest],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      assert.strictEqual(userManifest.stats.attachments, 1);

      // Verify file exists on disk
      const attachPath = path.join(TEST_DIR, 'users', 'user1', 'attachments', 'file-abc');
      assert.ok(fs.existsSync(attachPath), 'attachment file should exist');
      const storedContent = fs.readFileSync(attachPath);
      assert.ok(storedContent.equals(fileBuffer), 'attachment content should match');

      // Read back via reader
      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');

      const attachments = [];
      for await (const att of await userReader.readAttachments()) {
        const chunks = [];
        for await (const chunk of att.stream) chunks.push(chunk);
        attachments.push({
          eventId: att.eventId,
          fileId: att.fileId,
          data: Buffer.concat(chunks)
        });
      }

      assert.strictEqual(attachments.length, 1);
      assert.strictEqual(attachments[0].fileId, 'file-abc');
      assert.strictEqual(attachments[0].eventId, 'evt-with-file');
      assert.ok(attachments[0].data.equals(fileBuffer), 'read-back attachment content should match');

      await reader.close();
    });

    it('round-trips multiple attachments for multiple events', async function () {
      const files = {
        'file-1': Buffer.from('content of file 1'),
        'file-2': Buffer.from('content of file 2'),
        'file-3': Buffer.from('content of file 3, which is longer than the others to test varying sizes')
      };

      const writer = createFilesystemBackupWriter(TEST_DIR);
      const userWriter = await writer.openUser('user1', 'testuser');

      await userWriter.writeEvents([
        {
          id: 'evt1',
          streamIds: ['s1'],
          type: 'file/attached',
          attachments: [
            { id: 'file-1', fileName: 'a.txt', type: 'text/plain', size: files['file-1'].length },
            { id: 'file-2', fileName: 'b.txt', type: 'text/plain', size: files['file-2'].length }
          ]
        },
        {
          id: 'evt2',
          streamIds: ['s1'],
          type: 'file/attached',
          attachments: [
            { id: 'file-3', fileName: 'c.txt', type: 'text/plain', size: files['file-3'].length }
          ]
        }
      ]);

      for (const [fileId, data] of Object.entries(files)) {
        const eventId = fileId === 'file-3' ? 'evt2' : 'evt1';
        await userWriter.writeAttachment(eventId, fileId, Readable.from([data]));
      }

      const userManifest = await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [userManifest],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      assert.strictEqual(userManifest.stats.attachments, 3);

      // Read back
      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');

      const readAttachments = new Map();
      for await (const att of await userReader.readAttachments()) {
        const chunks = [];
        for await (const chunk of att.stream) chunks.push(chunk);
        readAttachments.set(att.fileId, {
          eventId: att.eventId,
          data: Buffer.concat(chunks)
        });
      }

      assert.strictEqual(readAttachments.size, 3);
      for (const [fileId, expectedData] of Object.entries(files)) {
        const att = readAttachments.get(fileId);
        assert.ok(att, `attachment ${fileId} should be read back`);
        assert.ok(att.data.equals(expectedData), `content of ${fileId} should match`);
      }
      // Verify event mapping
      assert.strictEqual(readAttachments.get('file-1').eventId, 'evt1');
      assert.strictEqual(readAttachments.get('file-2').eventId, 'evt1');
      assert.strictEqual(readAttachments.get('file-3').eventId, 'evt2');

      await reader.close();
    });

    it('round-trips audit data with chunking', async function () {
      // Plan 28 Phase 1: non-compressible payloads so the chunking check,
      // which targets *compressed* size, actually fires. See the events-
      // chunking test above for rationale.
      const auditEvents = [];
      for (let i = 0; i < 10; i++) {
        let payload = '';
        for (let k = 0; k < 32; k++) {
          payload += ((i * 41 + k * 19 + 13) & 0xff).toString(16).padStart(2, '0');
          payload += ((i * 59 + k * 29 + 211) & 0xff).toString(16).padStart(2, '0');
        }
        auditEvents.push({
          id: `audit-${i}`,
          action: 'events.get',
          time: 2000 + i,
          payload
        });
      }

      const writer = createFilesystemBackupWriter(TEST_DIR, {
        compress: true,
        maxChunkSize: 200
      });
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeAudit(auditEvents);
      const userManifest = await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [userManifest],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      assert.strictEqual(userManifest.stats.audit, 10);
      assert.ok(userManifest.chunks.audit.length > 1, 'audit should be chunked');

      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');
      const readAudit = [];
      for await (const a of await userReader.readAudit()) readAudit.push(a);

      assert.strictEqual(readAudit.length, 10);
      assert.deepStrictEqual(readAudit, auditEvents);
      await reader.close();
    });

    it('round-trips platform data', async function () {
      const platformData = [
        { isUnique: true, field: 'email', username: 'user1', value: 'test@example.com' },
        { isUnique: false, field: 'language', username: 'user1', value: 'en' }
      ];

      const writer = createFilesystemBackupWriter(TEST_DIR);
      await writer.writePlatformData(platformData);
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const readPlatform = [];
      for await (const p of await reader.readPlatformData()) readPlatform.push(p);

      assert.deepStrictEqual(readPlatform, platformData);
      await reader.close();
    });
  });

  describe('uncompressed mode', function () {
    it('writes plain .jsonl files when compress=false', async function () {
      const writer = createFilesystemBackupWriter(TEST_DIR, { compress: false });
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeStreams([{ streamId: 's1', name: 'Test' }]);
      await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      // File should be plain .jsonl (no .gz)
      const plainPath = path.join(TEST_DIR, 'users', 'user1', 'streams.jsonl');
      assert.ok(fs.existsSync(plainPath), 'plain .jsonl should exist');
      const content = fs.readFileSync(plainPath, 'utf8');
      const parsed = JSON.parse(content.trim());
      assert.strictEqual(parsed.streamId, 's1');

      // Read back
      const reader = createFilesystemBackupReader(TEST_DIR);
      const manifest = await reader.readManifest();
      assert.strictEqual(manifest.compressed, false);
      const userReader = await reader.openUser('user1');
      const readStreams = [];
      for await (const s of await userReader.readStreams()) readStreams.push(s);
      assert.strictEqual(readStreams.length, 1);
      assert.strictEqual(readStreams[0].streamId, 's1');
      await reader.close();
    });
  });

  describe('manifest', function () {
    it('is written last and contains all metadata', async function () {
      const writer = createFilesystemBackupWriter(TEST_DIR);
      const userWriter = await writer.openUser('u1', 'alice');
      await userWriter.writeStreams([{ streamId: 's1', name: 'A' }]);
      const um = await userWriter.close();

      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: { engine: 'mongodb', domain: 'test.pryv.li' },
        userManifests: [um],
        backupType: 'full',
        backupTimestamp: 1700000000000
      });
      await writer.close();

      const manifest = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'manifest.json'), 'utf8'));
      assert.strictEqual(manifest.formatVersion, 1);
      assert.strictEqual(manifest.coreVersion, '2.0.0');
      assert.strictEqual(manifest.backupType, 'full');
      assert.strictEqual(manifest.backupTimestamp, 1700000000000);
      assert.strictEqual(manifest.config.engine, 'mongodb');
      assert.strictEqual(manifest.users.length, 1);
      assert.strictEqual(manifest.users[0].userId, 'u1');
      assert.strictEqual(manifest.users[0].username, 'alice');
    });

    it('records incremental backup metadata', async function () {
      const writer = createFilesystemBackupWriter(TEST_DIR);
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [],
        backupType: 'incremental',
        snapshotBefore: 1699000000,
        backupTimestamp: 1700000000000
      });
      await writer.close();

      const manifest = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'manifest.json'), 'utf8'));
      assert.strictEqual(manifest.backupType, 'incremental');
      assert.strictEqual(manifest.snapshotBefore, 1699000000);
    });
  });

  describe('edge cases', function () {
    it('handles empty collections gracefully', async function () {
      const writer = createFilesystemBackupWriter(TEST_DIR);
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeStreams([]);
      await userWriter.writeAccesses([]);
      await userWriter.writeEvents([]);
      await userWriter.writeAudit([]);
      const um = await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [um],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      assert.strictEqual(um.stats.streams, 0);
      assert.strictEqual(um.stats.events, 0);

      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');
      const streams = [];
      for await (const s of await userReader.readStreams()) streams.push(s);
      assert.strictEqual(streams.length, 0);
      await reader.close();
    });

    it('handles multiple users', async function () {
      const writer = createFilesystemBackupWriter(TEST_DIR);

      const uw1 = await writer.openUser('u1', 'alice');
      await uw1.writeStreams([{ streamId: 'a1', name: 'Alice Stream' }]);
      const um1 = await uw1.close();

      const uw2 = await writer.openUser('u2', 'bob');
      await uw2.writeStreams([{ streamId: 'b1', name: 'Bob Stream' }]);
      const um2 = await uw2.close();

      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [um1, um2],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      const reader = createFilesystemBackupReader(TEST_DIR);
      const manifest = await reader.readManifest();
      assert.strictEqual(manifest.users.length, 2);

      const ur1 = await reader.openUser('u1');
      const s1 = [];
      for await (const s of await ur1.readStreams()) s1.push(s);
      assert.strictEqual(s1[0].name, 'Alice Stream');

      const ur2 = await reader.openUser('u2');
      const s2 = [];
      for await (const s of await ur2.readStreams()) s2.push(s);
      assert.strictEqual(s2[0].name, 'Bob Stream');

      await reader.close();
    });

    it('handles events with special characters and unicode', async function () {
      const events = [
        { id: 'e1', content: 'Hello "world" with \nnewlines' },
        { id: 'e2', content: 'Unicode: \u00e9\u00e8\u00ea \u4e16\u754c \ud83c\udf0d' },
        { id: 'e3', content: '{"nested": "json", "with": [1,2,3]}' }
      ];

      const writer = createFilesystemBackupWriter(TEST_DIR);
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeEvents(events);
      await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');
      const readEvents = [];
      for await (const e of await userReader.readEvents()) readEvents.push(e);
      assert.deepStrictEqual(readEvents, events);
      await reader.close();
    });

    it('handles large binary attachments', async function () {
      // 1MB of random-ish data
      const largeBuffer = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < largeBuffer.length; i++) {
        largeBuffer[i] = i % 256;
      }

      const writer = createFilesystemBackupWriter(TEST_DIR);
      const userWriter = await writer.openUser('user1', 'testuser');
      await userWriter.writeEvents([{
        id: 'evt-large',
        streamIds: ['s1'],
        type: 'file/attached',
        attachments: [{ id: 'large-file', fileName: 'big.bin', size: largeBuffer.length }]
      }]);
      await userWriter.writeAttachment('evt-large', 'large-file', Readable.from([largeBuffer]));
      await userWriter.close();
      await writer.writeManifest({
        coreVersion: '2.0.0',
        config: {},
        userManifests: [],
        backupType: 'full',
        backupTimestamp: Date.now()
      });
      await writer.close();

      // Read back
      const reader = createFilesystemBackupReader(TEST_DIR);
      await reader.readManifest();
      const userReader = await reader.openUser('user1');
      for await (const att of await userReader.readAttachments()) {
        const chunks = [];
        for await (const chunk of att.stream) chunks.push(chunk);
        const readBuffer = Buffer.concat(chunks);
        assert.strictEqual(readBuffer.length, largeBuffer.length);
        assert.ok(readBuffer.equals(largeBuffer), 'large attachment content should match byte-for-byte');
      }
      await reader.close();
    });
  });
});
