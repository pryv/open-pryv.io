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

import type {} from 'node:fs';

const _internals = require('./_internals');

/**
 * Receive host internals from the barrel.
 */
function init (config: Record<string, any>, getLogger: (name: string) => any, internals: Record<string, any>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

function initStorageLayer (_storageLayer: any, _connection: any, _options: any): void {
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
