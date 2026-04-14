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
 *   helpers.config = helpers.getEngineConfig('mongodb', require('../manifest.json'));
 */

// Initialize boiler config for test environment
require('test-helpers/src/api-server-tests-config');

const boiler = require('@pryv/boiler');

// Re-export test-helpers
const helpers = require('test-helpers');
module.exports = helpers;

// Logger factory — same interface engines receive via init(config, getLogger, internals)
module.exports.getLogger = boiler.getLogger;

// Engine config — set by each engine's global.test.js via getEngineConfig()
module.exports.config = null;

/**
 * Build the engine config as a plain key-value object.
 * Reads from storages:engines:<engineName> in the config,
 * applying defaults from the manifest fields when available.
 *
 * @param {string} engineName - engine folder name (e.g. 'mongodb', 'postgresql')
 * @param {Object} [manifest] - optional manifest for field defaults
 * @returns {Object} plain config object
 */
module.exports.getEngineConfig = function getEngineConfig (engineName, manifest) {
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
};

/**
 * Resolve the internals for an engine, same way the barrel does.
 * Must be called AFTER dependencies.init() (i.e. inside before() or test body).
 *
 * @param {Object} manifest - the engine's manifest.json (require'd)
 * @returns {Object} map of internal name → value
 */
module.exports.getInternals = function getInternals (manifest) {
  const internals = require('storages/internals');
  const required = manifest.requiredInternals || [];
  return internals.resolve(required, manifest.entrypoint || 'test');
};

// --- Modules needed by migration tests ---
// Exposed here so engine tests don't require directly from components/.

module.exports.accountStreams = require('business/src/system-streams');
module.exports.getMall = require('mall').getMall;
module.exports.platform = require('platform').platform;
module.exports.integrityFinalCheck = require('test-helpers/src/integrity-final-check');
module.exports.getUsersLocalIndex = require('storage').getUsersLocalIndex;
module.exports.userLocalDirectory = require('storage').userLocalDirectory;
