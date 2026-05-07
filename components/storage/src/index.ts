/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { StorageLayer } = require('./StorageLayer.ts');
const { Size } = require('./Size.ts');
const userLocalDirectory = require('./userLocalDirectory.ts');

const interfaces = {
  UserAccountStorage: require('storages/interfaces/baseStorage/UserAccountStorage.ts'),
  UsersLocalIndexDB: require('storages/interfaces/baseStorage/UsersLocalIndexDB.ts'),
  EventFiles: require('storages/interfaces/fileStorage/EventFiles.ts'),
  UserStorage: require('storages/interfaces/baseStorage/UserStorage.ts'),
  Sessions: require('storages/interfaces/baseStorage/Sessions.ts'),
  PasswordResetRequests: require('storages/interfaces/baseStorage/PasswordResetRequests.ts'),
  AuditStorage: require('storages/interfaces/auditStorage/AuditStorage.ts'),
  UserAuditDatabase: require('storages/interfaces/auditStorage/UserAuditDatabase.ts')
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

async function getUsersLocalIndex () {
  return (await ensureBarrel()).usersLocalIndex;
}

async function getUserAccountStorage () {
  return (await ensureBarrel()).userAccountStorage;
}

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
    const { _internals: mongoInternals } = require('storages/engines/mongodb/src/_internals.ts');
    if (!mongoInternals.getLogger) mongoInternals.set('getLogger', getLogger);
    const { Database } = require('storages/engines/mongodb/src/Database.ts');
    _lazyDatabase = new Database(config.get('storages:engines:mongodb'));
    dataBaseTracer(_lazyDatabase);
  }
  return _lazyDatabase;
}

/**
 * Get the MongoDB database connection (sync).
 * Falls back to lazy construction for test code that needs it before barrel init.
 */
function getDatabaseSync () {
  return require('storages').database || _ensureMongoDatabase();
}
