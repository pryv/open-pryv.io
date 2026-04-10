/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const { validateManifest } = require('../manifest-schema');
const internals = require('../internals');

// These tests are pure unit tests — no DB connections needed.
describe('[PLUG] Plugin Loader infrastructure', () => {
  describe('manifest-schema', () => {
    it('validates a correct manifest', () => {
      const manifest = {
        storageTypes: ['baseStorage'],
        entrypoint: 'src/index.js'
      };
      const result = validateManifest(manifest, '/test');
      assert.deepStrictEqual(result.storageTypes, ['baseStorage']);
    });

    it('rejects empty storageTypes', () => {
      assert.throws(() => {
        validateManifest({ storageTypes: [], entrypoint: 'src/index.js' }, '/test');
      }, /storageTypes/);
    });

    it('rejects invalid storageType', () => {
      assert.throws(() => {
        validateManifest({ storageTypes: ['invalid'], entrypoint: 'src/index.js' }, '/test');
      }, /unknown storageType/);
    });

    it('rejects missing entrypoint', () => {
      assert.throws(() => {
        validateManifest({ storageTypes: ['baseStorage'] }, '/test');
      }, /entrypoint/);
    });

    it('accepts optional fields', () => {
      const manifest = {
        storageTypes: ['baseStorage', 'platformStorage'],
        entrypoint: 'src/index.js',
        requiredInternals: ['userLocalDirectory'],
        scripts: { setup: 'scripts/setup' }
      };
      const result = validateManifest(manifest, '/test');
      assert.deepStrictEqual(result.requiredInternals, ['userLocalDirectory']);
    });
  });

  describe('internals', () => {
    beforeEach(() => {
      internals.clearAll();
    });

    it('registers and resolves internals', () => {
      const mockDir = { resolve: () => '/tmp' };
      internals.register('userLocalDirectory', mockDir);
      const resolved = internals.resolve(['userLocalDirectory'], 'test');
      assert.strictEqual(resolved.userLocalDirectory, mockDir);
    });

    it('throws for missing required internal', () => {
      assert.throws(() => {
        internals.resolve(['nonExistent'], 'test-engine');
      }, /nonExistent.*not registered/);
    });

    it('returns empty object for null/undefined requiredInternals', () => {
      const resolved = internals.resolve(null, 'test');
      assert.deepStrictEqual(resolved, {});
    });

    it('lists registered internals', () => {
      internals.register('a', 1);
      internals.register('b', 2);
      assert.deepStrictEqual(internals.listRegistered().sort(), ['a', 'b']);
    });
  });

  describe('pluginLoader', () => {
    // We test the loader with a fixture engine at test/fixtures/test-engine/
    const pluginLoader = require('../pluginLoader');

    afterEach(() => {
      pluginLoader.reset();
      internals.clearAll();
    });

    it('discovers engine from engines/ directory', () => {
      // This tests the real engines/ dir which may be empty at this phase.
      // The discover() call should not throw even with no engines.
      pluginLoader.discover();
      // listEngines may return [] if no engine dirs exist yet
      assert.ok(Array.isArray(pluginLoader.listEngines()));
    });

    it('reset clears all state', () => {
      pluginLoader.discover();
      pluginLoader.reset();
      assert.deepStrictEqual(pluginLoader.listEngines(), []);
    });
  });
});
