/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SQLite storage engine plugin.
 *
 * Note: StorageLayer (Sessions, etc.) is NOT yet implemented for SQLite.
 * Note: dataStore streams fallback to MongoDB (incomplete).
 */

const _internals = require('./_internals');

/**
 * Receive host internals from the barrel.
 * @param {Object} config - Engine-specific configuration from manifest configKey
 * @param {Function} getLogger - Logger factory
 * @param {Object} internals - Map of name → value (remaining host internals)
 */
function init (config, getLogger, internals) {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

function initStorageLayer (_storageLayer, _connection, _options) {
  throw new Error('SQLite StorageLayer not yet implemented. Use storageEngine: "mongodb" for now.');
}

function getUserAccountStorage () {
  return require('./userAccountStorage');
}

function getUsersLocalIndex () {
  return require('./usersLocalIndex');
}

// -- DataStore ----------------------------------------------------------

function getDataStoreModule () {
  return require('./dataStore');
}

// -- AuditStorage -------------------------------------------------------

function createAuditStorage () {
  const Storage = require('./userSQLite/Storage');
  return new Storage('audit');
}

module.exports = {
  init,
  initStorageLayer,
  getUserAccountStorage,
  getUsersLocalIndex,
  getDataStoreModule,
  createAuditStorage
};
