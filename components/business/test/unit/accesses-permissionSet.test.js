/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the permission-set lexicon single point.
 */

const assert = require('node:assert/strict');

const ps = require('../../src/accesses/permissionSet.ts');

describe('[PSET] accesses permissionSet', () => {
  describe('[PSET-L] lexicon values', () => {
    it('[PS01] exposes the ordered level map and value lists', () => {
      assert.deepEqual(ps.PermissionLevels, {
        none: -1, read: 0, 'create-only': 1, contribute: 1, manage: 2
      });
      assert.deepEqual([...ps.PERMISSION_LEVEL_VALUES].sort(),
        ['contribute', 'create-only', 'manage', 'none', 'read']);
      assert.deepEqual([...ps.FEATURE_SETTING_VALUES], ['forbidden']);
    });
  });

  describe('[PSET-G] guards', () => {
    it('[PS02] recognizes stream and feature permissions', () => {
      assert.equal(ps.isStreamPermission({ streamId: 'health', level: 'read' }), true);
      assert.equal(ps.isFeaturePermission({ feature: 'selfRevoke', setting: 'forbidden' }), true);
      assert.equal(ps.isStreamPermission({ feature: 'selfRevoke', setting: 'forbidden' }), false);
      assert.equal(ps.isFeaturePermission({ streamId: 'health', level: 'read' }), false);
      assert.equal(ps.isStreamPermission({ streamId: 'health', level: 'root' }), false);
      assert.equal(ps.isFeaturePermission({ feature: 'selfRevoke', setting: 'maybe' }), false);
      assert.equal(ps.isStreamPermission(null), false);
      assert.equal(ps.isFeaturePermission('selfRevoke'), false);
    });
  });

  describe('[PSET-N] normalizePermissions', () => {
    it('[PS03] passes the full lexicon through, preserving display names', () => {
      const input = [
        { streamId: 'health', level: 'contribute', defaultName: 'Health', junk: true },
        { feature: 'selfRevoke', setting: 'forbidden' },
        { streamId: 'diary', level: 'create-only', name: 'Diary' }
      ];
      const out = ps.normalizePermissions(input);
      assert.deepEqual(out, [
        { streamId: 'health', level: 'contribute', defaultName: 'Health' },
        { feature: 'selfRevoke', setting: 'forbidden' },
        { streamId: 'diary', level: 'create-only', name: 'Diary' }
      ]);
    });

    it('[PS04] rejects invalid entries with the offending index', () => {
      assert.throws(() => ps.normalizePermissions('nope'), /must be an array/);
      assert.throws(() => ps.normalizePermissions([{ streamId: 'a', level: 'root' }]), /index 0/);
      assert.throws(() => ps.normalizePermissions([
        { streamId: 'a', level: 'read' },
        { feature: 'selfRevoke' }
      ]), /index 1/);
    });
  });

  describe('[PSET-S] isPermissionSubset', () => {
    const offered = [
      { streamId: 'health', level: 'read' },
      { streamId: 'diary', level: 'contribute' },
      { feature: 'selfRevoke', setting: 'forbidden' }
    ];

    it('[PS05] accepts identical and reduced sets, ignoring display names', () => {
      assert.deepEqual(ps.isPermissionSubset(offered, offered), { ok: true });
      assert.deepEqual(ps.isPermissionSubset(
        [{ streamId: 'health', level: 'read', defaultName: 'Health' }], offered), { ok: true });
      assert.deepEqual(ps.isPermissionSubset([], offered), { ok: true });
      assert.deepEqual(ps.isPermissionSubset(
        [{ feature: 'selfRevoke', setting: 'forbidden' }], offered), { ok: true });
    });

    it('[PS06] rejects widened or altered entries and reports them', () => {
      const r1 = ps.isPermissionSubset([{ streamId: 'health', level: 'manage' }], offered);
      assert.equal(r1.ok, false);
      assert.deepEqual(r1.offending, [{ streamId: 'health', level: 'manage' }]);
      const r2 = ps.isPermissionSubset([{ streamId: 'other', level: 'read' }], offered);
      assert.equal(r2.ok, false);
      const r3 = ps.isPermissionSubset([{ feature: 'selfAudit', setting: 'forbidden' }], offered);
      assert.equal(r3.ok, false);
    });
  });
});
