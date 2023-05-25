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
const BaseStorage = require('./BaseStorage');
const converters = require('./../converters');
const util = require('util');
const _ = require('lodash');
const timestamp = require('unix-timestamp');

module.exports = Webhooks;
/**
 * DB persistence for webhooks.
 *
 * @param {Database} database
 * @constructor
 */
function Webhooks (database) {
  Webhooks.super_.call(this, database);

  _.extend(this.converters, {
    itemDefaults: [
      converters.createIdIfMissing
    ],
    itemToDB: [converters.deletionToDB],
    itemFromDB: [converters.deletionFromDB]
  });

  this.defaultOptions = {
  };
}
util.inherits(Webhooks, BaseStorage);

const indexes = [
  {
    index: { accessId: 1, url: 1 },
    options: {
      unique: true,
      partialFilterExpression: { deleted: { $type: 'null' } }
    }
  }
];

/**
 * Implementation.
 */
Webhooks.prototype.getCollectionInfo = function (userOrUserId) {
  const userId = this.getUserIdFromUserOrUserId(userOrUserId);
  return {
    name: 'webhooks',
    indexes,
    useUserId: userId
  };
};

/**
 * Implementation.
 */
Webhooks.prototype.delete = function (userOrUserId, query, callback) {
  const update = {
    $set: { deleted: timestamp.now() },
    $unset: {
      accessId: 1,
      url: 1,
      state: 1,
      runCount: 1,
      failCount: 1,
      lastRun: 1,
      runs: 1,
      currentRetries: 1,
      maxRetries: 1,
      minIntervalMs: 1,
      created: 1,
      createdBy: 1,
      modified: 1,
      modifiedBy: 1
    }
  };
  this.database.updateMany(this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query), update, callback);
};

/**
 * Override base method to set deleted:null
 *
 * @param {*} user
 * @param {*} item
 * @param {*} callback
 */
Webhooks.prototype.insertOne = function (userOrUserId, webhook, callback) {
  const webhookToCreate = _.clone(webhook);
  if (webhookToCreate.deleted === undefined) webhookToCreate.deleted = null;
  this.database.insertOne(
    this.getCollectionInfo(userOrUserId),
    this.applyItemToDB(this.applyItemDefaults(webhookToCreate)),
    function (err) {
      if (err) {
        return callback(err);
      }
      callback(null, _.omit(webhookToCreate, 'deleted'));
    }
  );
};

/**
 * Inserts an array of webhooks; each item must have a valid id and data already. For tests only.
 */
Webhooks.prototype.insertMany = function (userOrUserId, webhooks, callback) {
  const webhooksToCreate = webhooks.map((w) => {
    if (w.deleted === undefined) return _.assign({ deleted: null }, w);
    return w;
  });
  this.database.insertMany(
    this.getCollectionInfo(userOrUserId),
    this.applyItemsToDB(webhooksToCreate),
    callback
  );
};
