/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Proxy for engine tests to access service-core test infrastructure.
 *
 * Engine tests should require this module instead of directly requiring
 * from components/. This keeps the coupling explicit and centralized,
 * making it easier to extract engines as standalone packages later.
 *
 * Usage in engine global.test.js:
 *   const helpers = require('../../../test/helpers');
 *   helpers.state.config = helpers.getEngineConfig('mongodb', require('../manifest.json'));
 *
 * Uses ESM named exports. The CJS shape `module.exports =
 * { ...require('test-helpers') }` + `module.exports.config = X`
 * doesn't work under ESM (consumer namespace is read-only). Cross-test
 * mutable state lives on the `state` object; everything else is a
 * fixed re-export.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

require('test-helpers/src/api-server-tests-config.ts');

const boiler = require('@pryv/boiler');
const tested = require('test-helpers');

// Mutable cross-test state. Engine global.test.js sets state.config in its
// before() hook; sibling tests in the same engine read state.config later.
const state = { config: null };

// Logger factory — same interface engines receive via init(config, getLogger, internals)
const getLogger = boiler.getLogger;

/**
 * Build the engine config as a plain key-value object.
 * Reads from storages:engines:<engineName> in the config,
 * applying defaults from the manifest fields when available.
 *
 * @param {string} engineName - engine folder name (e.g. 'mongodb', 'postgresql')
 * @param {Object} [manifest] - optional manifest for field defaults
 * @returns {Object} plain config object
 */
function getEngineConfig (engineName, manifest) {
  const fullConfig = boiler.getConfigUnsafe(true);
  const section = fullConfig.get(`storages:engines:${engineName}`) || {};
  const fields = manifest?.configuration?.fields || {};
  const result = {};
  for (const [key, schema] of Object.entries(fields)) {
    if (section[key] !== undefined) {
      result[key] = section[key];
    } else if (schema.default !== undefined) {
      result[key] = schema.default;
    }
  }
  // Include any config keys not in the manifest fields
  for (const [key, value] of Object.entries(section)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolve the internals for an engine, same way the barrel does.
 * Must be called AFTER dependencies.init() (i.e. inside before() or test body).
 *
 * @param {Object} manifest - the engine's manifest.json (require'd)
 * @returns {Object} map of internal name → value
 */
function getInternals (manifest) {
  const internals = require('storages/internals.ts');
  const required = manifest.requiredInternals || [];
  return internals.resolve(required, manifest.entrypoint || 'test');
}

// --- Modules needed by migration tests ---
// Exposed here so engine tests don't require directly from components/.

const accountStreams = require('business/src/system-streams/index.ts');
const getMall = require('mall').getMall;
const platform = require('platform').platform;
const integrityFinalCheck = require('test-helpers/src/integrity-final-check.ts');
const getUsersLocalIndex = require('storage').getUsersLocalIndex;
const userLocalDirectory = require('storage').userLocalDirectory;

// Re-exports from test-helpers (consumers historically reach through helpers.X
// because the previous CJS spread pattern made every test-helpers field a direct
// property of the helpers namespace).
const dependencies = tested.dependencies;
const databaseFixture = tested.databaseFixture;
const data = tested.data;
const dynData = tested.dynData;

export {
  state,
  getLogger,
  getEngineConfig,
  getInternals,
  accountStreams,
  getMall,
  platform,
  integrityFinalCheck,
  getUsersLocalIndex,
  userLocalDirectory,
  dependencies,
  databaseFixture,
  data,
  dynData
};
