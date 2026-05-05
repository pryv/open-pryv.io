/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { StorageLayer } = require('./StorageLayer');
const { Size } = require('./Size');
const userLocalDirectory = require('./userLocalDirectory');

const interfaces = {
  UserAccountStorage: require('storages/interfaces/baseStorage/UserAccountStorage'),
  UsersLocalIndexDB: require('storages/interfaces/baseStorage/UsersLocalIndexDB'),
  EventFiles: require('storages/interfaces/fileStorage/EventFiles'),
  UserStorage: require('storages/interfaces/baseStorage/UserStorage'),
  Sessions: require('storages/interfaces/baseStorage/Sessions'),
  PasswordResetRequests: require('storages/interfaces/baseStorage/PasswordResetRequests'),
  AuditStorage: require('storages/interfaces/auditStorage/AuditStorage'),
  UserAuditDatabase: require('storages/interfaces/auditStorage/UserAuditDatabase')
};

export { Size, StorageLayer, getStorageLayer, getDatabaseSync, userLocalDirectory, getUsersLocalIndex, getUserAccountStorage, interfaces };

/**
 * Ensure the storages barrel is initialized (lazy fallback).
 */
async function ensureBarrel () {
  const storages = require('storages');
  if (!storages.storageLayer) await storages.init();
  return storages;
}

/**
 * @returns {Promise<Object>} usersLocalIndex singleton
 */
async function getUsersLocalIndex () {
  return (await ensureBarrel()).usersLocalIndex;
}

/**
 * @returns {Promise<Object>} userAccountStorage singleton
 */
async function getUserAccountStorage () {
  return (await ensureBarrel()).userAccountStorage;
}

/**
 * @returns {Promise<StorageLayer>}
 */
async function getStorageLayer () {
  return (await ensureBarrel()).storageLayer;
}

// Lazy-created MongoDB database — used by getDatabaseSync before barrel init
// (e.g. test-helpers/dependencies.js at module load).
let _lazyDatabase;
function _ensureMongoDatabase () {
  if (!_lazyDatabase) {
    const { getConfigUnsafe, getLogger } = require('@pryv/boiler');
    const { dataBaseTracer } = require('tracing');
    const config = getConfigUnsafe(true);
    const { _internals: mongoInternals } = require('storages/engines/mongodb/src/_internals');
    if (!mongoInternals.getLogger) mongoInternals.set('getLogger', getLogger);
    const { Database } = require('storages/engines/mongodb/src/Database');
    _lazyDatabase = new Database(config.get('storages:engines:mongodb'));
    dataBaseTracer(_lazyDatabase);
  }
  return _lazyDatabase;
}

/**
 * Get the MongoDB database connection (sync).
 * Falls back to lazy construction for test code that needs it before barrel init.
 * @returns {Object}
 */
function getDatabaseSync () {
  return require('storages').database || _ensureMongoDatabase();
}
