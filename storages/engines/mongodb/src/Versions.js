/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const bluebird = require('bluebird');
const timestamp = require('unix-timestamp');
const _internals = require('./_internals');

const collectionInfo = {
  name: 'versions',
  indexes: []
};

module.exports = Versions;
/**
 * Handles the DB and files storage version (incl. migrating between versions)
 *
 * Version info is in DB collection `versions`, each record structured as follows:
 *
 *    {
 *      "_id": "{major}.{minor}[.{revision}]
 *      "migrationStarted": "{timestamp}"
 *      "migrationCompleted": "{timestamp}"
 *    }
 *
 * TODO: must be per-user to properly support account relocation
 *
 * @param database
 * @param logging
 * @param migrationsOverride Use for tests
 * @constructor
 */
function Versions (database, logger, migrationsOverride) {
  this.database = database;
  this.migrations = migrationsOverride || _internals.migrations;
  this.logger = logger;
}

Versions.prototype.getCurrent = async function () {
  const version = await bluebird.fromCallback((cb) => {
    this.database.findOne(collectionInfo, {}, { sort: { migrationCompleted: -1 } }, cb);
  });
  return version;
};

Versions.prototype.migrateIfNeeded = async function () {
  const v = await this.getCurrent();
  let currentVNum = v?._id;
  if (!v) {
    // new install: init to package version
    currentVNum = _internals.softwareVersion;
    await bluebird.fromCallback((cb) => {
      this.database.insertOne(collectionInfo, {
        _id: currentVNum,
        initialInstall: timestamp.now()
      }, cb);
    });
  }
  const migrationsToRun = Object.keys(this.migrations).filter(function (vNum) {
    return vNum > currentVNum;
  }).sort();
  const context = new (_internals.MigrationContext)({
    database: this.database,
    logger: this.logger
  });
  for (const migration of migrationsToRun) {
    await migrate.call(this, migration);
  }

  /**
   * @this {Versions}
   */
  async function migrate (vNum) {
    await bluebird.fromCallback((cb) => {
      this.database.upsertOne(collectionInfo, { _id: vNum }, { $set: { migrationStarted: timestamp.now() } }, cb);
    });
    await bluebird.fromCallback((cb) => {
      this.migrations[vNum](context, cb);
    });
    await bluebird.fromCallback((cb) => {
      this.database.updateOne(collectionInfo, { _id: vNum }, { $set: { migrationCompleted: timestamp.now() } }, cb);
    });
  }
};

/**
 * For tests only.
 */
Versions.prototype.removeAll = async function () {
  await bluebird.fromCallback((cb) => {
    this.database.deleteMany(collectionInfo, {}, cb);
  });
};

// --- Migration methods --- //

/**
 * Export all version records (raw).
 * @returns {Promise<Array>}
 */
Versions.prototype.exportAll = async function () {
  return await bluebird.fromCallback((cb) => {
    this.database.find(collectionInfo, {}, {}, cb);
  });
};

/**
 * Import raw version records.
 * @param {Array} data
 */
Versions.prototype.importAll = async function (data) {
  if (!data || data.length === 0) return;
  await bluebird.fromCallback((cb) => {
    this.database.insertMany(collectionInfo, data, cb);
  });
};
