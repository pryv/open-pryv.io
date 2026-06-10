/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL storage engine plugin.
 *
 * Provides factories for all PostgreSQL-backed storage types.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals.ts');

/**
 * Receive host internals from the barrel.
 */
type Logger = { debug (msg: string): void; info (msg: string): void; warn (msg: string): void; error (a: unknown, b?: unknown): void };
type PgConnection = { query (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
type StorageLayer = {
  connection?: unknown;
  passwordResetRequests?: unknown;
  sessions?: unknown;
  accesses?: unknown;
  profile?: unknown;
  streams?: unknown;
  webhooks?: unknown;
  events?: { importAll: (u: UserOrId, items: EventRow[], cb: (err: Error | null) => void) => unknown; clearAll: (u: UserOrId, cb: (err: Error | null) => void) => unknown };
  iterateAllEvents?: () => AsyncIterableIterator<unknown>;
  getAllUserIdsFromCollection?: (col: string) => Promise<string[]>;
  clearCollection?: (col: string) => Promise<void>;
};
type InitOptions = {
  passwordResetRequestMaxAge?: number;
  sessionMaxAge?: number;
  integrityAccesses?: unknown;
  [k: string]: unknown;
};
type EventRow = { id: string; streamIds?: string[]; [k: string]: unknown };
type UserOrId = string | { id: string };

function init (config: Record<string, unknown>, getLogger: (name: string) => Logger, internals: Record<string, unknown>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

function initStorageLayer (storageLayer: StorageLayer, connection: PgConnection, options: InitOptions): void {
  const { PasswordResetRequestsPG } = require('./PasswordResetRequestsPG.ts');
  const { SessionsPG } = require('./SessionsPG.ts');
  const { AccessesPG } = require('./user/AccessesPG.ts');
  const { ProfilePG } = require('./user/ProfilePG.ts');
  const { StreamsPG } = require('./user/StreamsPG.ts');
  const { WebhooksPG } = require('./user/WebhooksPG.ts');

  storageLayer.connection = connection;
  storageLayer.passwordResetRequests = new PasswordResetRequestsPG(connection, {
    maxAge: options.passwordResetRequestMaxAge
  });
  storageLayer.sessions = new SessionsPG(connection, { maxAge: options.sessionMaxAge });
  storageLayer.accesses = new AccessesPG(connection, options.integrityAccesses);
  storageLayer.profile = new ProfilePG(connection);
  storageLayer.streams = new StreamsPG(connection);
  storageLayer.webhooks = new WebhooksPG(connection);

  // Events import/clear for backup restore (not used in normal operation —
  // normal event CRUD goes through the DataStore/Mall layer).
  storageLayer.events = {
    importAll (userOrUserId: UserOrId, items: EventRow[], callback: (err: Error | null) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      if (!items || items.length === 0) return callback(null);

      const COL_MAP: Record<string, string> = {
        headId: 'head_id',
        streamIds: 'stream_ids',
        endTime: 'end_time',
        clientData: 'client_data',
        createdBy: 'created_by',
        modifiedBy: 'modified_by'
      };
      const JSONB_COLS = new Set(['stream_ids', 'tags', 'content', 'client_data', 'attachments']);
      const mapCol = (prop: string): string => COL_MAP[prop] || prop;
      const mapVal = (col: string, val: unknown): unknown => {
        if (val === undefined) return null;
        if (JSONB_COLS.has(col) && val != null) return JSON.stringify(val);
        return val;
      };

      (async () => {
        for (const event of items) {
          const cols: string[] = ['user_id'];
          const vals: unknown[] = [userId];
          const placeholders: string[] = ['$1'];
          let idx = 2;

          for (const [prop, val] of Object.entries(event)) {
            const col = prop === 'id' ? 'id' : mapCol(prop);
            cols.push(col);
            vals.push(mapVal(col, val));
            placeholders.push(`$${idx}`);
            idx++;
          }

          await connection.query(
            `INSERT INTO events (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`,
            vals
          );

          // Populate event_streams junction table
          if (event.streamIds && event.streamIds.length > 0) {
            for (const streamId of event.streamIds) {
              const pathRes = await connection.query(
                'SELECT path FROM streams WHERE user_id = $1 AND id = $2',
                [userId, streamId]
              );
              const streamPath = pathRes.rows.length > 0 ? pathRes.rows[0].path : streamId + '/';
              await connection.query(
                'INSERT INTO event_streams (user_id, event_id, stream_id, stream_path) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                [userId, event.id, streamId, streamPath]
              );
            }
          }
        }
      })().then(() => callback(null)).catch(callback);
    },

    clearAll (userOrUserId: UserOrId, callback: (err: Error | null) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      (async () => {
        await connection.query('DELETE FROM event_streams WHERE user_id = $1', [userId]);
        await connection.query('DELETE FROM events WHERE user_id = $1', [userId]);
      })().then(() => callback(null)).catch(callback);
    }
  };

  storageLayer.iterateAllEvents = async function * () {
    const { rowToEvent } = require('./dataStore/localUserEventsPG.ts');
    const res = await connection.query('SELECT * FROM events');
    for (const row of res.rows) {
      yield rowToEvent(row);
    }
  };

  storageLayer.getAllUserIdsFromCollection = async function (collectionName: string): Promise<string[]> {
    const res = await connection.query(`SELECT DISTINCT user_id FROM ${collectionName}`);
    return res.rows.map((r: Record<string, unknown>) => r.user_id as string);
  };

  storageLayer.clearCollection = async function (collectionName: string): Promise<void> {
    await connection.query(`DELETE FROM ${collectionName}`);
  };
}

function getUserAccountStorage (): unknown {
  return require('./userAccountStorage.ts').userAccountStorage;
}

function getUsersLocalIndex (): unknown {
  return require('./usersLocalIndex.ts').UsersLocalIndexPG;
}

// -- DataStore ----------------------------------------------------------

function getDataStoreModule (): unknown {
  return require('./dataStore/index.ts').dataStore;
}

// -- PlatformStorage ----------------------------------------------------

function createPlatformDB (): unknown {
  const { DBpostgresql: DB } = require('./DBpostgresql.ts');
  return new DB();
}

// -- SeriesStorage (PostgreSQL) -----------------------------------------

async function createSeriesConnection (config: { databasePG?: unknown; [k: string]: unknown }): Promise<unknown> {
  const { PGSeriesConnection } = require('./pg_connection.ts');
  // Use provided databasePG (from barrel init) or fall back to storage
  const pgDb = config.databasePG || _internals.databasePG;
  return new PGSeriesConnection(pgDb);
}

// -- AuditStorage (PostgreSQL) ------------------------------------------

function createAuditStorage (): unknown {
  const { AuditStoragePG } = require('./AuditStoragePG.ts');
  const { DatabasePG } = require('./DatabasePG.ts');
  // Dedicated pool for audit: same DB, smaller pool size to avoid
  // contending with event/stream queries on the main pool.
  const pgConfig = _internals.config;
  const auditDb = new DatabasePG({
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.user,
    password: pgConfig.password,
    max: pgConfig.auditPoolSize || 5
  });
  return new AuditStoragePG(auditDb);
}

/**
 * Reconcile content-query acceleration indexes against the platform-wide
 * `storages.contentIndexes` declaration. Optional engine capability —
 * engines without it (e.g. SQLite, scan-only) are simply skipped.
 */
async function reconcileContentIndexes (declarations: unknown): Promise<unknown> {
  const { reconcileContentIndexes: reconcile } = require('./contentIndexReconciler.ts');
  return await reconcile(
    _internals.databasePG,
    declarations,
    _internals.lazyLogger('content-index-reconciler')
  );
}

/**
 * Build the migrations capability for the engine-agnostic MigrationRunner.
 * Returns null when the engine hasn't been initialized yet (databasePG not registered).
 */
function getMigrationsCapability (): unknown | null {
  if (!_internals.databasePG) return null;
  const { buildMigrationsCapability } = require('./SchemaMigrations.ts');
  return buildMigrationsCapability();
}

export { init,
  initStorageLayer,
  getUserAccountStorage,
  getUsersLocalIndex,
  getDataStoreModule,
  createPlatformDB,
  createSeriesConnection,
  createAuditStorage,
  getMigrationsCapability,
  reconcileContentIndexes };