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
const BaseStorage = require('./BaseStorage');
const converters = require('./../converters');
const generateId = require('cuid');
const util = require('util');
const _ = require('lodash');

module.exports = Accesses;
/**
 * DB persistence for accesses.
 *
 * @param {Database} database
 * @constructor
 */
function Accesses(database) {
  Accesses.super_.call(this, database);

  _.extend(this.converters, {
    itemDefaults: [
      converters.createIdIfMissing,
      createTokenIfMissing
    ],
    itemToDB: [converters.deletionToDB],
    itemFromDB: [converters.deletionFromDB],
    queryToDB: [converters.idInOrClause],
  });

  this.defaultOptions = {
    sort: {name: 1}
  };
}
util.inherits(Accesses, BaseStorage);

function createTokenIfMissing(access) {
  access.token = access.token || generateId();
  return access;
}

const indexes = [
  {
    index: {token: 1},
    options: { 
      unique: true,
      partialFilterExpression: { deleted: { $type: 'null' } }
    }
  },
  {
    index: { name: 1, type: 1, deviceName: 1 },
    options: { 
      unique: true,
      partialFilterExpression: { deleted: { $type: 'null' } }
    }
  }
];

Accesses.prototype.findDeletions = function (
  user,
  query,
  options,
  callback
) {
  query = query || {};
  query.deleted = { $type: 'date' };
  
  this.database.find(
    this.getCollectionInfo(user),
    query,
    this.applyOptionsToDB(options),
    function (err, dbItems) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemsFromDB(dbItems));
    }.bind(this)
  );
};

/**
 * Implementation.
 */
Accesses.prototype.getCollectionInfo = function (user) {
  return {
    name: 'accesses',
    indexes: indexes,
    useUserId: user.id
  };
};

/* jshint -W024 */
/**
 * Implementation.
 */
Accesses.prototype.delete = function (user, query, callback) {
  const update = {
    $set: {deleted: new Date()}
  };
  this.database.updateMany(this.getCollectionInfo(user),
    this.applyQueryToDB(query), update, callback);
};

/**
 * Exposed for convenience.
 *
 * @returns {String}
 */
Accesses.prototype.generateToken = function () {
  return generateId();
};

/**
 * Override base method to set deleted:null
 * 
 * @param {*} user 
 * @param {*} item 
 * @param {*} callback 
 */
Accesses.prototype.insertOne = function (user, access, callback, options) {
  let accessToCreate = _.clone(access);
  if (accessToCreate.deleted === undefined) accessToCreate.deleted = null;
  this.database.insertOne(
    this.getCollectionInfo(user),
    this.applyItemToDB(this.applyItemDefaults(accessToCreate)),
    function (err) {
      if (err) {
        return callback(err);
      }
      callback(null, _.omit(accessToCreate, 'deleted'));
    },
    options
  );
};

/**
 * Inserts an array of accesses; each item must have a valid id and data already. For tests only.
 */
Accesses.prototype.insertMany = function (user, accesses, callback) {
  const accessesToCreate = accesses.map((a) => {
    if (a.deleted === undefined) return _.assign({deleted: null}, a);
    return a;
  });
  this.database.insertMany(
    this.getCollectionInfo(user),
    this.applyItemsToDB(accessesToCreate),
    callback
  );
};