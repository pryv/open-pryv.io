/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const { Pool } = require('pg');
const { setTimeout } = require('timers/promises');
const _internals = require('./_internals');

/**
 * PostgreSQL connection wrapper with pooling.
 */
class DatabasePG {
  pool: any;
  poolConfig: any;
  connected: boolean;
  logger: any;
  _connectingPromise: Promise<void> | null;
  _schemaReady: boolean;

  constructor (settings: any) {
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
      this.pool.on('error', (err: any) => {
        this.logger.error('Unexpected PG pool error', err);
      });
    }

    const client = await this.pool.connect();
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
  async query (text: string, params?: any[]): Promise<any> {
    await this.ensureConnect();
    this.logger.debug('Query:', text.replace(/\s+/g, ' ').trim());
    return this.pool.query(text, params);
  }

  /**
   * Get a client from the pool for use in transactions.
   */
  async getClient (): Promise<any> {
    await this.ensureConnect();
    return this.pool.connect();
  }

  /**
   * Run a function inside a transaction.
   */
  async withTransaction<T> (fn: (client: any) => Promise<T>): Promise<T> {
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
   */
  async _initSchemaOnce (): Promise<void> {
    if (this._schemaReady) return;
    await this.pool.query(SCHEMA_SQL);
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
  static isDuplicateError (err: any): boolean {
    return err && err.code === '23505';
  }

  /**
   * Attach duplicate-error helpers to a PG error.
   */
  static handleDuplicateError (err: any): void {
    err.isDuplicate = DatabasePG.isDuplicateError(err);
    err.isDuplicateIndex = (key: string): boolean => {
      if (!err.isDuplicate) return false;
      return err.constraint ? err.constraint.toLowerCase().includes(key.toLowerCase()) : false;
    };
  }
}

// ---------- Schema DDL ----------

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
  modified DOUBLE PRECISION,
  modified_by TEXT,
  deleted DOUBLE PRECISION,
  PRIMARY KEY (user_id, id)
);
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

-- Platform DB

CREATE TABLE IF NOT EXISTS platform_unique_fields (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  username TEXT NOT NULL,
  UNIQUE (field, value)
);

CREATE TABLE IF NOT EXISTS platform_indexed_fields (
  username TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (username, field)
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
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(user_id, time);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(user_id, type);
CREATE INDEX IF NOT EXISTS idx_audit_deleted ON audit_events(user_id, deleted) WHERE deleted IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_head_id ON audit_events(user_id, head_id) WHERE head_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_created_by ON audit_events(user_id, created_by);
`;

module.exports = DatabasePG;
