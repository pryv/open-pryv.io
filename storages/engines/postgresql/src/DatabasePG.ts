/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { Pool } = require('pg');
const { setTimeout } = require('timers/promises');
const { _internals } = require('./_internals.ts');
const Cursor = require('pg-cursor');

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

interface PgCursor {
  read: (rowCount: number) => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
}

// A pooled client viewed through the cursor API: pg's client.query(cursor)
// returns the cursor object rather than a result promise.
interface CursorClient {
  query: (cursor: unknown) => PgCursor;
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
}

interface PgSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  max?: number;
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
}

import type { Logger } from '@pryv/boiler';

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
    this.pool = null;
    this.connected = false;
    this._connectingPromise = null;
    this._schemaReady = false;
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
    return this.pool!.query(text, params);
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
   */
  async * queryIterable (text: string, params: unknown[] = [], batchSize: number = 1000): AsyncGenerator<Record<string, unknown>> {
    await this.ensureConnect();
    this.logger.debug('Query (cursor):', text.replace(/\s+/g, ' ').trim());
    const client = await this.pool!.connect();

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

    let cursor: PgCursor;
    try {
      // Inside the try: if opening the cursor throws, the client must still go
      // back, and it is the cursor that is suspect, not the consumer.
      cursor = (client as unknown as CursorClient).query(new Cursor(text, params));
    } catch (err) {
      client.removeListener('error', swallowClientError);
      client.release(err);
      throw err;
    }

    let cursorFailed = false;
    try {
      for (;;) {
        let rows: Array<Record<string, unknown>>;
        try {
          rows = await cursor.read(batchSize);
        } catch (err) {
          // Only a read failure means the connection is in an unknown state.
          cursorFailed = true;
          throw err;
        }
        if (rows.length === 0) break;
        // Deliberately NOT `yield * rows`. Delegating to the array's iterator
        // parks the generator inside that delegation, and an array iterator has
        // no `throw` method — so a consumer abort (which arrives as
        // `iterator.throw`) is converted into a TypeError instead of the real
        // error. Yielding row by row keeps the generator suspended at its OWN
        // yield, so the abort lands in the try/finally below unchanged.
        for (const row of rows) yield row;
      }
    } finally {
      // ⚑ Only close the portal on a connection that can still answer.
      // `cursor.close()` waits for a `readyForQuery` that a dead backend will
      // never send, so closing on a lost connection never settles: the release
      // below would never run (pool slot gone until restart) and the generator
      // would never finish, so `Readable.from`'s destroy never completes and
      // the response chain never settles either. A discarded client has no
      // portal worth closing anyway.
      //
      // Two ways to know it is not worth trying: `cursor.read` threw
      // (`cursorFailed`), or the client reported the loss to our listener while
      // the generator was parked at a yield (`connectionLost`) — the second is
      // the path an aborting consumer takes, where nothing was mid-read. The
      // race covers the remainder, a backend that dies during an otherwise
      // healthy close's round trip.
      if (!cursorFailed && !connectionLost) {
        try { await Promise.race([cursor.close(), lost]); } catch (e) { /* best-effort cursor cleanup */ }
      }
      client.removeListener('error', swallowClientError);
      // Re-read `connectionLost`: the race above exists precisely because it can
      // become true while we are waiting on the close.
      client.release(cursorFailed || connectionLost
        ? new Error('queryIterable: connection lost or cursor read failed; discarding client')
        : undefined);
    }
  }

  /**
   * Get a client from the pool for use in transactions.
   */
  async getClient (): Promise<PgClient> {
    await this.ensureConnect();
    return this.pool!.connect();
  }

  /**
   * Run a function inside a transaction.
   */
  async withTransaction<T> (fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
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
    const client = await this.pool!.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_INIT_LOCK_KEY]);
      try {
        await client.query(SCHEMA_SQL);
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
   * Close the pool.
   */
  async close (): Promise<void> {
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

const SCHEMA_SQL = `
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
CREATE INDEX IF NOT EXISTS idx_event_time ON events(user_id, time);
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
  PRIMARY KEY (user_id, id)
);
-- Index predicates intentionally omit head_id here. SCHEMA_SQL is a
-- no-op on existing installs (table already exists without head_id),
-- so the matching migration 20260512_132200_access_versioning.js does
-- the ALTER + index recreate. Fresh installs converge once that
-- migration runs at boot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_token
  ON accesses(user_id, token) WHERE deleted IS NULL;
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

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data JSONB,
  expires TIMESTAMPTZ
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
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(user_id, time);
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
`;

export { DatabasePG };