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
import type { Logger } from '@pryv/boiler';
import type { SeriesConnection } from '../../../interfaces/seriesStorage/SeriesConnection.ts';
import type { UserOrId } from '../../../interfaces/_shared/types.ts';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals.ts');

/**
 * Receive host internals from the barrel.
 */
type PgConnection = {
  query (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  queryIterable (sql: string, params?: unknown[], batchSize?: number): AsyncGenerator<Record<string, unknown>>;
};
type StorageLayer = {
  connection?: unknown;
  passwordResetRequests?: unknown;
  sessions?: unknown;
  accesses?: unknown;
  profile?: unknown;
  streams?: unknown;
  webhooks?: unknown;
  events?: { exportAll: (u: UserOrId, cb: (err: Error | null, items?: EventRow[]) => void) => unknown; exportAllStreamed?: (u: UserOrId) => AsyncGenerator<unknown>; importAll: (u: UserOrId, items: EventRow[], cb: (err: Error | null) => void) => unknown; clearAll: (u: UserOrId, cb: (err: Error | null) => void) => unknown };
  iterateAllEvents?: () => AsyncIterableIterator<unknown>;
  getAllUserIdsFromCollections?: (cols: string[]) => Promise<Record<string, string[]>>;
  listAccountStoreOrphans?: (userIds?: string[]) => Promise<AccountStoreOrphanCounts[]>;
  listEventTypeOrphans?: (type: string, userIds?: string[]) => Promise<EventTypeOrphanCounts[]>;
  deleteEventTypeOrphanRows?: (type: string, userId: string) => Promise<number>;
  clearCollection?: (col: string) => Promise<void>;
};
/** Events of one type under an id the users index lacks (an erased account's leftovers). */
type EventTypeOrphanCounts = {
  userId: string;
  /** Rows of the asked type. */
  events: number;
  /** Rows of any other type under the same id. */
  otherEvents: number;
  /** Account fields and passwords under the same id (an erasure leaves none). */
  accountStoreRows: number;
};
/** Rows of the account store (`account_fields`, `passwords`, `store_key_values`) under an id the users index lacks. */
type AccountStoreOrphanCounts = {
  userId: string;
  accountFields: number;
  passwords: number;
  storeKeyValues: number;
  /** Newest `account_fields.time` (seconds), null when the id holds none. */
  newestFieldTime: number | null;
};
type InitOptions = {
  passwordResetRequestMaxAge?: number;
  sessionMaxAge?: number;
  integrityAccesses?: unknown;
  tokenProtection?: unknown;
  [k: string]: unknown;
};
type EventRow = { id: string; streamIds?: string[]; [k: string]: unknown };

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
  if (options.tokenProtection == null) throw new Error('PostgreSQL storage layer: tokenProtection is required');
  _internals.set('tokenProtection', options.tokenProtection);
  storageLayer.sessions = new SessionsPG(connection, { maxAge: options.sessionMaxAge }, options.tokenProtection);
  storageLayer.accesses = new AccessesPG(connection, options.integrityAccesses, options.tokenProtection);
  storageLayer.profile = new ProfilePG(connection);
  storageLayer.streams = new StreamsPG(connection);
  storageLayer.webhooks = new WebhooksPG(connection);

  // Events export/import/clear for backup + restore (not used in normal
  // operation — normal event CRUD goes through the DataStore/Mall layer).
  // exportAll returns canonical (camelCase) event objects — the exact shape
  // importAll consumes — so backup archives round-trip across engines.
  storageLayer.events = {
    exportAll (userOrUserId: UserOrId, callback: (err: Error | null, items?: EventRow[]) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      const { rowToEvent } = require('./dataStore/localUserEventsPG.ts');
      connection.query('SELECT * FROM events WHERE user_id = $1', [userId])
        // NOT the bare query result: pg returns {command,rowCount,oid,rows,fields};
        // forwarding it instead of `.rows` crashed bin/backup.js on every PG platform.
        .then((res: { rows: Array<Record<string, unknown>> }) => callback(null, res.rows.map(rowToEvent)))
        .catch(callback);
    },
    /**
     * Streaming counterpart of exportAll for bounded-memory backup: yields
     * canonical (camelCase) events one at a time through a server-side cursor,
     * so backup memory is a batch rather than the whole collection. Optional by
     * design: the orchestrator feature-detects it and falls back to exportAll,
     * so an engine can adopt streaming independently.
     *
     * Stays on the main pool. The read/write split exists on the AUDIT store
     * only, and the backup process is the sole holder of this connection.
     */
    async * exportAllStreamed (userOrUserId: UserOrId): AsyncGenerator<unknown> {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      const { rowToEvent } = require('./dataStore/localUserEventsPG.ts');
      for await (const row of connection.queryIterable('SELECT * FROM events WHERE user_id = $1', [userId])) {
        yield rowToEvent(row);
      }
    },
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
              // Only while its event row exists, held (as in localUserEventsPG).
              await connection.query(
                'INSERT INTO event_streams (user_id, event_id, stream_id, stream_path) ' +
                'SELECT $1::text, $2::text, $3::text, $4::text ' +
                'WHERE EXISTS (SELECT 1 FROM events WHERE user_id = $1::text AND id = $2::text FOR KEY SHARE) ' +
                'ON CONFLICT DO NOTHING',
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
        // Events first, as the account erasure does (see localUserEventsPG._deleteUser).
        await connection.query('DELETE FROM events WHERE user_id = $1', [userId]);
        await connection.query('DELETE FROM event_streams WHERE user_id = $1', [userId]);
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

  storageLayer.getAllUserIdsFromCollections = async function (collectionNames: string[]): Promise<Record<string, string[]>> {
    const res: Record<string, string[]> = {};
    for (const collectionName of collectionNames) {
      const rows = await connection.query(`SELECT DISTINCT user_id FROM ${collectionName}`);
      res[collectionName] = rows.rows.map((r: Record<string, unknown>) => r.user_id as string);
    }
    return res;
  };

  /**
   * The ids holding rows in the account store (account fields, passwords,
   * store key-values) with no users index row: a registration that failed
   * after its local writes on a release whose compensation missed them, or
   * an account deletion in progress. Counts and the newest account-field
   * time only: no value is read. Optional engine capability (the per-user
   * SQLite files go with their user directory). `userIds` restricts the
   * answer to these ids.
   */
  storageLayer.listAccountStoreOrphans = async function (userIds?: string[]): Promise<AccountStoreOrphanCounts[]> {
    const filter = userIds != null ? ' AND i.user_id = ANY($1::text[])' : '';
    const res = await connection.query(
      'WITH ids AS (' +
      'SELECT user_id FROM account_fields UNION SELECT user_id FROM passwords UNION SELECT user_id FROM store_key_values) ' +
      'SELECT i.user_id, ' +
      '(SELECT COUNT(*)::int FROM account_fields a WHERE a.user_id = i.user_id) AS account_fields, ' +
      '(SELECT COUNT(*)::int FROM passwords p WHERE p.user_id = i.user_id) AS passwords, ' +
      '(SELECT COUNT(*)::int FROM store_key_values s WHERE s.user_id = i.user_id) AS store_key_values, ' +
      '(SELECT MAX(a.time) FROM account_fields a WHERE a.user_id = i.user_id) AS newest_field_time ' +
      'FROM ids i WHERE NOT EXISTS (SELECT 1 FROM users_index u WHERE u.user_id = i.user_id)' + filter +
      ' ORDER BY i.user_id',
      userIds != null ? [userIds] : []);
    return res.rows.map((r: Record<string, unknown>) => ({
      userId: r.user_id as string,
      accountFields: Number(r.account_fields),
      passwords: Number(r.passwords),
      storeKeyValues: Number(r.store_key_values),
      newestFieldTime: r.newest_field_time == null ? null : Number(r.newest_field_time)
    }));
  };

  /**
   * The ids holding events of `type` with no users index row, with how many
   * events of that type and of any other type each holds: what an erasure
   * left in the shared events table (CMC retry rows written after it).
   * Counts only, no content read. Optional engine capability (on SQLite the
   * events go with the user directory). `userIds` restricts the answer.
   */
  storageLayer.listEventTypeOrphans = async function (type: string, userIds?: string[]): Promise<EventTypeOrphanCounts[]> {
    const filter = userIds != null ? ' AND e.user_id = ANY($2::text[])' : '';
    const res = await connection.query(
      'SELECT e.user_id, COUNT(*)::int AS events, ' +
      '(SELECT COUNT(*)::int FROM events o WHERE o.user_id = e.user_id AND o.type IS DISTINCT FROM $1) AS other_events, ' +
      '((SELECT COUNT(*)::int FROM account_fields a WHERE a.user_id = e.user_id) + ' +
      '(SELECT COUNT(*)::int FROM passwords p WHERE p.user_id = e.user_id)) AS account_store_rows ' +
      'FROM events e WHERE e.type = $1 ' +
      'AND NOT EXISTS (SELECT 1 FROM users_index u WHERE u.user_id = e.user_id)' + filter +
      ' GROUP BY e.user_id ORDER BY e.user_id',
      userIds != null ? [type, userIds] : [type]);
    return res.rows.map((r: Record<string, unknown>) => ({
      userId: r.user_id as string,
      events: Number(r.events),
      otherEvents: Number(r.other_events),
      accountStoreRows: Number(r.account_store_rows)
    }));
  };

  /**
   * Deletes the events of `type` (and their stream links) under `userId`, in
   * one statement that re-checks there is still no users index row, no erasure
   * record and no account field or password for the id: an account indexed,
   * an erasure started or an account store found since the caller's checks
   * keeps its rows. Returns the number of events deleted.
   */
  storageLayer.deleteEventTypeOrphanRows = async function (type: string, userId: string): Promise<number> {
    const res = await connection.query(
      'WITH gone AS (' +
      'DELETE FROM events e WHERE e.user_id = $1 AND e.type = $2 ' +
      'AND NOT EXISTS (SELECT 1 FROM users_index u WHERE u.user_id = $1) ' +
      'AND NOT EXISTS (SELECT 1 FROM account_erasures a WHERE a.user_id = $1) ' +
      'AND NOT EXISTS (SELECT 1 FROM account_fields f WHERE f.user_id = $1) ' +
      'AND NOT EXISTS (SELECT 1 FROM passwords p WHERE p.user_id = $1) ' +
      'RETURNING e.id), ' +
      'links AS (DELETE FROM event_streams s WHERE s.user_id = $1 AND s.event_id IN (SELECT id FROM gone)) ' +
      'SELECT COUNT(*)::int AS n FROM gone',
      [userId, type]);
    return Number(res.rows[0]?.n ?? 0);
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

function getExternalIdsLocal (): unknown {
  return require('./externalIdsLocal.ts').ExternalIdsLocalPG;
}

function getDeletionNoticesLocal (): unknown {
  return require('./deletionNoticesLocal.ts').DeletionNoticesLocalPG;
}

function getErasuresLocal (): unknown {
  return require('./erasuresLocal.ts').ErasuresLocalPG;
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

async function createSeriesConnection (config: { databasePG?: unknown; [k: string]: unknown }): Promise<SeriesConnection> {
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
  const connection = {
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.user,
    password: pgConfig.password,
    // the audit pools are limited like the main one (request-serving only)
    statementTimeoutMs: pgConfig.statementTimeoutMs,
    idleInTransactionTimeoutMs: pgConfig.idleInTransactionTimeoutMs
  };
  const auditDb = new DatabasePG({ ...connection, max: pgConfig.auditPoolSize || 5 });
  // ⚑ A SECOND pool, for streamed audit reads only.
  //
  // A streamed read holds its connection for as long as the HTTP client takes
  // to drain the response, and there is no server-side response timeout, so a
  // slow or hostile reader holds one for as long as it likes. Every access gets
  // read permission on its own audit trail by default, so any app token can
  // open such a read. On a single pool, enough of them queue the audit WRITE of
  // every request behind them, and a queued write is dropped after the
  // connection timeout: a handful of readers could silence the audit trail of a
  // whole core. Two pools make the worst case "readers starve readers", which
  // is a cost to the reader rather than a hole in the record.
  const auditReadDb = new DatabasePG({ ...connection, max: pgConfig.auditReadPoolSize || 5 });
  // The base storage registers its connection before the audit storage is
  // created; the users index is in the same database.
  return new AuditStoragePG(auditDb, auditReadDb, { seesUsersIndex: _internals.databasePG != null });
}

// -- FileStorage (PostgreSQL) -------------------------------------------

async function createFileStorage (): Promise<unknown> {
  const { EventPGFiles } = require('./EventPGFiles.ts');
  return new EventPGFiles();
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

/** Access tokens and session ids at rest: see `tokensAtRest.ts`. */
function getTokensAtRest (): unknown {
  return require('./tokensAtRest.ts');
}

/** The audit copies of the access hash removed (see `auditAccessIntegrityScrub.ts`); run when this engine holds the audit. */
async function scrubAccessAuditIntegrity (options: { force?: boolean; auditStorage?: unknown } = {}): Promise<unknown> {
  return await require('./auditAccessIntegrityScrub.ts').scrubAccessAuditIntegrity(options);
}

export {
  getTokensAtRest,
  scrubAccessAuditIntegrity,
  init,
  initStorageLayer,
  getUserAccountStorage,
  getUsersLocalIndex,
  getExternalIdsLocal,
  getDeletionNoticesLocal,
  getErasuresLocal,
  getDataStoreModule,
  createPlatformDB,
  createSeriesConnection,
  createAuditStorage,
  createFileStorage,
  getMigrationsCapability,
  reconcileContentIndexes
};
