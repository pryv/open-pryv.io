/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('assert');
const { BackupOrchestrator } = require('business/src/backup/BackupOrchestrator.ts');

// Unit tests for the streaming export pipeline: laziness (no full
// materialization), attachment-ref collection equivalence with the previous
// second-iteration approach, and the iterable shape guard.
describe('[BKP-STREAM] BackupOrchestrator streaming pipeline', function () {
  describe('_exportPipeline laziness', function () {
    it('[BKP-STREAM-01] events pipeline pulls one item at a time (no full copy)', async function () {
      const orch = Object.create(BackupOrchestrator.prototype);
      const N = 1000;
      let produced = 0;
      async function * source () {
        for (let i = 0; i < N; i++) { produced++; yield { id: 'e' + i, time: i, modified: i }; }
      }
      const refs = [];
      const pipeline = orch._exportPipeline(
        source(), Number.MAX_SAFE_INTEGER, null, 'events',
        (e) => orch._collectAttachmentRefs(e, refs)
      );
      let received = 0;
      let maxGap = 0;
      for await (const item of pipeline) {
        assert.ok(item && item.id, 'yields sanitized events');
        received++;
        maxGap = Math.max(maxGap, produced - received);
      }
      assert.strictEqual(received, N, 'all events flow through');
      // Pull-based: at most a small constant is produced ahead of consumed.
      assert.ok(maxGap <= 2, `pipeline must not materialize — max produced-received gap was ${maxGap}`);
    });

    it('[BKP-STREAM-02] audit pipeline (no attachment hook) is equally lazy', async function () {
      const orch = Object.create(BackupOrchestrator.prototype);
      const N = 500;
      let produced = 0;
      async function * source () {
        // raw audit rows: no camelCase timestamps → always included
        for (let i = 0; i < N; i++) { produced++; yield { eventid: 'a' + i, type: 'audit/log' }; }
      }
      const pipeline = orch._exportPipeline(source(), 1000, null, 'audit');
      let received = 0;
      let maxGap = 0;
      for await (const item of pipeline) { assert.ok(item.eventid); received++; maxGap = Math.max(maxGap, produced - received); }
      assert.strictEqual(received, N, 'raw audit rows are full-snapshot (no timestamp filter)');
      assert.ok(maxGap <= 2, `audit pipeline must not materialize — gap was ${maxGap}`);
    });
  });

  describe('attachment-ref collection equivalence', function () {
    it('[BKP-STREAM-03] collects refs for exactly the written, filtered, pre-sanitize events', async function () {
      const orch = Object.create(BackupOrchestrator.prototype);
      const events = [
        { id: 'e1', time: 10, modified: 10, attachments: [{ id: 'f1' }, { id: 'f2' }] },
        { id: 'e2', time: 20, modified: 20, attachments: [{ id: 'f3' }] },
        { id: 'e3', time: 30, modified: 30, attachments: [] }, // empty attachments
        { id: 'e4', time: 40, modified: 40, attachments: [{}] }, // attachment without id
        { id: 'e5', time: 50, modified: 50 }, // no attachments
        { id: 'e6', time: 999, modified: 999, attachments: [{ id: 'f6' }] } // filtered out by snapshot
      ];
      const refs = [];
      const written = [];
      const mockWriter = { async writeEvents (iterable) { for await (const e of iterable) written.push(e); } };
      const pipeline = orch._exportPipeline(
        events, 100, null, 'events',
        (e) => orch._collectAttachmentRefs(e, refs)
      );
      await mockWriter.writeEvents(pipeline);

      assert.strictEqual(written.length, 5, 'e6 excluded by snapshotBefore=100');
      assert.deepStrictEqual(refs, [
        { eventId: 'e1', fileIds: ['f1', 'f2'] },
        { eventId: 'e2', fileIds: ['f3'] }
      ], 'refs only for written events with real attachment ids');
    });

    it('[BKP-STREAM-04] _backupAttachments backs up each ref and warns-and-continues on a stream error', async function () {
      const orch = Object.create(BackupOrchestrator.prototype);
      const refs = [
        { eventId: 'e1', fileIds: ['f1', 'f2'] },
        { eventId: 'e2', fileIds: ['f3'] }
      ];
      const warns = [];
      orch.logger = { warn: (m) => warns.push(m) };
      orch.eventFiles = {
        async getAttachmentStream (userId, eventId, fileId) {
          if (fileId === 'f2') throw new Error('boom');
          return { userId, eventId, fileId };
        }
      };
      const writeAttCalls = [];
      const writer = { async writeAttachment (eventId, fileId) { writeAttCalls.push({ eventId, fileId }); } };
      await orch._backupAttachments(writer, 'user1', refs);

      assert.deepStrictEqual(writeAttCalls, [
        { eventId: 'e1', fileId: 'f1' },
        { eventId: 'e2', fileId: 'f3' }
      ], 'f2 failed to open its stream so it is skipped, the rest continue');
      assert.strictEqual(warns.length, 1);
      assert.ok(warns[0].includes('f2'), `warning should name the failed file, got: ${warns[0]}`);
    });
  });

  describe('_assertIterable shape guard', function () {
    it('[BKP-STREAM-05] accepts array, sync iterable and async iterable', function () {
      const orch = Object.create(BackupOrchestrator.prototype);
      orch._assertIterable([], 'events');
      orch._assertIterable((function * () { yield 1; })(), 'events');
      orch._assertIterable((async function * () { yield 1; })(), 'events');
    });

    it('[BKP-STREAM-06] rejects undefined / null / a {rows} result object with a source-named error', function () {
      const orch = Object.create(BackupOrchestrator.prototype);
      for (const bad of [undefined, null, { rows: [] }, { command: 'SELECT', rowCount: 3 }]) {
        assert.throws(
          () => orch._assertIterable(bad, 'events', 'user-x'),
          (e) => e.message.includes('events') && e.message.includes('shape mismatch'),
          `expected a source-named shape-mismatch error for ${JSON.stringify(bad)}`
        );
      }
    });
  });

  describe('_exportEvents feature detection', function () {
    it('[BKP-STREAM-07] uses exportAllStreamed when present (not exportAll), so a misspelled name cannot silently fall back', async function () {
      const orch = Object.create(BackupOrchestrator.prototype);
      let exportAllCalled = false;
      orch.storageLayer = {
        events: {
          exportAll (user, cb) { exportAllCalled = true; cb(null, [{ id: 'array-path' }]); },
          async * exportAllStreamed () { yield { id: 'streamed-1' }; yield { id: 'streamed-2' }; }
        }
      };
      const source = await orch._exportEvents('user-1');
      const collected = [];
      for await (const e of source) collected.push(e.id);
      assert.deepStrictEqual(collected, ['streamed-1', 'streamed-2']);
      assert.strictEqual(exportAllCalled, false, 'exportAll must not be used when exportAllStreamed exists');
    });

    it('[BKP-STREAM-08] falls back to exportAll (array) when no streamed producer is present', async function () {
      const orch = Object.create(BackupOrchestrator.prototype);
      const arr = [{ id: 'a' }, { id: 'b' }];
      orch.storageLayer = { events: { exportAll (user, cb) { cb(null, arr); } } };
      const source = await orch._exportEvents('user-2');
      assert.strictEqual(source, arr, 'array fallback returns the store array as-is');
    });
  });
});
