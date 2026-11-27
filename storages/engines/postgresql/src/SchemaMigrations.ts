/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL `schema_migrations` facade for the engine-agnostic migration
 * runner (see `storages/interfaces/migrations/`).
 *
 * Layout:
 *   CREATE TABLE schema_migrations (
 *     version INTEGER PRIMARY KEY,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *   )
 *
 * Current version = MAX(version); 0 when the table is empty. One row per
 * applied migration so we keep a minimal history (insert on each bump, no
 * delete).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { _internals } = require('./_internals.ts');
const { acquireAdvisoryLock, releaseAdvisoryLock } = require('./advisoryLock.ts');

type PgDbLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ v?: number }> }> };

class SchemaMigrationsPG {
  db: PgDbLike;

  constructor (db: PgDbLike) {
    this.db = db;
  }

  async _ensureTable (): Promise<void> {
    // Idempotent — always re-issue CREATE TABLE IF NOT EXISTS instead of
    // caching on `this._ensured`. The cache used to cause test crashes when
    // `afterEach` dropped the table via a fresh SchemaMigrationsPG instance
    // while a long-lived capability-closure instance still had `_ensured=true`
    // and skipped the recreate on the next test.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async getVersion (): Promise<number> {
    await this._ensureTable();
    const res = await this.db.query('SELECT MAX(version) AS v FROM schema_migrations');
    return res.rows[0]?.v ?? 0;
  }

  async setVersion (version: number): Promise<void> {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`schema_migrations version must be a positive integer, got ${version}`);
    }
    await this._ensureTable();
    await this.db.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [version]
    );
  }

  async _resetForTests (): Promise<void> {
    await this.db.query('DROP TABLE IF EXISTS schema_migrations');
  }
}

type LockQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
interface LockClient { query: LockQueryFn; end: () => Promise<void> }
/** The part of DatabasePG the lock uses: a connection outside its pools. */
interface LockDb { connectDedicated: (applicationName: string, onLost?: (err: Error) => void) => Promise<LockClient> }
interface LockLog { info?: (msg: string) => void; warn?: (msg: string) => void }
interface LockOptions { pollMs?: number; waitLogEveryMs?: number; heartbeatMs?: number }

// Advisory-lock key of the migration runner ('prtm' in hex). Distinct from
// the schema DDL key (a booting process must not wait for a migration) and
// from the keys migrations take for themselves.
const MIGRATIONS_LOCK_KEY = 0x7072746d;
const LOCK_LABEL = '[migrations] postgresql';
/** Shown in `pg_stat_activity` (and in the waiting runner's log line). */
const LOCK_APPLICATION_NAME = 'open-pryv.io migrations';
// While `fn` runs the lock connection is idle: a short statement now and then
// keeps a server `idle_session_timeout` or an idle-flow firewall from closing
// it, and turns a lost connection into a warning early.
const HEARTBEAT_MS = 30_000;

/**
 * Run `fn` holding the migration runner's advisory lock, on a connection of
 * its own outside the pools (a small pool `max` cannot starve the run), kept
 * for the whole run and ended afterwards: a session lock, released by the
 * unlock, or by the connection closing if the process dies. The connection
 * stays idle while `fn` runs (bar the heartbeat), so it holds no snapshot. The
 * lock is polled (see `advisoryLock.ts`), with no maximum wait.
 *
 * A lock that did not do its job is said: the connection lost during the run,
 * or an unlock finding the lock no longer held, logs a warning (another
 * runner may have applied the same migrations at the same time).
 */
async function withMigrationsLock<T> (db: LockDb, fn: () => Promise<T>, log: LockLog = {}, opts: LockOptions = {}): Promise<T> {
  let lost = false;
  let held = false;
  const client = await db.connectDedicated(LOCK_APPLICATION_NAME, (err) => {
    if (lost) return;
    lost = true;
    // Before the lock is held the next poll fails and the run with it.
    if (held) {
      log.warn?.(`${LOCK_LABEL}: the migrations lock connection was lost (${err.message}); ` +
        'another process may now apply migrations at the same time');
    }
  });
  try {
    await acquireAdvisoryLock(client, MIGRATIONS_LOCK_KEY, log, {
      label: LOCK_LABEL, holderDoing: 'applying migrations', pollMs: opts.pollMs, waitLogEveryMs: opts.waitLogEveryMs
    });
    held = true;
    const heartbeat = setInterval(() => { client.query('SELECT 1').catch(() => {}); }, opts.heartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      // Lost: said already, and the lock went with the connection. A failed
      // release is said once too (a later 'error' adds nothing).
      if (!lost && !(await releaseAdvisoryLock(client, MIGRATIONS_LOCK_KEY, log, LOCK_LABEL))) lost = true;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Build the capability object the MigrationRunner consumes, on `db` (the
 * engine's registered DatabasePG by default).
 */
function buildMigrationsCapability (db: unknown = _internals.databasePG): unknown {
  const path = require('path');
  if (!db) throw new Error('PostgreSQL engine: databasePG not registered — cannot build migrations capability');
  const store = new SchemaMigrationsPG(db as PgDbLike);
  const getLogger = _internals.getLogger || (() => ({ debug () {}, info () {}, warn () {}, error () {} }));
  return {
    id: 'postgresql',
    migrationsDir: path.resolve(__dirname, '..', 'migrations'),
    getVersion: () => store.getVersion(),
    setVersion: (v: number) => store.setVersion(v),
    buildContext: () => ({ db, logger: getLogger('migrations-postgresql') }),
    withLock: <T>(fn: () => Promise<T>): Promise<T> => withMigrationsLock(db as LockDb, fn, getLogger('migrations-postgresql'))
  };
}

export { SchemaMigrationsPG, buildMigrationsCapability, withMigrationsLock, MIGRATIONS_LOCK_KEY, LOCK_APPLICATION_NAME };
