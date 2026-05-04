/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ERC] Engine plugin runtime contract — Plan 57 Phase 5a pre-flight
 * characterization test.
 *
 * For every concrete engine plugin under storages/engines/, asserts that
 * the loaded module exports the methods that pluginLoader's REQUIRED_EXPORTS
 * map demands for each storageType claimed in its manifest. The
 * pluginLoader validates this at discovery time, but the validation runs
 * inside async init() and a missing export would surface as a deferred
 * crash. This test exercises every engine in isolation so a regression in
 * any single engine's public API is caught at unit-tier.
 *
 * Why Phase 5a: today engines are loaded via dynamic `require()` from
 * pluginLoader.js. After Phase 5 (ESM + dynamic `import()`), the loaded
 * module shape can differ — ESM `export { foo }` is exposed differently
 * than CJS `module.exports = { foo }`. If a Phase 5 conversion silently
 * shifts an engine's exports under a `default` namespace (typical CJS-to-ESM
 * trap), every consumer of pluginLoader breaks at runtime, not at compile
 * time. This test pins the current contract so the regression is loud.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ENGINES_DIR = path.join(__dirname, '..', 'engines');

// Mirror of pluginLoader.js REQUIRED_EXPORTS — kept here intentionally so a
// drift between this test and pluginLoader is caught (rather than masked by
// shared truth). If pluginLoader's contract changes, this constant must
// change too.
const REQUIRED_EXPORTS = {
  baseStorage: ['initStorageLayer', 'getUserAccountStorage', 'getUsersLocalIndex'],
  platformStorage: ['createPlatformDB'],
  dataStore: ['getDataStoreModule'],
  seriesStorage: ['createSeriesConnection'],
  fileStorage: ['createFileStorage'],
  auditStorage: ['createAuditStorage']
};

function discoverEngineDirs () {
  if (!fs.existsSync(ENGINES_DIR)) return [];
  return fs.readdirSync(ENGINES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(ENGINES_DIR, e.name));
}

describe('[ERC] engine plugin runtime contract (CJS)', () => {
  const engineDirs = discoverEngineDirs();

  it('[ERC-DISCOVER] at least one engine plugin is present under storages/engines/', () => {
    assert.ok(engineDirs.length > 0, 'no engine directories found');
  });

  for (const engineDir of engineDirs) {
    const engineName = path.basename(engineDir);
    const manifestPath = path.join(engineDir, 'manifest.json');

    describe(`engine: ${engineName}`, () => {
      let manifest;
      let loaded;

      before(() => {
        assert.ok(fs.existsSync(manifestPath),
          `${engineName}: manifest.json missing`);
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const entrypoint = path.join(engineDir, manifest.entrypoint);
        assert.ok(fs.existsSync(entrypoint),
          `${engineName}: entrypoint ${manifest.entrypoint} missing`);
        // require() the loaded entrypoint as the pluginLoader would.
        loaded = require(entrypoint);
      });

      it('[ERC-EXPORTS] exports an object (not a primitive)', () => {
        assert.ok(loaded != null, 'loaded module is null/undefined');
        assert.strictEqual(typeof loaded, 'object',
          `expected typeof loaded === 'object', got '${typeof loaded}'`);
      });

      it('[ERC-INIT] exports an init() function (called by pluginLoader at startup)', () => {
        assert.strictEqual(typeof loaded.init, 'function',
          `expected loaded.init to be a function, got '${typeof loaded.init}'`);
      });

      // For each storageType claimed in the manifest, all REQUIRED_EXPORTS
      // for that type must be present and callable.
      const storageTypes = (() => {
        try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).storageTypes || []; } catch (e) { return []; }
      })();
      for (const storageType of storageTypes) {
        const required = REQUIRED_EXPORTS[storageType] || [];
        for (const methodName of required) {
          it(`[ERC-${storageType.toUpperCase()}-${methodName}] exports a callable ${methodName} for storageType '${storageType}'`, () => {
            assert.strictEqual(typeof loaded[methodName], 'function',
              `${engineName}: missing required export '${methodName}' for storageType '${storageType}' (got '${typeof loaded[methodName]}')`);
          });
        }
      }
    });
  }
});
