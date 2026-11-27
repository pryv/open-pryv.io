/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';

import type { Logger } from '@pryv/boiler';
import { installUnindexedWritesGuard } from './unindexedWritesGuard.ts';
const require = createRequire(import.meta.url);

const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, Client } = require('pg');
const { setTimeout } = require('timers/promises');
const { _internals } = require('./_internals.ts');
const { isRequestServingProcess } = require('utils');

/**
 * Set while `runMaintenance(fn)` runs: every DatabasePG then serves `fn`'s
 * statements from its maintenance pool, which carries no time limit.
 */
const maintenanceScope = new AsyncLocalStorage();

/** Connections of the maintenance pool, per DatabasePG (internal constant). */
const MAINTENANCE_POOL_MAX = 2;

// Tests only: forces the request-serving role on (true) or follows the
// process role (null). Read when a DatabasePG is constructed.
let requestServingOverride: boolean | null = null;

/**
 * Run `fn` with every statement it issues, on any DatabasePG, taken from the
 * unlimited maintenance pool: long legitimate work inside a request-serving
 * process (account erasure, background jobs, boot DDL). Outside such a process
 * the pools are unlimited already and this only runs `fn`.
 */
function runMaintenance<T> (fn: () => Promise<T>): Promise<T> {
  return maintenanceScope.run(true, fn);
}

/** Whether the current call runs inside `runMaintenance`. */
function isInMaintenance (): boolean {
  return maintenanceScope.getStore() === true;
}

/** Tests only: see `requestServingOverride`. */
function setRequestServingForTests (value: boolean | null): void {
  requestServingOverride = value;
}

/** A statement cancelled by `statement_timeout` (SQLSTATE 57014). */
const STATEMENT_CANCELLED = '57014';
/** How much of a cancelled statement's text is kept for the log line. */
const STATEMENT_TEXT_MAX = 200;

/**
 * Tag a cancelled statement's error with its text (truncated, never its
 * parameters), so the single place mapping it to an API answer can log it.
 */
function tagCancelled (err: unknown, text: string): void {
  if (err != null && typeof err === 'object' && (err as PgError).code === STATEMENT_CANCELLED) {
    (err as PgError).statementText = text.replace(/\s+/g, ' ').trim().slice(0, STATEMENT_TEXT_MAX);
  }
}

/** Every cursor name in this process is distinct (one transaction holds one). */
let cursorSeq = 0;

interface PgClient {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  // An argument marks the client as broken so the pool discards it instead of
  // returning it to the idle set. queryIterable passes one only for a cursor
  // failure, never for a consumer that walked away.
  release: (err?: unknown) => void;
  // A checked-out client emits 'error' when its backend goes away, and the pool
  // removes its OWN listener while the client is out. A holder that keeps the
  // client for more than a moment has to listen, or the emit is an unhandled
  // 'error' event that ends the process.
  on: (event: string, handler: (err: Error) => void) => void;
  removeListener: (event: string, handler: (err: Error) => void) => void;
}

/** A connection outside the pools (see `connectDedicated`); the caller ends it. */
interface PgDedicatedClient {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  end: () => Promise<void>;
}

interface PgPool {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  connect: () => Promise<PgClient>;
  on: (event: string, handler: (err: Error) => void) => void;
  end: () => Promise<void>;
  // Live pool counters. Checked-out clients are `totalCount - idleCount`, which
  // is how a leaked cursor client is observed; `waitingCount` above zero means
  // callers are already queued behind an exhausted pool.
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
  [k: string]: unknown;
}

interface PgError extends Error {
  code?: string;
  constraint?: string;
  isDuplicate?: boolean;
  isDuplicateIndex?: (key: string) => boolean;
  statementText?: string;
}

interface PgSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  max?: number;
  // Applied only in a request-serving process; 0 or absent: no limit.
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

interface PoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | undefined;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  // Sent by pg as connection parameters; absent when off.
  statement_timeout?: number;
  idle_in_transaction_session_timeout?: number;
}

/**
 * PostgreSQL connection wrapper with pooling.
 */
class DatabasePG {
  // Set by init() / ensureConnected() before queries — `!` uses rely on it.
  pool: PgPool | null;
  poolConfig: PoolConfig;
  connected: boolean;
  logger: Logger;
  _connectingPromise: Promise<void> | null;
  _schemaReady: boolean;
  // True when the main pool carries a time limit: the maintenance pool is
  // then a distinct, unlimited one.
  limited: boolean;
  _maintenancePool: PgPool | null;

  constructor (settings: PgSettings) {
    this.logger = _internals.getLogger('database-pg');
    this.poolConfig = {
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      password: settings.password || undefined,
      max: settings.max || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 60000
    };
    // The limits protect request handling only: the master, the command-line
    // tools and the single-process entry points stay unlimited by construction.
    const requestServing = requestServingOverride ?? isRequestServingProcess();
    const statementTimeoutMs = requestServing ? (settings.statementTimeoutMs || 0) : 0;
    const idleInTransactionTimeoutMs = requestServing ? (settings.idleInTransactionTimeoutMs || 0) : 0;
    if (statementTimeoutMs > 0) this.poolConfig.statement_timeout = statementTimeoutMs;
    if (idleInTransactionTimeoutMs > 0) this.poolConfig.idle_in_transaction_session_timeout = idleInTransactionTimeoutMs;
    this.limited = statementTimeoutMs > 0 || idleInTransactionTimeoutMs > 0;
    this.pool = null;
    this._maintenancePool = null;
    this.connected = false;
    this._connectingPromise = null;
    this._schemaReady = false;
  }

  /**
   * The pool serving a call made now: the maintenance pool inside
   * `runMaintenance` (when the main pool is limited), else the main pool.
   */
  _poolForCall (): PgPool {
    if (this.limited && isInMaintenance()) return this._maintenance();
    return this.pool!;
  }

  /** The unlimited maintenance pool, created on first use. */
  _maintenance (): PgPool {
    if (!this.limited) return this.pool!;
    if (this._maintenancePool == null) {
      const { statement_timeout: _s, idle_in_transaction_session_timeout: _i, ...unlimited } = this.poolConfig;
      this._maintenancePool = new Pool({ ...unlimited, max: MAINTENANCE_POOL_MAX });
      this._maintenancePool!.on('error', (err: Error) => {
        this.logger.error('Unexpected PG maintenance pool error', err);
      });
    }
    return this._maintenancePool!;
  }

  /**
   * A checked-out client listens for its own 'error' (the pool removes its
   * listener while the client is out, and an unhandled 'error' ends the
   * process: a terminated idle transaction is one way to get there). The
   * release then discards a client whose connection was lost.
   */
  _guardClient (client: PgClient): PgClient {
    let lost = false;
    const onError = (err: Error): void => {
      lost = true;
      this.logger.warn('PostgreSQL connection lost while checked out: ' + err.message);
    };
    client.on('error', onError);
    // For the hold, a statement stopped by the time limit keeps its text for
    // the log line, as on the pool's own queries. Restored at release, so a
    // reused client never stacks wrappers.
    const clientQuery = client.query;
    client.query = async (text: string, params?: unknown[]): Promise<PgQueryResult> => {
      try {
        return await clientQuery.call(client, text, params);
      } catch (err) {
        if (typeof text === 'string') tagCancelled(err, text);
        throw err;
      }
    };
    const poolRelease = client.release;
    client.release = (err?: unknown): void => {
      client.removeListener('error', onError);
      client.query = clientQuery;
      poolRelease(err ?? (lost ? new Error('PostgreSQL connection lost while checked out; discarding client') : undefined));
    };
    return client;
  }

  /**
   * Ensure the pool is created and a test query succeeds.
   */
  async ensureConnect (): Promise<void> {
    if (this.connected) return;
    // Serialize: if another caller is already connecting, await same promise
    if (this._connectingPromise) return this._connectingPromise;
    this._connectingPromise = this._doConnect();
    try {
      await this._connectingPromise;
    } finally {
      this._connectingPromise = null;
    }
  }

  /** @private */
  async _doConnect (): Promise<void> {
    if (this.connected) return;

    if (!this.pool) {
      this.pool = new Pool(this.poolConfig);
      this.pool!.on('error', (err: Error) => {
        this.logger.error('Unexpected PG pool error', err);
      });
    }

    const client = await this.pool!.connect();
    try {
      await client.query('SELECT 1');
      this.logger.debug(`Connected to PostgreSQL at ${this.poolConfig.host}:${this.poolConfig.port}/${this.poolConfig.database}`);
    } finally {
      client.release();
    }

    await this._initSchemaOnce();
    this.connected = true;
  }

  /**
   * Wait until PG is up. For use at startup.
   */
  async waitForConnection (): Promise<void> {
    while (!this.connected) {
      try {
        await this.ensureConnect();
      } catch (err) {
        this.logger.warn(`Cannot connect to PostgreSQL at ${this.poolConfig.host}:${this.poolConfig.port}, retrying in a sec`);
        await setTimeout(1000);
      }
    }
  }

  /**
   * Execute a parameterised query.
   */
  async query (text: string, params?: unknown[]): Promise<PgQueryResult> {
    await this.ensureConnect();
    this.logger.debug('Query:', text.replace(/\s+/g, ' ').trim());
    try {
      return await this._poolForCall().query(text, params);
    } catch (err) {
      tagCancelled(err, text);
      throw err;
    }
  }

  /**
   * Stream a query's rows through a server-side cursor, a batch at a time, so
   * memory is the batch rather than the whole result set.
   *
   * ⚑ The generator OWNS a pooled client for as long as it is alive. The caller
   * must guarantee the generator is closed — `for await` and `Readable.from`
   * both do, the latter only if whatever consumes the readable propagates
   * destroy to it. Abandon it and the client is never returned.
   *
   * On the way out the client is released clean unless the CURSOR itself
   * failed. A consumer that stops early — an aborted HTTP response injects its
   * error at the `yield` — leaves a perfectly healthy connection, and
   * discarding it would make a burst of aborts churn the pool instead of
   * leaking it: better than a leak, still wrong.
   *
   * The cursor is DECLAREd in a transaction and read with one FETCH per batch,
   * so a statement time limit bounds each batch, not the whole stream (a
   * protocol-level portal keeps one statement running from the first row to
   * the last, consumer's drain time included). Both settings are local to the
   * transaction: a reader slower than the idle-in-transaction limit between
   * two batches is not cut, and the cursor is planned for the whole result,
   * like the query it replaces.
   */
  async * queryIterable (text: string, params: unknown[] = [], batchSize: number = 1000): AsyncGenerator<Record<string, unknown>> {
    await this.ensureConnect();
    this.logger.debug('Query (cursor):', text.replace(/\s+/g, ' ').trim());
    const client = await this._poolForCall().connect();

    // ⚑ The pool removes its own idle `'error'` listener when it hands a client
    // out and re-attaches it on release. For the millisecond-long holds
    // elsewhere in this file that gap is theoretical; here the client is held
    // for the whole response, so a backend that goes away mid-read (restart,
    // failover, `pg_terminate_backend`) emits `'error'` on a client nobody
    // listens to, which is an unhandled `'error'` event and takes the process
    // down. There is no process-level handler to catch it.
    //
    // The listener is also how we LEARN the connection died. `cursor.read` only
    // reports a loss to a caller that is mid-read; a consumer that aborts while
    // the generator is parked at a `yield` would otherwise reach the `finally`
    // believing the connection is healthy and wait on a close that can never
    // complete. `connectionLost` records what the listener saw, and `lost`
    // lets the close race it.
    let connectionLost = false;
    let markLost: () => void;
    const lost = new Promise<void>((resolve) => { markLost = resolve; });
    const swallowClientError = (): void => {
      connectionLost = true;
      markLost();
    };
    client.on('error', swallowClientError);

    const cursorName = 'pryv_cursor_' + (++cursorSeq);
    const rowsPerFetch = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : 1000;
    const fetchSql = `FETCH ${rowsPerFetch} FROM ${cursorName}`;
    // Set by any failure of the transaction's own statements (BEGIN, DECLARE,
    // FETCH): the connection is then in an unknown state and is discarded,
    // which also ends the transaction server-side.
    let cursorFailed = false;
    let completed = false;
    try {
      try {
        await client.query('BEGIN; SET LOCAL idle_in_transaction_session_timeout = 0; SET LOCAL cursor_tuple_fraction = 1');
        await client.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${text}`, params);
      } catch (err) {
        cursorFailed = true;
        tagCancelled(err, text);
        throw err;
      }
      for (;;) {
        let rows: Array<Record<string, unknown>>;
        try {
          rows = (await client.query(fetchSql)).rows;
        } catch (err) {
          // Only a statement failure means the connection is in an unknown state.
          cursorFailed = true;
          tagCancelled(err, text);
          throw err;
        }
        if (rows.length === 0) { completed = true; break; }
        // Deliberately NOT `yield * rows`. Delegating to the array's iterator
        // parks the generator inside that delegation, and an array iterator has
        // no `throw` method — so a consumer abort (which arrives as
        // `iterator.throw`) is converted into a TypeError instead of the real
        // error. Yielding row by row keeps the generator suspended at its OWN
        // yield, so the abort lands in the try/finally below unchanged.
        for (const row of rows) yield row;
      }
    } finally {
      // ⚑ Only end the transaction on a connection that can still answer.
      // A statement sent to a dead backend waits for a `readyForQuery` that
      // will never come: the release below would never run (pool slot gone
      // until restart) and the generator would never finish, so
      // `Readable.from`'s destroy never completes and the response chain never
      // settles either. A discarded client has no transaction worth ending.
      //
      // Two ways to know it is not worth trying: a statement of ours failed
      // (`cursorFailed`), or the client reported the loss to our listener while
      // the generator was parked at a yield (`connectionLost`) — the second is
      // the path an aborting consumer takes, where nothing was mid-read. The
      // race covers the remainder, a backend that dies during an otherwise
      // healthy round trip. A consumer that stopped early rolls back (the
      // cursor goes with it); a complete read commits.
      let endFailed = false;
      if (!cursorFailed && !connectionLost) {
        try {
          await Promise.race([client.query(completed ? 'COMMIT' : 'ROLLBACK'), lost]);
        } catch (e) {
          endFailed = true;
        }
      }
      client.removeListener('error', swallowClientError);
      // Re-read `connectionLost`: the race above exists precisely because it can
      // become true while we are waiting on the end of the transaction.
      client.release(cursorFailed || connectionLost || endFailed
        ? new Error('queryIterable: connection lost or cursor statement failed; discarding client')
        : undefined);
    }
  }

  /**
   * Get a client from the pool for use in transactions. The caller releases
   * it; a client whose connection was lost meanwhile is then discarded.
   */
  async getClient (): Promise<PgClient> {
    await this.ensureConnect();
    return this._guardClient(await this._poolForCall().connect());
  }

  /**
   * A connection of its own, outside the pools (their `max` does not count
   * it), with the main pool's settings minus the time limits, TCP keepalive
   * on and `applicationName` shown in `pg_stat_activity`: for a session
   * advisory lock held for a whole run. The caller ends it. A lost connection
   * is logged and reported to `onLost` (an unhandled 'error' would end the
   * process).
   */
  async connectDedicated (applicationName: string, onLost?: (err: Error) => void): Promise<PgDedicatedClient> {
    const { statement_timeout: _s, idle_in_transaction_session_timeout: _i, max: _m, idleTimeoutMillis: _t, ...settings } = this.poolConfig;
    const client = new Client({ ...settings, application_name: applicationName, keepAlive: true });
    client.on('error', (err: Error) => {
      this.logger.warn(`PostgreSQL connection "${applicationName}" lost: ${err.message}`);
      onLost?.(err);
    });
    try {
      await client.connect();
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    return client;
  }

  /**
   * Run a function inside a transaction.
   */
  async withTransaction<T> (fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // Best effort: on a terminated connection the rollback fails too, and
      // must not hide the original cause.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = true;
      }
      throw err;
    } finally {
      client.release(broken ? new Error('withTransaction: rollback failed; discarding client') : undefined);
    }
  }

  /**
   * Initialize the database schema (create tables if not exist).
   */
  async initSchema (): Promise<void> {
    await this.ensureConnect();
    await this._initSchemaOnce();
  }

  /**
   * Run schema DDL once. Idempotent.
   * Serialized across processes with an advisory lock: two servers booting
   * together (e.g. API + HFS) racing "CREATE TABLE IF NOT EXISTS" can make
   * PostgreSQL fail one of them with 23505 on pg_type.
   */
  async _initSchemaOnce (): Promise<void> {
    if (this._schemaReady) return;
    // From the unlimited pool: waiting for the lock is a statement too, and
    // another process may hold it for a long index build.
    const client = this._guardClient(await this._maintenance().connect());
    try {
      await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_INIT_LOCK_KEY]);
      try {
        await client.query(SCHEMA_SQL);
        // Rows of a user id the users index does not hold are refused (see
        // unindexedWritesGuard.ts): after the tables, one table at a time.
        await installUnindexedWritesGuard(client, this.logger);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_INIT_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
    this._schemaReady = true;
    this.logger.info('PostgreSQL schema initialized');
  }

  /**
   * Install or repair the unindexed-user guard (function, triggers, enabled
   * state) under the schema advisory lock, as the boot does; for the
   * migration and for tests.
   * @returns per guarded table, and `users_index` for the removal-lock
   *   trigger: 'present', 'created', 're-enabled' or 'failed'
   */
  async ensureUnindexedWritesGuard (options: { lockTimeoutMs?: number; attempts?: number } = {}): Promise<Record<string, string>> {
    await this.ensureConnect();
    const client = this._guardClient(await this._maintenance().connect());
    try {
      await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_INIT_LOCK_KEY]);
      try {
        return await installUnindexedWritesGuard(client, this.logger, options);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_INIT_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Close the pool.
   */
  async close (): Promise<void> {
    if (this._maintenancePool) {
      await this._maintenancePool.end();
      this._maintenancePool = null;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connected = false;
      this._connectingPromise = null;
      this._schemaReady = false;
    }
  }

  /**
   * Check whether a PG error is a unique-constraint violation.
   */
  static isDuplicateError (err: PgError | null | undefined): boolean {
    return !!(err && err.code === '23505');
  }

  /**
   * Attach duplicate-error helpers to a PG error.
   */
  static handleDuplicateError (err: PgError): void {
    err.isDuplicate = DatabasePG.isDuplicateError(err);
    err.isDuplicateIndex = (key: string): boolean => {
      if (!err.isDuplicate) return false;
      return err.constraint ? err.constraint.toLowerCase().includes(key.toLowerCase()) : false;
    };
  }
}

// ---------- Schema DDL ----------

// Arbitrary application-wide advisory-lock key for schema DDL ('pryv' in hex)
const SCHEMA_INIT_LOCK_KEY = 0x70727976;

/**
 * Turn each `CREATE [UNIQUE] INDEX IF NOT EXISTS name ON ...;` statement (at
 * the start of a line) into one that runs only when no relation of that name
 * exists. `IF NOT EXISTS` looks at the name only after taking a SHARE lock on
 * the table: while another session builds an index of that table
 * CONCURRENTLY (the time sort index migration), that request queues every
 * write to the table behind it, and PostgreSQL then aborts the build as a
 * deadlock (the build waits for the snapshot of this transaction). An index
 * that exists takes no lock at all this way.
 */
function createIndexesOnlyIfMissing (sql: string): string {
  return sql.replace(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+)([^;]*);/gm,
    (_stmt: string, unique: string | undefined, name: string, rest: string) =>
      `DO $$ BEGIN IF to_regclass('${name}') IS NULL THEN CREATE ${unique ?? ''}INDEX ${name}${rest}; END IF; END $$;`);
}

const SCHEMA_SQL = createIndexesOnlyIfMissing(`
-- User-scoped tables

CREATE TABLE IF NOT EXISTS streams (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  parent_id TEXT,
  path TEXT NOT NULL,
  client_data JSONB,
  single_activity BOOLEAN DEFAULT FALSE,
  trashed BOOLEAN DEFAULT FALSE,
  created DOUBLE PRECISION,
  created_by TEXT,
  modified DOUBLE PRECISION,
  modified_by TEXT,
  deleted DOUBLE PRECISION,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_path
  ON streams(user_id, path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_sibling
  ON streams(user_id, name, parent_id) WHERE deleted IS NULL;
CREATE INDEX IF NOT EXISTS idx_stream_parent
  ON streams(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_stream_trashed
  ON streams(user_id, trashed);

CREATE TABLE IF NOT EXISTS events (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  head_id TEXT,
  stream_ids JSONB,
  time DOUBLE PRECISION,
  end_time DOUBLE PRECISION,
  type TEXT,
  tags JSONB,
  content JSONB,
  description TEXT,
  client_data JSONB,
  attachments JSONB,
  integrity TEXT,
  trashed BOOLEAN DEFAULT FALSE,
  created DOUBLE PRECISION,
  created_by TEXT,
  modified DOUBLE PRECISION,
  modified_by TEXT,
  deleted DOUBLE PRECISION,
  PRIMARY KEY (user_id, id)
);
-- Time sorts end with the id (see src/timeIdIndexes.ts): idx_event_time_id
-- serves them. Built here on a database with neither it nor the
-- idx_event_time it replaces (a fresh one); an existing database gets it from
-- the migration 20261127_130000_time_id_indexes.js, built CONCURRENTLY.
DO $$ BEGIN
  IF to_regclass('idx_event_time_id') IS NULL AND to_regclass('idx_event_time') IS NULL THEN
    CREATE INDEX idx_event_time_id ON events(user_id, time, id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_event_type ON events(user_id, type);
CREATE INDEX IF NOT EXISTS idx_event_deleted
  ON events(user_id, deleted) WHERE deleted IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_trashed ON events(user_id, trashed);
CREATE INDEX IF NOT EXISTS idx_event_modified ON events(user_id, modified);
CREATE INDEX IF NOT EXISTS idx_event_head_id ON events(user_id, head_id);
CREATE INDEX IF NOT EXISTS idx_event_endtime ON events(user_id, end_time);

CREATE TABLE IF NOT EXISTS event_streams (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_path TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id, stream_id)
);
CREATE INDEX IF NOT EXISTS idx_es_path
  ON event_streams(user_id, stream_path text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_es_stream
  ON event_streams(user_id, stream_id, event_id);

CREATE TABLE IF NOT EXISTS accesses (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  serial INTEGER,
  head_id TEXT,
  token TEXT,
  name TEXT,
  type TEXT,
  device_name TEXT,
  permissions JSONB,
  client_data JSONB,
  expires DOUBLE PRECISION,
  last_used DOUBLE PRECISION,
  calls JSONB,
  integrity TEXT,
  integrity_batch_code DOUBLE PRECISION,
  created DOUBLE PRECISION,
  created_by TEXT,
  created_by_serial INTEGER,
  modified DOUBLE PRECISION,
  modified_by TEXT,
  modified_by_serial INTEGER,
  deleted DOUBLE PRECISION,
  alias TEXT,
  last_login DOUBLE PRECISION,
  token_hash TEXT,
  token_enc TEXT,
  PRIMARY KEY (user_id, id)
);
-- Index predicates intentionally omit head_id here. SCHEMA_SQL is a
-- no-op on existing installs (table already exists without head_id),
-- so the matching migration 20260512_132200_access_versioning.js does
-- the ALTER + index recreate. Fresh installs converge once that
-- migration runs at boot.
-- The token itself is never stored in clear (\`token\` stays NULL): the
-- unique index on its keyed hash, \`idx_access_token_hash\`, is created by
-- the migration 20261127_120000_access_token_protection_columns.js, on
-- fresh installs too (it needs the columns of existing installs first).
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_name_type_deviceName
  ON accesses(user_id, name, type, device_name) NULLS NOT DISTINCT WHERE deleted IS NULL;

CREATE TABLE IF NOT EXISTS webhooks (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  access_id TEXT,
  url TEXT,
  state TEXT,
  run_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  last_run JSONB,
  runs JSONB,
  current_retries INTEGER DEFAULT 0,
  max_retries INTEGER,
  min_interval_ms INTEGER,
  created DOUBLE PRECISION,
  created_by TEXT,
  modified DOUBLE PRECISION,
  modified_by TEXT,
  deleted DOUBLE PRECISION,
  scopes JSONB,
  secret TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_url
  ON webhooks(user_id, access_id, url) WHERE deleted IS NULL;

CREATE TABLE IF NOT EXISTS profile (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB,
  PRIMARY KEY (user_id, id)
);

-- Global tables

-- \`id\` holds the keyed hash of the session id, \`id_enc\` its encrypted copy.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data JSONB,
  expires TIMESTAMPTZ,
  id_enc TEXT
);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  username TEXT,
  expires TIMESTAMPTZ
);

-- User account storage

CREATE TABLE IF NOT EXISTS passwords (
  user_id TEXT NOT NULL,
  time DOUBLE PRECISION NOT NULL,
  hash TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (user_id, time)
);

CREATE TABLE IF NOT EXISTS store_key_values (
  user_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB,
  PRIMARY KEY (user_id, store_id, key)
);

CREATE TABLE IF NOT EXISTS account_fields (
  user_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value JSONB,
  time DOUBLE PRECISION NOT NULL,
  created_by TEXT,
  PRIMARY KEY (user_id, field, time)
);

-- Users index

CREATE TABLE IF NOT EXISTS users_index (
  username TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL
);

-- Alias index (many aliases : one user). Separate from users_index so the
-- 1:1 username<->user_id mapping (and its integrity check) stays canonical.
CREATE TABLE IF NOT EXISTS alias_index (
  alias TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alias_index_user_id
  ON alias_index(user_id);

-- External ids held by this core's accounts (never replicated). The primary
-- key is the authoritative one-account-per-id check; the unique constraint
-- keeps one id per account per namespace.
CREATE TABLE IF NOT EXISTS external_ids (
  user_id TEXT NOT NULL,
  ns_token TEXT NOT NULL,
  value_token TEXT NOT NULL,
  blinded_value TEXT NOT NULL,
  claimed_at DOUBLE PRECISION NOT NULL,
  CONSTRAINT external_ids_value_pkey PRIMARY KEY (ns_token, value_token),
  CONSTRAINT external_ids_user_ns_key UNIQUE (user_id, ns_token)
);
CREATE INDEX IF NOT EXISTS idx_external_ids_user_id
  ON external_ids(user_id);

-- CMC revoke notices of deleted accounts still to deliver (core-level, never
-- replicated, outside the per-user backup). A delivered row is deleted; a
-- failed-permanent one keeps the endpoint without its token. Times in ms.
CREATE TABLE IF NOT EXISTS cmc_deletion_notices (
  id TEXT PRIMARY KEY,
  deleted_user_id TEXT NOT NULL,
  access_id TEXT,
  api_endpoint TEXT NOT NULL,
  path TEXT NOT NULL,
  body JSONB,
  attempts INTEGER NOT NULL,
  next_attempt_after BIGINT NOT NULL,
  status TEXT NOT NULL,
  last_failure_reason TEXT,
  last_failure_detail JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cmc_deletion_notices_due
  ON cmc_deletion_notices(status, next_attempt_after);

-- Account erasures in progress (core-level, never replicated, outside the
-- per-user backup): written before the first erasure step, removed after the
-- last one; a row left behind is an erasure to complete. Times in ms.
CREATE TABLE IF NOT EXISTS account_erasures (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  trigger TEXT,
  started_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  done_steps JSONB NOT NULL,
  series_namespaces JSONB,
  attempts INTEGER NOT NULL,
  last_error TEXT
);

-- Series data (replaces InfluxDB)

CREATE TABLE IF NOT EXISTS series_data (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  point_time DOUBLE PRECISION NOT NULL,
  delta_time BIGINT NOT NULL,
  fields JSONB NOT NULL,
  PRIMARY KEY (user_id, event_id, point_time)
);
CREATE INDEX IF NOT EXISTS idx_series_time
  ON series_data(user_id, event_id, delta_time);

-- Audit events (replaces per-user SQLite audit databases)

CREATE TABLE IF NOT EXISTS audit_events (
  user_id TEXT NOT NULL,
  eventid TEXT NOT NULL,
  head_id TEXT,
  stream_ids TEXT,
  time DOUBLE PRECISION,
  deleted DOUBLE PRECISION,
  end_time DOUBLE PRECISION,
  type TEXT,
  content JSONB,
  description TEXT,
  client_data JSONB,
  integrity TEXT,
  attachments JSONB,
  trashed BOOLEAN DEFAULT false,
  created DOUBLE PRECISION,
  created_by TEXT,
  modified DOUBLE PRECISION,
  modified_by TEXT,
  PRIMARY KEY (user_id, eventid)
);
-- Same as idx_event_time_id above (migration 20261127_130000_time_id_indexes.js).
DO $$ BEGIN
  IF to_regclass('idx_audit_time_id') IS NULL AND to_regclass('idx_audit_time') IS NULL THEN
    CREATE INDEX idx_audit_time_id ON audit_events(user_id, time, eventid);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(user_id, type);
CREATE INDEX IF NOT EXISTS idx_audit_deleted ON audit_events(user_id, deleted) WHERE deleted IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_head_id ON audit_events(user_id, head_id) WHERE head_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_created_by ON audit_events(user_id, created_by);

-- Event attachment content (storages.file.engine: postgresql) — one row per
-- fixed-size chunk so reads/writes stream without holding whole files in
-- memory. Intended for low attachment volume; see EventPGFiles.ts.

CREATE TABLE IF NOT EXISTS attachment_files (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data BYTEA NOT NULL,
  PRIMARY KEY (user_id, event_id, file_id, seq)
);
`);

export { DatabasePG, runMaintenance, isInMaintenance, setRequestServingForTests, STATEMENT_CANCELLED };
