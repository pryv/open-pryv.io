/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SQLite storage engine plugin.
 *
 * State of implementation:
 *  - userAccountStorage    ✓ shipped
 *  - usersLocalIndex       ✓ shipped
 *  - auditStorage          ✓ shipped (per-user file via SqliteStorage)
 *  - baseStorage           ⚠ shared DB + stub classes wired; real Sessions/
 *                            PasswordResetRequests and per-user Accesses/
 *                            Webhooks/Profile/Streams land in follow-up work.
 *  - dataStore             ⚠ partial (events stream tail outstanding).
 *
 * Stubs satisfy validateUserStorage / validateSessions / validatePasswordResetRequests
 * (method-existence check only) but throw at runtime on first call.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals.ts');

function init (config: Record<string, any>, getLogger: (name: string) => any, internals: Record<string, any>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

function buildStub (label: string, methods: string[]): any {
  const stub: Record<string, any> = {};
  for (const m of methods) {
    stub[m] = function () {
      throw new Error(`SQLite ${label}.${m}() not yet implemented`);
    };
  }
  return stub;
}

const USER_STORAGE_METHODS = [
  'getCollectionInfo', 'find', 'findOne', 'insertOne', 'findOneAndUpdate',
  'updateOne', 'updateMany', 'delete', 'removeOne', 'removeMany', 'removeAll',
  'count', 'countAll', 'findDeletions', 'iterateAll',
  'exportAll', 'importAll', 'clearAll'
];

const SESSIONS_METHODS = [
  'get', 'getMatching', 'generate', 'touch', 'expireNow', 'destroy',
  'clearAll', 'remove', 'exportAll', 'importAll'
];

const PRR_METHODS = [
  'get', 'generate', 'destroy', 'clearAll', 'exportAll', 'importAll'
];

async function initStorageLayer (storageLayer: any, _connection: any, options: any): Promise<void> {
  const { DatabaseSQLite } = require('./DatabaseSQLite.ts');
  const { SessionsSQLite } = require('./SessionsSQLite.ts');
  const { PasswordResetRequestsSQLite } = require('./PasswordResetRequestsSQLite.ts');
  const { AccessesSQLite } = require('./user/AccessesSQLite.ts');
  const { ProfileSQLite } = require('./user/ProfileSQLite.ts');
  const { StreamsSQLite } = require('./user/StreamsSQLite.ts');
  const { WebhooksSQLite } = require('./user/WebhooksSQLite.ts');
  const sharedDb = new DatabaseSQLite();
  await sharedDb.init();

  storageLayer.connection = sharedDb;

  storageLayer.sessions = new SessionsSQLite(sharedDb, { maxAge: options.sessionMaxAge });
  storageLayer.passwordResetRequests = new PasswordResetRequestsSQLite(sharedDb, { maxAge: options.passwordResetRequestMaxAge });
  storageLayer.accesses = new AccessesSQLite(options.integrityAccesses);
  storageLayer.profile = new ProfileSQLite();
  storageLayer.streams = new StreamsSQLite();
  storageLayer.webhooks = new WebhooksSQLite();

  storageLayer.events = {
    importAll (_userOrUserId: any, _items: any[], callback: (err: any) => void) {
      callback(new Error('SQLite events.importAll not yet implemented'));
    },
    clearAll (_userOrUserId: any, callback: (err: any) => void) {
      callback(new Error('SQLite events.clearAll not yet implemented'));
    }
  };

  storageLayer.iterateAllEvents = async function * () {
    throw new Error('SQLite iterateAllEvents not yet implemented');
    yield; // unreachable; satisfies generator type
  };

  storageLayer.getAllUserIdsFromCollection = async function (_collectionName: string): Promise<string[]> {
    throw new Error('SQLite getAllUserIdsFromCollection not yet implemented');
  };

  storageLayer.clearCollection = async function (_collectionName: string): Promise<void> {
    throw new Error('SQLite clearCollection not yet implemented');
  };
}

function getUserAccountStorage () {
  const { userAccountStorage } = require('./userAccountStorage.ts');
  return userAccountStorage;
}

function getUsersLocalIndex () {
  const { DBIndex } = require('./usersLocalIndex.ts');
  return DBIndex;
}

// -- DataStore ----------------------------------------------------------

function getDataStoreModule () {
  return require('./dataStore/index.ts').dataStore;
}

// -- AuditStorage -------------------------------------------------------

function createAuditStorage () {
  const { SqliteStorage } = require('./userSQLite/Storage.ts');
  return new SqliteStorage('audit');
}

// -- SeriesStorage (SQLite, per-user file) ------------------------------

function createSeriesConnection (config: any): any {
  return require('./seriesStorage/index.ts').createSeriesConnection(config);
}

export { init, initStorageLayer, getUserAccountStorage, getUsersLocalIndex, getDataStoreModule, createAuditStorage, createSeriesConnection };
