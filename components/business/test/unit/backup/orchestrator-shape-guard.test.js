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
