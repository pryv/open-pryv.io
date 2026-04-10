/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Versions conformance test suite.
 * Tests: getCurrent, removeAll, exportAll, importAll.
 *
 * @param {Function} getVersions - function returning an initialized Versions instance
 * @param {Function} cleanupFn - async function called after tests for cleanup
 */
module.exports = function conformanceTests (getVersions, cleanupFn) {
  const assert = require('node:assert');
  const { validateVersions } = require('../Versions');

  describe('Versions conformance', () => {
    let versions;

    before(async () => {
      versions = getVersions();
      // Clean state
      await versions.removeAll();
    });

    after(async () => {
      if (cleanupFn) await cleanupFn();
    });

    it('[VE01] must pass validateVersions', () => {
      validateVersions(versions);
    });

    it('[VE02] getCurrent() must return null when no versions exist', async () => {
      const current = await versions.getCurrent();
      assert.strictEqual(current, null);
    });

    it('[VE03] removeAll() must clear all version data', async () => {
      // migrateIfNeeded will insert the initial version record
      await versions.migrateIfNeeded();
      const current = await versions.getCurrent();
      assert.ok(current, 'must have a version after migrateIfNeeded');
      await versions.removeAll();
      const afterRemove = await versions.getCurrent();
      assert.strictEqual(afterRemove, null);
    });

    describe('migration methods', () => {
      it('[VE04] exportAll() must return all version records', async () => {
        await versions.migrateIfNeeded();
        const docs = await versions.exportAll();
        assert.ok(Array.isArray(docs));
        assert.ok(docs.length >= 1);
        await versions.removeAll();
      });

      it('[VE05] importAll() must insert raw version records', async () => {
        const items = [
          { _id: '99.0.0', migrationCompleted: Date.now() / 1000 }
        ];
        await versions.importAll(items);
        const current = await versions.getCurrent();
        assert.ok(current);
        assert.strictEqual(current._id, '99.0.0');
        await versions.removeAll();
      });

      it('[VE06] importAll() with empty array must be a no-op', async () => {
        await versions.importAll([]);
        const current = await versions.getCurrent();
        assert.strictEqual(current, null);
      });
    });
  });
};
