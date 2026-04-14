/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * rqlite `schema_migrations` facade for the engine-agnostic migration runner
 * (see `storages/interfaces/migrations/`).
 *
 * Tracks a single JSON value in the existing `keyValue` table:
 *   key:   'migrations/version'
 *   value: { "version": N, "updated_at": <ISO timestamp> }
 *
 * The row is upserted on each bump; Raft serializes writes so the first core
 * to bump wins and followers observe the new value on their next read.
 */

const KEY = 'migrations/version';

class SchemaMigrationsRqlite {
  /** @param {import('./DBrqlite')} db */
  constructor (db) {
    this.db = db;
  }

  async getVersion () {
    const rows = await this.db.query('SELECT value FROM keyValue WHERE key = ?', [KEY]);
    if (rows.length === 0) return 0;
    try {
      const parsed = JSON.parse(rows[0].value);
      return typeof parsed.version === 'number' ? parsed.version : 0;
    } catch (_) {
      return 0;
    }
  }

  async setVersion (version) {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`schema_migrations version must be a positive integer, got ${version}`);
    }
    const value = JSON.stringify({ version, updated_at: new Date().toISOString() });
    await this.db.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [KEY, value]
    );
  }

  /** For tests — drop the tracking row. */
  async _resetForTests () {
    await this.db.execute('DELETE FROM keyValue WHERE key = ?', [KEY]);
  }
}

const noopLogger = { debug () {}, info () {}, warn () {}, error () {} };

/**
 * Build the capability object the MigrationRunner consumes.
 *
 * @param {import('./DBrqlite')} db - DBrqlite instance (already initialized)
 * @param {Function} [getLogger] - logger factory (name → logger)
 * @returns {import('../../../interfaces/migrations/MigrationRunner').MigrationCapableEngine}
 */
function buildMigrationsCapability (db, getLogger) {
  const path = require('path');
  if (!db) throw new Error('rqlite engine: db argument required to build migrations capability');
  const store = new SchemaMigrationsRqlite(db);
  return {
    id: 'rqlite',
    migrationsDir: path.resolve(__dirname, '..', 'migrations'),
    getVersion: () => store.getVersion(),
    setVersion: (v) => store.setVersion(v),
    buildContext: () => ({ db, logger: getLogger ? getLogger('migrations-rqlite') : noopLogger })
  };
}

module.exports = { SchemaMigrationsRqlite, buildMigrationsCapability };
