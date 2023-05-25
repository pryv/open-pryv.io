/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const bluebird = require('bluebird');
const timestamp = require('unix-timestamp');
const packageFile = require('../package.json');
const migrations = require('./migrations/index');
const MigrationContext = require('./migrations/MigrationContext');

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
  this.migrations = migrationsOverride || migrations;
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
    currentVNum = packageFile.version;
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
  const context = new MigrationContext({
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
