/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validateManifest, VALID_STORAGE_TYPES } = require('../manifest-schema.ts');
const { INTERFACE_VERSIONS } = require('../interfaces/versions.ts');
const pluginLoader = require('../pluginLoader.ts');

const ENGINES_DIR = path.join(__dirname, '..', 'engines');
const realEngines = fs.readdirSync(ENGINES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(ENGINES_DIR, e.name, 'manifest.json')))
  .map((e) => e.name);

function readManifest (engine) {
  return JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, engine, 'manifest.json'), 'utf-8'));
}

function hostWith (storageType, version) {
  return Object.assign({}, INTERFACE_VERSIONS, { [storageType]: version });
}

// Pure unit tests: no database.
describe('[IFV] Storage engine interface versions', () => {
  it('[IFVH] the host map covers exactly the valid storage types, with positive integers', () => {
    assert.deepStrictEqual(Object.keys(INTERFACE_VERSIONS).sort(), [...VALID_STORAGE_TYPES].sort());
    for (const v of Object.values(INTERFACE_VERSIONS)) {
      assert.ok(Number.isInteger(v) && v >= 1, `version ${v}`);
    }
  });

  it('[IFVA] every in-tree engine declares a version for each of its types and matches this server', () => {
    assert.ok(realEngines.length >= 6, `engines found: ${realEngines.join(', ')}`);
    for (const engine of realEngines) {
      const manifest = validateManifest(readManifest(engine), engine);
      for (const type of manifest.storageTypes) {
        assert.ok(manifest.interfaceVersions && manifest.interfaceVersions[type] != null,
          `${engine} declares no interfaceVersions.${type}`);
      }
      pluginLoader.checkInterfaceVersions(engine, manifest);
    }
  });

  it('[IFVB] an engine below this server\'s version is refused, for every storage type', () => {
    for (const type of VALID_STORAGE_TYPES) {
      const manifest = { storageTypes: [type], entrypoint: 'x', interfaceVersions: { [type]: 1 } };
      assert.throws(
        () => pluginLoader.checkInterfaceVersions('stale', manifest, hostWith(type, 2)),
        (err) => {
          assert.match(err.message, new RegExp(`^Engine "stale": storageType "${type}" implements interface version 1, this server requires version 2\\. Update the engine`));
          return true;
        }
      );
    }
  });

  it('[IFVC] an engine above this server\'s version is refused', () => {
    const manifest = { storageTypes: ['seriesStorage'], entrypoint: 'x', interfaceVersions: { seriesStorage: 2 } };
    assert.throws(
      () => pluginLoader.checkInterfaceVersions('future', manifest, hostWith('seriesStorage', 1)),
      /^Error: Engine "future": storageType "seriesStorage" implements interface version 2, this server provides version 1\. Use a server release that provides version 2/
    );
  });

  it('[IFVD] a manifest without a declared version counts as 1', () => {
    const noField = { storageTypes: ['fileStorage'], entrypoint: 'x' };
    const noKey = { storageTypes: ['fileStorage', 'seriesStorage'], entrypoint: 'x', interfaceVersions: { seriesStorage: 1 } };
    const host = hostWith('fileStorage', 1);
    pluginLoader.checkInterfaceVersions('old', validateManifest(noField, 'old'), host);
    pluginLoader.checkInterfaceVersions('old', validateManifest(noKey, 'old'), host);
  });

  it('[IFVE] a manifest without a declared version is refused once the host is past 1, saying so', () => {
    const noField = { storageTypes: ['fileStorage'], entrypoint: 'x' };
    const noKey = { storageTypes: ['fileStorage'], entrypoint: 'x', interfaceVersions: {} };
    for (const manifest of [noField, noKey]) {
      assert.throws(
        () => pluginLoader.checkInterfaceVersions('old', manifest, hostWith('fileStorage', 2)),
        /implements interface version 1 \(no "interfaceVersions\.fileStorage" in its manifest\), this server requires version 2/
      );
    }
  });

  it('[IFVF] the manifest schema refuses malformed interfaceVersions', () => {
    const base = { storageTypes: ['baseStorage'], entrypoint: 'x' };
    const bad = [
      [{ interfaceVersions: 1 }, /must be an object/],
      [{ interfaceVersions: [1] }, /must be an object/],
      [{ interfaceVersions: { fileStorage: 1 } }, /names "fileStorage", which is not in "storageTypes"/],
      [{ interfaceVersions: { baseStorage: 0 } }, /positive integer/],
      [{ interfaceVersions: { baseStorage: 1.5 } }, /positive integer/],
      [{ interfaceVersions: { baseStorage: '1' } }, /positive integer/],
      [{ interfaceVersions: { baseStorage: null } }, /positive integer/]
    ];
    for (const [extra, expected] of bad) {
      assert.throws(() => validateManifest(Object.assign({}, base, extra), '/test'), expected, JSON.stringify(extra));
    }
    validateManifest(Object.assign({}, base, { interfaceVersions: { baseStorage: 3 } }), '/test');
  });

  describe('init()', () => {
    afterEach(() => { pluginLoader.reset(); });

    it('[IFVG] init() with the in-tree engines passes the version check', async () => {
      const fakeConfig = {
        has: (key) => key === 'storages:file:engine',
        get: (key) => key === 'storages:file:engine' ? 'filesystem' : null
      };
      await pluginLoader.init(fakeConfig);
      assert.strictEqual(pluginLoader.getEngineFor('fileStorage'), 'filesystem');
    });
  });
});
