/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * 
 */
var async = require('async'),
    migrations = require('./migrations/index'),
    MigrationContext = require('./migrations/MigrationContext'),
    timestamp = require('unix-timestamp');
var collectionInfo = {
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
 * @param attachmentsDirPath
 * @param logging
 * @param migrationsOverride Use for tests
 * @constructor
 */
function Versions(database, attachmentsDirPath, logger, migrationsOverride) {
  this.database = database;
  this.attachmentsDirPath = attachmentsDirPath;
  this.migrations = migrationsOverride || migrations;
  this.logger = logger;
}

Versions.prototype.getCurrent = function (callback) {
  this.database.findOne(collectionInfo, {}, {sort: {migrationCompleted: -1}}, function (err, v) {
    if (err) { return callback(err); }
    callback(null, v);
  });
};

Versions.prototype.migrateIfNeeded = function (callback) {
  this.getCurrent(function (err, v) {
    if (err) { return callback(err); }

    var currentVNum = v ? v._id : '0.0.0';
    var migrationsToRun = Object.keys(this.migrations).filter(function (vNum) {
      return vNum > currentVNum;
    }).sort();
    async.forEachSeries(migrationsToRun, migrate.bind(this), callback);
  }.bind(this));

  var context = new MigrationContext({
    database: this.database,
    attachmentsDirPath: this.attachmentsDirPath,
    logger: this.logger
  });
  /**
   * @this {Versions}
   */
  function migrate(vNum, done) {
    async.series([
      function (stepDone) {
        var update = {
          $set: {
            migrationStarted: timestamp.now()
          }
        };
        this.database.upsertOne(collectionInfo, {_id: vNum}, update, stepDone);
      }.bind(this),
      function (stepDone) {
        this.migrations[vNum](context, stepDone);
      }.bind(this),
      function (stepDone) {
        var update = {$set: {migrationCompleted: timestamp.now()}};
        this.database.updateOne(collectionInfo, {_id: vNum}, update, stepDone);
      }.bind(this)
    ], done);
  }
};

/**
 * For tests only.
 */
Versions.prototype.removeAll = function (callback) {
  this.database.deleteMany(collectionInfo, {}, callback);
};
