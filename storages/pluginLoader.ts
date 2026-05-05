/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Storage plugin loader.
 *
 * Discovers and loads storage engine plugins from storages/engines/.
 * Each engine has a manifest.json declaring supported storageTypes and a
 * JS entrypoint exporting factory functions (createBaseStorage, createDataStore, etc.).
 *
 * Usage:
 *   const pluginLoader = require('storages/pluginLoader');
 *   await pluginLoader.init(config);
 *   const engine = pluginLoader.getEngineModule(pluginLoader.getEngineFor('platformStorage'));
 *   const platformDB = engine.createPlatformDB();
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const path = require('path');
const fs = require('fs');
const { validateManifest, VALID_STORAGE_TYPES } = require('./manifest-schema');

const ENGINES_DIR = path.join(__dirname, 'engines');

// storageType → required exported methods
const REQUIRED_EXPORTS = {
  baseStorage: ['initStorageLayer', 'getUserAccountStorage', 'getUsersLocalIndex'],
  platformStorage: ['createPlatformDB'],
  dataStore: ['getDataStoreModule'],
  seriesStorage: ['createSeriesConnection'],
  fileStorage: ['createFileStorage'],
  auditStorage: ['createAuditStorage']
};

/**
 * Engine registry: engineName → { manifest, module, dir }
 */
const engines: Record<string, any> = {};

/**
 * Resolved config: storageType → { engine: string, config: object }
 */
let resolvedConfig = null;

let initialized = false;

/**
 * Discover and register all engine plugins from the engines/ directory.
 * Does NOT instantiate anything — just loads manifests and entrypoints.
 */
function discover () {
  if (!fs.existsSync(ENGINES_DIR)) return;

  const entries = fs.readdirSync(ENGINES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const engineDir = path.join(ENGINES_DIR, entry.name);
    const manifestPath = path.join(engineDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) continue;

    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const manifest = validateManifest(rawManifest, engineDir);

    // Engine name is the folder name (package metadata belongs in package.json)
    const engineName = entry.name;

    const entrypointPath = path.join(engineDir, manifest.entrypoint);
    if (!fs.existsSync(entrypointPath)) {
      throw new Error(`Engine "${engineName}": entrypoint not found at ${entrypointPath}`);
    }

    engines[engineName] = {
      manifest,
      dir: engineDir,
      module: null // lazy-loaded on first getEngineModule()
    };
  }
}

/**
 * Validate that all discovered engines export the required methods
 * for their declared storageTypes. Called after discover().
 */
function validateEngineExports () {
  for (const [engineName, engine] of Object.entries(engines)) {
    const mod = getEngineModule(engineName);
    for (const storageType of engine.manifest.storageTypes) {
      const required = REQUIRED_EXPORTS[storageType];
      if (!required) continue;
      for (const method of required) {
        if (typeof mod[method] !== 'function') {
          throw new Error(
            `Engine "${engineName}" declares storageType "${storageType}" ` +
            `but does not export required method "${method}"`
          );
        }
      }
    }
  }
}

/**
 * Get the module for an engine, loading it if needed.
 * @param {string} engineName
 * @returns {Object} The engine's exports
 */
function getEngineModule (engineName) {
  const engine = engines[engineName];
  if (!engine) {
    throw new Error(`Unknown storage engine "${engineName}". Discovered: ${Object.keys(engines).join(', ') || '(none)'}`);
  }
  if (!engine.module) {
    engine.module = require(path.join(engine.dir, engine.manifest.entrypoint));
  }
  return engine.module;
}

/**
 * Short config names for storage types.
 * Config uses: storages.base.engine, storages.platform.engine, etc.
 */
const SHORT_NAMES = {
  baseStorage: 'base',
  dataStore: 'base', // shares engine with baseStorage
  platformStorage: 'platform',
  seriesStorage: 'series',
  fileStorage: 'file',
  auditStorage: 'audit'
};

/**
 * Resolve which engine handles which storageType from config.
 *
 * Config format:
 *   storages:
 *     base:
 *       engine: mongodb
 *     platform:
 *       engine: rqlite
 *     series:
 *       engine: influxdb
 *     file:
 *       engine: filesystem
 *     audit:
 *       engine: sqlite
 *     engines:
 *       mongodb: { host: ..., port: ..., name: ... }
 *       postgresql: { ... }
 *       ...
 *
 * For testing with a different engine, override the config values
 * (e.g. via helpers-c.js injectTestConfig or a separate config file).
 *
 * @param {Object} config - @pryv/boiler config instance
 */
function resolveConfig (config) {
  resolvedConfig = {};

  for (const storageType of VALID_STORAGE_TYPES) {
    const shortName = SHORT_NAMES[storageType];
    let engineName;

    // Config: storages.<shortName>.engine
    if (shortName && config.has(`storages:${shortName}:engine`)) {
      engineName = config.get(`storages:${shortName}:engine`);
    }

    if (engineName) {
      resolvedConfig[storageType] = { engine: engineName };
    }
  }
}

/**
 * Initialize the plugin loader: discover engines, resolve config.
 * @param {Object} config - @pryv/boiler config instance
 */
async function init (config) {
  if (initialized) return;
  discover();
  validateEngineExports();
  resolveConfig(config);
  initialized = true;
}

/**
 * Get the resolved engine name for a storageType.
 * @param {string} storageType
 * @returns {string|null} Engine name or null if not configured
 */
function getEngineFor (storageType) {
  if (!resolvedConfig) {
    throw new Error('pluginLoader not initialized. Call init(config) first.');
  }
  const entry = resolvedConfig[storageType];
  return entry ? entry.engine : null;
}

/**
 * List all discovered engine names.
 * @returns {string[]}
 */
function listEngines () {
  return Object.keys(engines);
}

/**
 * Get manifest for a discovered engine.
 * @param {string} engineName
 * @returns {Object|null}
 */
function getManifest (engineName) {
  const engine = engines[engineName];
  return engine ? engine.manifest : null;
}

/**
 * Reset state (for testing).
 */
function reset () {
  for (const key of Object.keys(engines)) {
    delete engines[key];
  }
  resolvedConfig = null;
  initialized = false;
}

export { init,
  discover,
  getEngineFor,
  getEngineModule,
  listEngines,
  getManifest,
  reset,
  REQUIRED_EXPORTS,
  VALID_STORAGE_TYPES };