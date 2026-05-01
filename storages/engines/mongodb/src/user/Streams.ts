/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const BaseStorage = require('./BaseStorage');
const converters = require('./../converters');
const util = require('util');
const _internals = require('../_internals');
const treeUtils = require('../../../../shared/treeUtils');
const timestamp = require('unix-timestamp');

module.exports = Streams;

/**
 * DB persistence for event streams.
 *
 * @param {Database} database
 * @constructor
 */
function Streams (database) {
  (Streams as any).super_.call(this, database);

  Object.assign(this.converters, {
    itemDefaults: [
    ],
    itemToDB: [
      // converters.deletionToDB,
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
    sort: { name: 1 }
  };
}
util.inherits(Streams, BaseStorage);

function cleanupDeletions (streams) {
  streams.forEach(function (s) {
    if (s.deleted) {
      delete s.parentId;
    }
  });
  return streams;
}

const indexes = [
  {
    index: { streamId: 1 },
    options: { unique: true }
  },
  {
    index: { name: 1 },
    options: {}
  },
  {
    index: { name: 1, parentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        deleted: { $type: 'null' }
      }
    }
  },
  {
    index: { trashed: 1 },
    options: {}
  }
];

/**
 * Implementation.
 */
Streams.prototype.getCollectionInfo = function (userOrUserId) {
  const userId = this.getUserIdFromUserOrUserId(userOrUserId);
  return {
    name: 'streams',
    indexes,
    useUserId: userId
  };
};

Streams.prototype.countAll = function (user, callback) {
  this.count(user, {}, callback);
};

/**
 * Override importAll: convert canonical backup format `id` → MongoDB `streamId`.
 */
Streams.prototype.importAll = function (userOrUserId, items, callback) {
  const mapped = items.map(item => {
    const doc = Object.assign({}, item);
    if (doc.id != null && doc.streamId == null) {
      doc.streamId = doc.id;
      delete doc.id;
    }
    return doc;
  });
  (Streams as any).super_.prototype.importAll.call(this, userOrUserId, mapped, callback);
};

Streams.prototype.insertOne = function (user, stream, callback) {
  _internals.cache.unsetUserData(user.id);
  (Streams as any).super_.prototype.insertOne.call(this, user, stream, callback);
};

Streams.prototype.updateOne = function (user, query, updatedData, callback) {
  if (typeof updatedData.parentId !== 'undefined') { // clear ALL when a stream is moved
    _internals.cache.unsetUserData(user.id);
  } else { // only stream Structure
    _internals.cache.unsetStreams(user.id, 'local');
  }
  (Streams as any).super_.prototype.updateOne.call(this, user, query, updatedData, callback);
};

/**
 * Implementation.
 */
Streams.prototype.delete = function (userOrUserId, query, callback) {
  const userId = userOrUserId.id || userOrUserId;
  _internals.cache.unsetUserData(userId);
  const update = {
    $set: { deleted: timestamp.now() },
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
  this.database.updateMany(this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query), update, callback);
};
