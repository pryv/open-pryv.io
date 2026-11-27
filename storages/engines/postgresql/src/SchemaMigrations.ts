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
interface LockClient { query: LockQueryFn; release: (err?: Error) => void }
/** The part of DatabasePG the lock uses: one dedicated client from its pool. */
interface LockDb { getClient: () => Promise<LockClient> }
interface LockLog { info?: (msg: string) => void }

// Advisory-lock key of the migration runner ('prtm' in hex). Distinct from
// the schema DDL key (a booting process must not wait for a migration) and
// from the keys migrations take for themselves.
const MIGRATIONS_LOCK_KEY = 0x7072746d;
const LOCK_POLL_MS = 500;

/**
 * Run `fn` holding the migration runner's advisory lock, on a client of its
 * own kept for the whole run (a session lock: it is released by the unlock,
 * or by the connection closing if the process dies). The client stays idle
 * while `fn` runs, so it never holds a snapshot.
 *
 * The lock is polled with `pg_try_advisory_lock`, never waited on with
 * `pg_advisory_lock`: a statement waiting for the lock holds a snapshot, and a
 * migration building an index CONCURRENTLY under the lock waits for every
 * older snapshot, a deadlock PostgreSQL breaks by failing one of them.
 */
async function withMigrationsLock<T> (db: LockDb, fn: () => Promise<T>, log: LockLog = {}): Promise<T> {
  const client = await db.getClient();
  let broken = false;
  try {
    let said = false;
    for (;;) {
      const res = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATIONS_LOCK_KEY]);
      if (res.rows[0]?.locked === true) break;
      if (!said) {
        log.info?.('[migrations] postgresql: another process is applying migrations; waiting for it');
        said = true;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      // A client whose unlock fails is discarded: closing its connection
      // releases the lock anyway.
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_KEY]);
      } catch (unlockErr) {
        broken = true;
      }
    }
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    client.release(broken ? new Error('migrations lock: run or unlock failed; discarding client') : undefined);
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

export { SchemaMigrationsPG, buildMigrationsCapability, withMigrationsLock, MIGRATIONS_LOCK_KEY };
