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

const _internals = require('./_internals');

class SchemaMigrationsPG {
  /** @param {import('./DatabasePG')} db */
  constructor (db) {
    this.db = db;
  }

  async _ensureTable () {
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

  async getVersion () {
    await this._ensureTable();
    const res = await this.db.query('SELECT MAX(version) AS v FROM schema_migrations');
    return res.rows[0]?.v ?? 0;
  }

  async setVersion (version) {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`schema_migrations version must be a positive integer, got ${version}`);
    }
    await this._ensureTable();
    await this.db.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [version]
    );
  }

  /** For tests — wipe the table. Next getVersion/setVersion call will recreate it. */
  async _resetForTests () {
    await this.db.query('DROP TABLE IF EXISTS schema_migrations');
  }
}

/**
 * Build the capability object the MigrationRunner consumes.
 * Must be called after the engine has been initialized and `databasePG` is
 * registered in `_internals`.
 * @returns {import('../../../interfaces/migrations/MigrationRunner').MigrationCapableEngine}
 */
function buildMigrationsCapability () {
  const path = require('path');
  const db = _internals.databasePG;
  if (!db) throw new Error('PostgreSQL engine: databasePG not registered — cannot build migrations capability');
  const store = new SchemaMigrationsPG(db);
  const getLogger = _internals.getLogger || (() => ({ debug () {}, info () {}, warn () {}, error () {} }));
  return {
    id: 'postgresql',
    migrationsDir: path.resolve(__dirname, '..', 'migrations'),
    getVersion: () => store.getVersion(),
    setVersion: (v) => store.setVersion(v),
    buildContext: () => ({ db, logger: getLogger('migrations-postgresql') })
  };
}

module.exports = { SchemaMigrationsPG, buildMigrationsCapability };
