/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const DBrqlite = require('./DBrqlite');
const { buildMigrationsCapability } = require('./SchemaMigrations');

let platformDB = null;
let _getLogger = null;

/**
 * Initialize the rqlite engine.
 * @param {Object} config - { url: 'http://localhost:4001' }
 * @param {Function} [getLogger] - logger factory from the storages barrel
 */
function init (config, getLogger) {
  platformDB = new DBrqlite(config.url);
  if (getLogger) _getLogger = getLogger;
}

/**
 * Create and return the PlatformDB instance.
 * @returns {DBrqlite}
 */
function createPlatformDB () {
  if (!platformDB) {
    platformDB = new DBrqlite();
  }
  return platformDB;
}

/**
 * Build the migrations capability for the engine-agnostic MigrationRunner.
 * Returns null when the engine hasn't been initialized yet.
 */
function getMigrationsCapability () {
  if (!platformDB) return null;
  return buildMigrationsCapability(platformDB, _getLogger);
}

module.exports = {
  init,
  createPlatformDB,
  getMigrationsCapability
};
