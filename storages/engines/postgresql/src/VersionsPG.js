/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const timestamp = require('unix-timestamp');
const _internals = require('./_internals');

/**
 * PostgreSQL implementation of Versions storage.
 * Async/Promise API matching the MongoDB Versions interface.
 */
class VersionsPG {
  /** @type {import('./DatabasePG')} */
  db;
  migrations;
  logger;

  constructor (db, logger, migrationsOverride) {
    this.db = db;
    this.migrations = migrationsOverride || _internals.migrations;
    this.logger = logger;
  }

  /**
   * Get the most recently completed version record.
   * @returns {Promise<Object|undefined>}
   */
  async getCurrent () {
    const res = await this.db.query(
      'SELECT id, migration_started, migration_completed, initial_install FROM versions ORDER BY migration_completed DESC NULLS LAST LIMIT 1'
    );
    if (res.rows.length === 0) return undefined;
    return rowToDoc(res.rows[0]);
  }

  /**
   * Run pending migrations if needed.
   * On new install, initializes to the package version.
   */
  async migrateIfNeeded () {
    const v = await this.getCurrent();
    let currentVNum = v?._id;

    if (!v) {
      // New install: init to package version
      currentVNum = _internals.softwareVersion;
      await this.db.query(
        'INSERT INTO versions (id, initial_install) VALUES ($1, $2)',
        [currentVNum, timestamp.now()]
      );
    }

    const migrationsToRun = Object.keys(this.migrations)
      .filter((vNum) => vNum > currentVNum)
      .sort();

    const context = new (_internals.MigrationContext)({
      database: this.db,
      logger: this.logger
    });

    for (const vNum of migrationsToRun) {
      await this.db.query(
        'INSERT INTO versions (id, migration_started) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET migration_started = $2',
        [vNum, timestamp.now()]
      );
      await new Promise((resolve, reject) => {
        this.migrations[vNum](context, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      await this.db.query(
        'UPDATE versions SET migration_completed = $1 WHERE id = $2',
        [timestamp.now(), vNum]
      );
    }
  }

  /**
   * For tests only.
   */
  async removeAll () {
    await this.db.query('DELETE FROM versions');
  }

  // -- Migration methods --

  async exportAll () {
    const res = await this.db.query(
      'SELECT id, migration_started, migration_completed, initial_install FROM versions'
    );
    return res.rows.map(rowToDoc);
  }

  async importAll (data) {
    if (!data || data.length === 0) return;
    for (const d of data) {
      const id = d._id || d.id;
      await this.db.query(
        'INSERT INTO versions (id, migration_started, migration_completed, initial_install) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
        [id, d.migrationStarted || d.migration_started, d.migrationCompleted || d.migration_completed, d.initialInstall || d.initial_install]
      );
    }
  }
}

/**
 * Convert a PG row to the document format expected by callers.
 */
function rowToDoc (row) {
  return {
    _id: row.id,
    migrationStarted: row.migration_started,
    migrationCompleted: row.migration_completed,
    initialInstall: row.initial_install
  };
}

module.exports = VersionsPG;
