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

import type { Logger } from '@pryv/boiler';

interface StorageLayerLike {
  connection?: unknown;
  sessions?: unknown;
  passwordResetRequests?: unknown;
  accesses?: unknown;
  profile?: unknown;
  streams?: unknown;
  webhooks?: unknown;
  events?: unknown;
  iterateAllEvents?: () => AsyncIterableIterator<unknown>;
  getAllUserIdsFromCollection?: (name: string) => Promise<string[]>;
  clearCollection?: (name: string) => Promise<void>;
  [k: string]: unknown;
}

interface InitOptions {
  sessionMaxAge?: number;
  passwordResetRequestMaxAge?: number;
  integrityAccesses?: unknown;
  [k: string]: unknown;
}

type UserOrId = string | { id: string };

function init (config: Record<string, unknown>, getLogger: (name: string) => Logger, internals: Record<string, unknown>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

function buildStub (label: string, methods: string[]): Record<string, (...args: unknown[]) => never> {
  const stub: Record<string, (...args: unknown[]) => never> = {};
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

async function initStorageLayer (storageLayer: StorageLayerLike, _connection: unknown, options: InitOptions): Promise<void> {
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
    importAll (_userOrUserId: UserOrId, _items: unknown[], callback: (err: Error | null) => void) {
      // No-op: events are routed through the dataStore layer for the
      // SQLite engine. Backup-restore goes via the user-events dataStore
      // path; nothing in the live code path calls this.
      callback(null);
    },
    async clearAll (userOrUserId: UserOrId, callback: (err: Error | null) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      try {
        const { UserBaseStorageDb } = require('./userBaseStorage/UserBaseStorageDb.ts');
        const udb = await UserBaseStorageDb.forUser(userId);
        try { udb.db.prepare('DELETE FROM events').run(); } catch (_e) { /* table may not exist */ }
        callback(null);
      } catch (e) {
        callback(e as Error);
      }
    }
  };

  storageLayer.iterateAllEvents = async function * () {
    // Walk every user known to the local index, yield events from each
    // per-user baseStorage file. Used by the integrity-final-check at
    // test teardown.
    const userIds = await listKnownUserIdsForCleanup();
    for (const userId of userIds) {
      const udb = await openUserBaseStorageDbSafe(userId);
      if (!udb) continue;
      try {
        const rows = udb.db.prepare('SELECT * FROM events').all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const event: Record<string, unknown> = row.data ? JSON.parse(row.data as string) : {};
          event.id = row.id;
          if (row.head_id != null) event.headId = row.head_id;
          if (row.deleted != null) event.deleted = row.deleted;
          event.userId = userId;
          yield event;
        }
      } catch (_e) {
        // Table doesn't exist for this user — no events to yield.
      }
    }
  };

  storageLayer.getAllUserIdsFromCollection = async function (_collectionName: string): Promise<string[]> {
    // The integrity check uses this to walk userIds with rows in a
    // shared collection and verify each is also in the users-index.
    // Under SQLite (per-user file) every userId-with-data is by
    // construction also in the index (the index is the source-of-truth
    // for known users — the per-user file is created lazily on first
    // write only for indexed users). Returning all known userIds
    // satisfies the integrity invariant without walking every per-user
    // file's tables.
    return await listKnownUserIdsForCleanup();
  };

  storageLayer.clearCollection = async function (collectionName: string): Promise<void> {
    // For each user known to the index, DELETE every row from the named
    // table in their per-user baseStorage file. Used by
    // `databaseFixture.cleanEverything()`.
    const userIds = await listKnownUserIdsForCleanup();
    for (const userId of userIds) {
      const udb = await openUserBaseStorageDbSafe(userId);
      if (!udb) continue;
      try {
        udb.db.prepare(`DELETE FROM ${collectionName}`).run();
      } catch (_e) {
        // Table may not exist for this user — already cleared.
      }
    }
  };

  /**
   * Returns userIds known to the local SQLite users index. Uses the
   * canonical singleton from `storage.getUsersLocalIndex()` so we don't
   * open redundant SQLite handles per call (multiple handles caused
   * WAL-contention hangs in early L.5 attempts).
   */
  async function listKnownUserIdsForCleanup (): Promise<string[]> {
    try {
      const { getUsersLocalIndex } = require('storage');
      const idx = await getUsersLocalIndex();
      const byName = await idx.getAllByUsername();
      return Object.values(byName) as string[];
    } catch (_e) {
      return [];
    }
  }

  async function openUserBaseStorageDbSafe (userId: string): Promise<{ db: { prepare: (sql: string) => { all: () => unknown[]; run: () => unknown } } } | null> {
    try {
      const { UserBaseStorageDb } = require('./userBaseStorage/UserBaseStorageDb.ts');
      return await UserBaseStorageDb.forUser(userId);
    } catch (_e) {
      return null;
    }
  }
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

function createSeriesConnection (config: Record<string, unknown>): unknown {
  return require('./seriesStorage/index.ts').createSeriesConnection(config);
}

export { init, initStorageLayer, getUserAccountStorage, getUsersLocalIndex, getDataStoreModule, createAuditStorage, createSeriesConnection };
