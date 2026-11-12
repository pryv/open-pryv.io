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

import type { Logger } from '@pryv/boiler';
import type { UserOrId } from '../../../interfaces/_shared/types.ts';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals.ts');
const concurrentSafeWrite = require('./concurrentSafeWrite.ts');
const integrityLogger = _internals.lazyLogger('sqlite-integrity');

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
  getAllUserIdsFromCollections?: (names: string[]) => Promise<Record<string, string[]>>;
  clearCollection?: (name: string) => Promise<void>;
  [k: string]: unknown;
}

interface InitOptions {
  sessionMaxAge?: number;
  passwordResetRequestMaxAge?: number;
  integrityAccesses?: unknown;
  [k: string]: unknown;
}

function init (config: Record<string, unknown>, getLogger: (name: string) => Logger, internals: Record<string, unknown>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

async function initStorageLayer (storageLayer: StorageLayerLike, _connection: unknown, options: InitOptions): Promise<void> {
  const { DatabaseSQLite } = require('./DatabaseSQLite.ts');
  const { SessionsSQLite } = require('./SessionsSQLite.ts');
  const { PasswordResetRequestsSQLite } = require('./PasswordResetRequestsSQLite.ts');
  const { AccessesSQLite, recomputeAccessesIntegrityOnce } = require('./user/AccessesSQLite.ts');
  const { ProfileSQLite } = require('./user/ProfileSQLite.ts');
  const { StreamsSQLite } = require('./user/StreamsSQLite.ts');
  const { WebhooksSQLite } = require('./user/WebhooksSQLite.ts');
  const sharedDb = new DatabaseSQLite();
  await sharedDb.init();

  storageLayer.connection = sharedDb;

  storageLayer.sessions = new SessionsSQLite(sharedDb, { maxAge: options.sessionMaxAge });
  storageLayer.passwordResetRequests = new PasswordResetRequestsSQLite(sharedDb, { maxAge: options.passwordResetRequestMaxAge });
  storageLayer.accesses = new AccessesSQLite(options.integrityAccesses);
  // Access hashes stored before they covered the wire form: recomputed once
  // (no schema-migration runner for this engine; a marker file records it).
  try {
    await recomputeAccessesIntegrityOnce(storageLayer.accesses);
  } catch (err) {
    integrityLogger.error('access integrity recompute failed, retried at next start: ' + (err as Error).message);
  }
  storageLayer.profile = new ProfileSQLite();
  storageLayer.streams = new StreamsSQLite();
  storageLayer.webhooks = new WebhooksSQLite();

  // Events export/import/clear for backup + restore. Live events for the
  // SQLite engine are in the per-user dataStore file (userSQLite storage
  // 'local', `<userDir>/local-<version>.sqlite`) — NOT in the per-user
  // baseStorage file, which only holds accesses/profile/streams/webhooks.
  // exportAll/importAll speak canonical (camelCase) event objects via
  // eventsSchema fromDB/toDB so backup archives round-trip across engines.
  storageLayer.events = {
    exportAll (userOrUserId: UserOrId, callback: (err: Error | null, items?: unknown[]) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      (async () => {
        const udb = await openUserEventsDbSafe(userId, false);
        if (!udb) return [];
        const eventsSchema = require('./userSQLite/schema/events.ts');
        return udb.exportAllEvents().map((row: Record<string, unknown>) => eventsSchema.fromDB(row));
      })().then((items) => callback(null, items)).catch(callback);
    },
    async * exportAllStreamed (userOrUserId: UserOrId): AsyncGenerator<unknown> {
      // Streaming counterpart of exportAll for backup: yields canonical
      // (camelCase) events one at a time so backup memory stays bounded to the
      // writer's chunk size rather than the whole collection. Same no-close
      // lifecycle and empty-store handling (yield nothing) as exportAll.
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      const udb = await openUserEventsDbSafe(userId, false);
      if (!udb) return;
      const eventsSchema = require('./userSQLite/schema/events.ts');
      for await (const row of udb.exportAllEventsStreamed()) {
        yield eventsSchema.fromDB(row);
      }
    },
    importAll (userOrUserId: UserOrId, items: unknown[], callback: (err: Error | null) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      if (!items || items.length === 0) return callback(null);
      (async () => {
        const udb = await openUserEventsDbSafe(userId, true);
        if (!udb) throw new Error(`SQLite events.importAll: cannot open events DB for user ${userId}`);
        const eventsSchema = require('./userSQLite/schema/events.ts');
        await udb.importAllEvents(items.map((event) => eventsSchema.toDB(event)));
      })().then(() => callback(null)).catch(callback);
    },
    clearAll (userOrUserId: UserOrId, callback: (err: Error | null) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      (async () => {
        const udb = await openUserEventsDbSafe(userId, false);
        if (!udb) return;
        await udb.deleteEvents({ query: [] });
      })().then(() => callback(null)).catch(callback);
    }
  };

  storageLayer.iterateAllEvents = async function * () {
    // Walk every user known to the local index, yield events from each
    // per-user dataStore ('local') file. Used by the integrity-final-check
    // at test teardown.
    const eventsSchema = require('./userSQLite/schema/events.ts');
    const userIds = await listKnownUserIdsForCleanup();
    for (const userId of userIds) {
      const udb = await openUserEventsDbSafe(userId, false);
      if (!udb) continue;
      let rows: Array<Record<string, unknown>>;
      try {
        rows = udb.exportAllEvents();
      } catch (_e) {
        continue; // events table doesn't exist for this user yet
      }
      for (const row of rows) {
        // Yield the canonical event shape WITHOUT a user marker — same as
        // the PG engine (rowToEvent strips user_id). The integrity hash is
        // computed over this shape; an extra userId property breaks it.
        yield eventsSchema.fromDB(row);
      }
    }
  };

  /**
   * Open the per-user events DB (userSQLite storage 'local'). When
   * `create` is false and the user has no events file yet, returns null
   * instead of lazily creating an empty one (read paths must not leave
   * empty `local-*.sqlite` files behind for users that never had events).
   */
  async function openUserEventsDbSafe (userId: string, create: boolean): Promise<{ exportAllEvents: () => Array<Record<string, unknown>>; exportAllEventsStreamed: () => AsyncIterable<Record<string, unknown>>; importAllEvents: (rows: unknown[]) => Promise<void>; deleteEvents: (params: Record<string, unknown>) => Promise<unknown> } | null> {
    try {
      const fs = require('node:fs');
      const { getStorage } = require('./userSQLite/index.ts');
      const userStorage = await getStorage('local');
      if (!create) {
        // `existingPathForUser` creates nothing (`dbgetPathForUser` makes the directory).
        const dbPath = userStorage.existingPathForUser(userId);
        if (!fs.existsSync(dbPath)) return null;
      }
      return await userStorage.forUser(userId);
    } catch (_e) {
      return null;
    }
  }

  storageLayer.getAllUserIdsFromCollections = async function (collectionNames: string[]): Promise<Record<string, string[]>> {
    // The integrity check uses this to find the user ids holding rows that
    // the users index does not know (rows an account deletion left). Rows
    // live in per-user files: walk the user directories on disk once and
    // look in the files of the ids the index lacks. Indexed ids are listed
    // for every collection without opening their files (the check runs
    // around every test: opening each user's files there is too slow), so
    // the per-collection counts are the index size plus the orphans.
    const { getStorage } = require('./userSQLite/index.ts');
    const { UserBaseStorageDb } = require('./userBaseStorage/UserBaseStorageDb.ts');
    const eventsStorage = await getStorage('local');
    const indexed = await listKnownUserIdsForCleanup();
    const indexedSet = new Set(indexed);
    const res: Record<string, string[]> = {};
    for (const name of collectionNames) res[name] = [...indexed];
    const baseTables = collectionNames.filter((name) => name !== 'events');
    const eventsTables = collectionNames.filter((name) => name === 'events');
    for (const userId of await _internals.userLocalDirectory.listUserIds()) {
      if (indexedSet.has(userId)) continue;
      const found = tablesWithRows(UserBaseStorageDb.existingPathForUser(userId), baseTables)
        .concat(tablesWithRows(eventsStorage.existingPathForUser(userId), eventsTables));
      for (const name of found) res[name].push(userId);
    }
    return res;
  };

  /**
   * The tables of the database file holding a row. Only reads: a missing
   * file or table is no rows, and no file is created. A file that cannot be
   * read (not a database, locked) counts as holding rows: the check then
   * reports its user id rather than failing. Not opened read-only: a
   * read-only connection cannot remove the `-wal` / `-shm` files of a WAL
   * database on close and leaves them next to it (closing the last
   * connection checkpoints the WAL into the file instead).
   */
  function tablesWithRows (dbPath: string, tables: string[]): string[] {
    const fs = require('node:fs');
    if (tables.length === 0 || !fs.existsSync(dbPath)) return [];
    const SQLite3 = require('better-sqlite3');
    let db: { prepare: (sql: string) => { get: () => unknown }; close: () => void };
    try {
      db = new SQLite3(dbPath, { fileMustExist: true, timeout: 1000 });
    } catch (e) {
      // Removed since `existsSync` (an account erasure in progress).
      if ((e as { code?: string }).code === 'SQLITE_CANTOPEN') return [];
      integrityLogger.warn('integrity: cannot open ' + dbPath + ': ' + (e as Error).message);
      return tables;
    }
    try {
      return tables.filter((table) => {
        try {
          return db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() != null;
        } catch (e) {
          if (/no such table/.test((e as Error).message)) return false;
          integrityLogger.warn('integrity: cannot read ' + table + ' in ' + dbPath + ': ' + (e as Error).message);
          return true;
        }
      });
    } finally {
      db.close();
    }
  }

  storageLayer.clearCollection = async function (collectionName: string): Promise<void> {
    // For each user known to the index, DELETE every row from the named
    // table in their per-user baseStorage file. Used by
    // `databaseFixture.cleanEverything()`.
    const userIds = await listKnownUserIdsForCleanup();
    for (const userId of userIds) {
      const udb = await openUserBaseStorageDbSafe(userId);
      if (!udb) continue;
      try {
        await concurrentSafeWrite.execute(() => { udb.db.prepare(`DELETE FROM ${collectionName}`).run(); });
      } catch (e) {
        // Table may not exist for this user: already cleared. Anything else
        // (a write that stayed busy) must not leave rows behind silently.
        if (!/no such table/.test((e as Error).message)) throw e;
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

function getExternalIdsLocal () {
  return require('./externalIdsLocal.ts').ExternalIdsLocalSQLite;
}

function getDeletionNoticesLocal () {
  return require('./deletionNoticesLocal.ts').DeletionNoticesLocalSQLite;
}

function getErasuresLocal () {
  return require('./erasuresLocal.ts').ErasuresLocalSQLite;
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

export { init, initStorageLayer, getUserAccountStorage, getUsersLocalIndex, getExternalIdsLocal, getDeletionNoticesLocal, getErasuresLocal, getDataStoreModule, createAuditStorage, createSeriesConnection };
