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
    BaseStorage = require('./BaseStorage'),
    converters = require('./../converters'),
    util = require('util'),
    toString = require('utils').toString,
    treeUtils = require('utils').treeUtils,
    _ = require('lodash');

module.exports = Streams;

/**
 * DB persistence for event streams.
 *
 * @param {Database} database
 * @constructor
 */
function Streams(database) {
  Streams.super_.call(this, database);

  _.extend(this.converters, {
    itemDefaults: [
      converters.createIdIfMissing,
    ],
    itemToDB: [
      converters.deletionToDB,
      converters.stateToDB
    ],
    itemsToDB: [
      treeUtils.flattenTree,
      cleanupDeletions
    ],
    updateToDB: [
      converters.stateUpdate,
      converters.getKeyValueSetUpdateFn('clientData')
    ],
    itemFromDB: [converters.deletionFromDB],
    itemsFromDB: [treeUtils.buildTree],
    convertIdToItemId: 'streamId'
  });

  this.defaultOptions = {
    sort: {name: 1}
  };
}
util.inherits(Streams, BaseStorage);

function cleanupDeletions(streams) {
  streams.forEach(function (s) {
    if (s.deleted) {
      delete s.parentId;
    }
  });
  return streams;
}

var indexes = [
  {
    index: {streamId: 1},
    options: {unique: true}
  },
 {
    index: {name: 1},
    options: {}
  },
  {
    index: { name: 1, parentId: 1 },
    options: { unique: true, partialFilterExpression: {
      deleted: { $type: 'null'}
    } }
  },
  {
    index: {trashed: 1},
    options: {}
  }
];

/**
 * Implementation.
 */
Streams.prototype.getCollectionInfo = function (user) {
  return {
    name: 'streams',
    indexes: indexes,
    useUserId: user.id
  };
};


Streams.prototype.countAll = function (user, callback) {
  this.count(user, {}, callback);
};

Streams.prototype.insertOne = function (user, stream, callback) {
  async.series([
    function checkDeletionWithSameId(stepDone) {
      if (! stream.id) { return stepDone(); }

      this.findDeletion(user, {id: stream.id}, null, function (err, deletion) {
        if (err) { return stepDone(err); }
        if (! deletion) { return stepDone(); }
        this.removeOne(user, {id: stream.id}, stepDone);
      }.bind(this));
    }.bind(this),
    function checkParent(stepDone) {
      if (! stream.parentId) { return stepDone(); }
      checkParentExists.call(this, user, stream.parentId, stepDone);
    }.bind(this)
  ], function doInsertOne(err) {
    if (err) { return callback(err); }
    Streams.super_.prototype.insertOne.call(this, user, stream, callback);
  }.bind(this));
};

Streams.prototype.updateOne = function (user, query, updatedData, callback) {
  var self = this;
  if (! updatedData.parentId) {
    doUpdate();
  } else {
    checkParentExists.call(self, user, updatedData.parentId, function (err) {
      if (err) { return callback(err); }
      doUpdate();
    });
  }

  function doUpdate() {
    Streams.super_.prototype.updateOne.call(self, user, query, updatedData, callback);
  }
};

/**
 * @this {Streams}
 */
function checkParentExists(user, parentId, callback) {
  this.findOne(user, {id: parentId}, null, function (err, parent) {
    if (err) { return callback(err); }
    if (! parent) {
      return callback(new Error('Unknown parent ' + toString.id(parentId)));
    }
    callback();
  });
}

/* jshint -W024 */
/**
 * Implementation.
 */
Streams.prototype.delete = function (user, query, callback) {
  var update = {
    $set: {deleted: new Date()},
    $unset: {
      name: 1,
      parentId: 1,
      clientData: 1,
      children: 1,
      trashed: 1,
      created: 1,
      createdBy: 1,
      modified: 1,
      modifiedBy: 1
    }
  };
  this.database.updateMany(this.getCollectionInfo(user),
    this.applyQueryToDB(query), update, callback);
};

