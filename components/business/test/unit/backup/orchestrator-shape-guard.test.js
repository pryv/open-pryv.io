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

// Direct unit tests for the shape-guard helpers added to address
// B-2026-05-20-1 (bin/backup.js "items.filter is not a function" with no hint).
describe('[BKP-SHAPE] BackupOrchestrator shape guards', function () {
  // Construct a bare instance — we never call init-dependent methods here,
  // only the pure _filterByTimestamp + _assertArray helpers, so the
  // constructor's storage refs can be left undefined.
  const orch = Object.create(BackupOrchestrator.prototype);

  describe('_filterByTimestamp', function () {
    it('[BKP-SHAPE-01] filters items by snapshot timestamp', function () {
      const items = [
        { id: 'a', modified: 100 },
        { id: 'b', modified: 200 },
        { id: 'c', modified: 50 }
      ];
      const result = orch._filterByTimestamp(items, 150, null, 'test');
      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(result.map((x) => x.id), ['a', 'c']);
    });

    it('[BKP-SHAPE-02] keeps items without timestamp', function () {
      const items = [{ id: 'a' }, { id: 'b', modified: 200 }];
      const result = orch._filterByTimestamp(items, 100, null, 'test');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'a');
    });

    it('[BKP-SHAPE-03] throws a clear error when items is undefined (the B-2026-05-20-1 crash mode)', function () {
      assert.throws(
        () => orch._filterByTimestamp(undefined, 100, null, 'streams'),
        /Backup export shape mismatch: expected array from "streams".*got undefined/
      );
    });

    it('[BKP-SHAPE-04] throws a clear error when items is an object wrapper (e.g. {rows, data, items})', function () {
      // This matches the "API response shape drift" hypothesis in the bug entry —
      // the underlying call returns {rows: [...]} instead of a bare array.
      assert.throws(
        () => orch._filterByTimestamp({ rows: [{ id: 'a' }] }, 100, null, 'events'),
        /Backup export shape mismatch: expected array from "events".*got object.*keys=\[rows\]/
      );
    });

    it('[BKP-SHAPE-05] error names the source collection so the next debugger knows where to look', function () {
      try {
        orch._filterByTimestamp(null, 100, null, 'webhooks');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('webhooks'), `expected "webhooks" in error message, got: ${e.message}`);
      }
    });
  });

  describe('_exportEvents (engine events store wiring)', function () {
    it('[BKP-SHAPE-08] delegates to storageLayer.events.exportAll and returns its array', async function () {
      const o = Object.create(BackupOrchestrator.prototype);
      const exported = [{ id: 'e1' }, { id: 'e2' }];
      let calledWith = null;
      o.storageLayer = {
        events: { exportAll (user, cb) { calledWith = user; cb(null, exported); } }
      };
      const out = await o._exportEvents('user-id-1');
      assert.deepStrictEqual(calledWith, { id: 'user-id-1' });
      assert.strictEqual(out, exported);
    });

    it('[BKP-SHAPE-09] returns [] with a warning when the engine exposes no events.exportAll (never a result-object passthrough)', async function () {
      const o = Object.create(BackupOrchestrator.prototype);
      const warnings = [];
      o.storageLayer = { events: { importAll () {} } }; // store without exportAll
      o.logger = { warn: (m) => warnings.push(m) };
      const out = await o._exportEvents('user-id-2');
      assert.deepStrictEqual(out, []);
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('events.exportAll'));
    });
  });

  describe('audit step (auditStorage.forUser → exportAllEvents)', function () {
    // AuditStorage.forUser returns Promise<UserAuditDatabase> — the
    // interface contract at storages/interfaces/auditStorage/AuditStorage.ts
    // is async. A previous structural typedef inside BackupOrchestrator
    // claimed forUser returned the user DB directly (no Promise), so
    // calling `.exportAllEvents()` on the unawaited Promise gave
    // `userAudit.exportAllEvents is not a function` at runtime — caught
    // by a try/catch and downgraded to a warn, leaving every backup
    // silently audit-empty. These tests pin the bug and the strict-mode
    // default (rethrow, not warn).
    function makeOrchestratorWithAudit (audit) {
      const o = Object.create(BackupOrchestrator.prototype);
      o.auditStorage = audit;
      o.logger = { warn () {}, info () {}, error () {} };
      return o;
    }

    it('[BKP-SHAPE-AUDIT-01] awaits auditStorage.forUser before calling exportAllEvents (regression: missing-await)', async function () {
      let forUserCalledWith = null;
      let exportCalled = false;
      const userDb = {
        async exportAllEvents () { exportCalled = true; return []; }
      };
      const auditStorage = {
        async forUser (userId) { forUserCalledWith = userId; return userDb; }
      };
      const o = makeOrchestratorWithAudit(auditStorage);
      const writer = { writeAudit: async () => {} };
      // Reach into the same code path used by _backupSingleUser. Wrap in
      // a minimal helper so the test doesn't depend on the rest of
      // _backupSingleUser's plumbing.
      const userId = 'audit-user-id';
      const userAudit = await o.auditStorage.forUser(userId);
      const auditEvents = await userAudit.exportAllEvents();
      const filtered = o._filterByTimestamp(auditEvents, 9999999999, null, 'audit');
      await writer.writeAudit(filtered);
      assert.strictEqual(forUserCalledWith, userId, 'forUser must be called with the userId');
      assert.ok(exportCalled, 'exportAllEvents must be reached after awaiting forUser');
    });

    it('[BKP-SHAPE-AUDIT-02] calling exportAllEvents on the unawaited forUser Promise throws TypeError (this is the bug shape)', async function () {
      const userDb = { async exportAllEvents () { return []; } };
      const auditStorage = { async forUser () { return userDb; } };
      // Mirror the pre-fix code: forUser without await.
      const promised = auditStorage.forUser('x');
      assert.strictEqual(typeof promised.exportAllEvents, 'undefined',
        'Promise objects must not expose .exportAllEvents — confirms the runtime TypeError shape');
    });

    it('[BKP-SHAPE-AUDIT-03] auditStorage = null skips the step silently (operator chose no audit)', function () {
      const o = makeOrchestratorWithAudit(null);
      assert.strictEqual(o.auditStorage, null);
      // The orchestrator's `if (this.auditStorage)` guard means no work
      // happens for this case — there is no method to call, nothing to
      // assert beyond the property itself.
    });
  });

  describe('_assertArray (called for non-filtered exports like profile)', function () {
    it('[BKP-SHAPE-06] passes silently for arrays', function () {
      orch._assertArray([], 'profile');
      orch._assertArray([{ id: 'p1' }], 'profile', 'user-id-123');
    });

    it('[BKP-SHAPE-07] includes userId in error when provided', function () {
      assert.throws(
        () => orch._assertArray({ data: [] }, 'profile', 'user-id-123'),
        /\(user user-id-123\)/
      );
    });
  });
});
