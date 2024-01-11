/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
const _ = require('lodash');
const converters = require('./../converters');
const logger = require('@pryv/boiler').getLogger('storage:base-storage');

const BULKWRITE_BATCH_SIZE = 1000;

module.exports = BaseStorage;
/**
 * Base class for storage modules.
 * It handles the application of data converters (if any) and querying options, as well as the
 * conversion of property `id` into `_id` as used at the database level.
 *
 * Storage modules extending it...
 *
 * - **Must** override method `getCollectionInfo()`
 * - Can set data converters (see details below)
 * - Can set default options (structure: { projection: Object, sort: Object })
 * - Can override/add other methods if needed
 *
 * **About converters**
 *
 * Converters are functions that modify objects transiting to/from the database, to e.g. allow
 * objects stored internally to differ from those served publicly. Every converter takes
 * the original object as parameter and returns the modified object.
 * Converters shouldn't need to handle cloning of the original object (to avoid side fx):
 *
 * - DB-bound (to DB) converter functions are given a shallow clone of the original object
 * - Caller-bound (from DB) converter functions directly alter the object served from the DB
 *   (which is safe).
 *
 * @param {Database} database
 * @constructor
 */
function BaseStorage (database) {
  this.database = database;
  this.converters = {
    itemDefaults: [],
    queryToDB: [],
    fieldsToDB: [],
    itemToDB: [],
    itemsToDB: [],
    updateToDB: [],
    itemFromDB: [],
    itemsFromDB: [],
    convertIdToItemId: null
  };
  this.defaultOptions = { sort: {} };
}

BaseStorage.prototype.getUserIdFromUserOrUserId = function (userOrUserId) {
  if (typeof userOrUserId === 'string') return userOrUserId;
  return userOrUserId.id;
};

/**
 * Retrieves collection information (name and indexes).
 * Must be implemented by storage modules.
 *
 * @param {Object|String} userOrUserId The user owning the collection
 * @return {{name: string, indexes: Array}}
 */
BaseStorage.prototype.getCollectionInfo = function (userOrUserId) {
  return new Error('Not implemented (user: ' + userOrUserId + ')');
};

BaseStorage.prototype.countAll = function (userOrUserId, callback) {
  this.database.countAll(this.getCollectionInfo(userOrUserId), callback);
};

/// Returns the number of documents in the collection, minus those that are
/// either `deleted` or have a `headId`, aka the number of live / trashed
/// documents.
///
BaseStorage.prototype.count = function (userOrUserId, query, callback) {
  query.deleted = null;
  query.headId = null;
  this.database.count(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    callback
  );
};

/**
 * Ignores item deletions (i.e. documents with `deleted` field) &
 * history items (i.e. documents with `headId` field)
 * @see `findDeletions()`
 */
BaseStorage.prototype.find = function (userOrUserId, query, options, callback) {
  query.deleted = null;
  query.headId = null;
  this.findIncludingDeletionsAndVersions(userOrUserId, query, options, callback);
};

/**
 * Used by "mall" only
 */
BaseStorage.prototype.findIncludingDeletionsAndVersions = function (userOrUserId, query, options, callback) {
  this.database.find(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
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
 * 1. Finds all documents matching the given query
 * 2. Check them against some logic done by `updateIfNeedCallback` one by one
 * 3. Eventually perform an update (in Bulk) if `updateIfNeedCallback` returns an operation
 *
 * This is used by integrity processes to re-set integrity values on updateMany
 *
 * @param {Object} collectionInfo
 * @param {Object} query Mongo-style query
 * @param {UpdateIfNeededCallback} updateIfNeededCallback .. returns update to do on document or null if no update
 * @param {Function} callback
 */
BaseStorage.prototype.findAndUpdateIfNeeded = function (userOrUserId, query, options, updateIfNeededCallback, callback) {
  const collectionInfo = this.getCollectionInfo(userOrUserId);
  const database = this.database;
  const finalQuery = this.applyQueryToDB(query);
  const finalOptions = this.applyOptionsToDB(options);
  database.findCursor(
    collectionInfo,
    finalQuery,
    finalOptions,
    async (err, cursor) => {
      if (err) return callback(err);
      let updatesToDo = []; // keeps a list of updates to do
      let updatesDone = 0;
      async function executBulk () {
        if (updatesToDo.length === 0) return;

        const bulkResult = await database.bulkWrite(collectionInfo, updatesToDo);
        updatesDone += bulkResult?.result?.nModified || 0;
        if (bulkResult?.result?.nModified !== updatesToDo.length) {
        // not throwing error as we are in the middle on an operation
          logger.error('Issue when doing bulk update for ' + JSON.stringify({ coll: collectionInfo.name, userOrUserId, query }) + ' counts does not match');
        }
        updatesToDo = [];
      }

      try {
        while (await cursor.hasNext()) {
          const document = await cursor.next();
          const _id = document._id; // keep mongodb _id;
          const updateQuery = updateIfNeededCallback(this.applyItemFromDB(document));
          if (updateQuery == null) continue; // nothing to do ..

          updatesToDo.push(
            {
              updateOne: {
                filter: { _id },
                update: updateQuery
              }
            });

          if (updatesToDo.length === BULKWRITE_BATCH_SIZE) {
            await executBulk();
          }
        }
        // flush
        await executBulk();

        return callback(null, { count: updatesDone });
      } catch (err) {
        return callback(err);
      }
    });
};

/**
 * Same as find(), but returns a readable stream
 */
BaseStorage.prototype.findStreamed = function (user, query, options, callback) {
  callback(new Error('Not implemented (user: ' + user + ')'));
  // Implemented for Events only.
};

BaseStorage.prototype.findDeletions = function (
  userOrUserId,
  deletedSince,
  options,
  callback
) {
  const query = { deleted: { $gt: deletedSince } };
  query.headId = null;
  this.database.find(
    this.getCollectionInfo(userOrUserId),
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
 * Same as findDeletions(), but returns a readable stream
 */
BaseStorage.prototype.findDeletionsStreamed = function (
  user,
  deletedSince,
  options,
  callback
) {
  callback(new Error('Not implemented (user: ' + user + ')'));
  // Implemented for Events only.
};

BaseStorage.prototype.findOne = function (userOrUserId, query, options, callback) {
  query.deleted = null;

  this.database.findOne(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    function (err, dbItem) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }.bind(this)
  );
};

BaseStorage.prototype.findDeletion = function (userOrUserId, query, options, callback) {
  query.deleted = { $ne: null };
  this.database.findOne(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    function (err, dbItem) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }.bind(this)
  );
};

BaseStorage.prototype.insertOne = function (userOrUserId, item, callback, options) {
  const itemToInsert = this.applyItemToDB(this.applyItemDefaults(item));
  this.database.insertOne(
    this.getCollectionInfo(userOrUserId),
    itemToInsert,
    function (err) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(itemToInsert));
    }.bind(this),
    options
  );
};

/**
 * Finds and updates atomically a single document matching the given query,
 * returning the updated document.
 * @param user
 * @param query
 * @param updatedData
 * @param callback
 */
BaseStorage.prototype.findOneAndUpdate = function (userOrUserId, query, updatedData, callback) {
  this.database.findOneAndUpdate(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyUpdateToDB(updatedData),
    function (err, dbItem) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }.bind(this)
  );
};

/**
 * Updates the single document matching the given query, returning the updated document.
 *
 * @param user
 * @param query
 * @param updatedData
 * @param callback
 */
BaseStorage.prototype.updateOne = BaseStorage.prototype.findOneAndUpdate;

/**
 * Updates the one or multiple document(s) matching the given query.
 *
 * @param user
 * @param query
 * @param updatedData
 * @param callback
 */
BaseStorage.prototype.updateMany = function (
  userOrUserId,
  query,
  updatedData,
  callback
) {
  this.database.updateMany(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyUpdateToDB(updatedData),
    callback
  );
};

/**
 * Deletes the document(s), replacing them with a deletion record (i.e. id and deletion date).
 * Returns the deletion.
 *
 * Pay attention to the change in semantics with the lower DB layer, where 'delete' means actual
 * removal.
 *
 * @see `remove()`, which actually removes the document from the collection
 *
 * @param user
 * @param query
 * @param callback
 */
BaseStorage.prototype.delete = function (userOrUserId, query, callback) {
  callback(new Error('Not implemented (user: ' + userOrUserId + ')'));
  // a line like this could work when/if Mongo ever supports "replacement" update on multiple docs:
  // this.database.update(this.getCollectionInfo(user), this.applyQueryToDB(query),
  //    {deleted: timestamp.now()}, callback);
};

BaseStorage.prototype.removeOne = function (userOrUserId, query, callback) {
  this.database.deleteOne(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    callback
  );
};

BaseStorage.prototype.removeMany = function (userOrUserId, query, callback) {
  this.database.deleteMany(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    callback
  );
};

BaseStorage.prototype.removeAll = function (userOrUserId, callback) {
  this.database.deleteMany(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB({}),
    callback
  );
};

BaseStorage.prototype.dropCollection = function (userOrUserId, callback) {
  this.database.dropCollection(this.getCollectionInfo(userOrUserId), callback);
};

// for tests only (at the moment)

/**
 * For tests only.
 */
BaseStorage.prototype.findAll = function (userOrUserId, options, callback) {
  this.database.find(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB({}),
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
 * Inserts an array of items; each item must have a valid id and data already. For tests only.
 */
BaseStorage.prototype.insertMany = function (userOrUserId, items, callback, options) {
  // Groumpf... Many tests are relying on this..
  const nItems = structuredClone(items);
  this.database.insertMany(
    this.getCollectionInfo(userOrUserId),
    this.applyItemsToDB(nItems),
    callback,
    options
  );
};

/**
 * Gets the total size of the collection, in bytes.
 *
 * @param {Object} userOrUserId
 */
BaseStorage.prototype.getTotalSize = async function (userOrUserId) {
  return await this.database.totalSize(this.getCollectionInfo(userOrUserId));
};

/**
 * Gets the indexes set for the collection.
 *
 * @param {Object} user
 * @param {Object} options
 * @param {Function} callback
 */
BaseStorage.prototype.listIndexes = function (userOrUserId, options, callback) {
  this.database.listIndexes(this.getCollectionInfo(userOrUserId), options, callback);
};

// converters application functions

/**
 * @api private
 */
BaseStorage.prototype.applyItemDefaults = function (item) {
  // no cloning! we do want to alter the original object
  return applyConverters(item, this.converters.itemDefaults);
};

/**
 * @api private
 */
BaseStorage.prototype.applyQueryToDB = function (query) {
  this.addIdConvertion();
  return applyConvertersToDB(structuredClone(query), this.converters.queryToDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyOptionsToDB = function (options) {
  const dbOptions = Object.assign({}, this.defaultOptions, options || {});

  if (dbOptions.fields != null) { throw new Error("AF: fields key is deprecated; we're not using it anymore."); }

  if (dbOptions.projection != null) {
    dbOptions.projection = applyConvertersToDB(
      dbOptions.projection,
      this.converters.fieldsToDB);
  }

  dbOptions.sort = applyConvertersToDB(
    dbOptions.sort,
    this.converters.fieldsToDB);

  return dbOptions;
};

/**
 *  @api private
 *  Add needed converters when this.converters.convertIdToItemId
 */
BaseStorage.prototype.addIdConvertion = function () {
  if (this.idConvertionSetupDone) return;

  if (this.converters.convertIdToItemId != null) {
    const idToItemIdToDB = converters.getRenamePropertyFn('id', this.converters.convertIdToItemId);
    const itemIdToIdFromDB = converters.getRenamePropertyFn(this.converters.convertIdToItemId, 'id');
    this.converters.itemToDB.unshift(idToItemIdToDB);
    this.converters.queryToDB.unshift(idToItemIdToDB);
    this.converters.itemFromDB.unshift(itemIdToIdFromDB);
  }
  this.idConvertionSetupDone = true;
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemToDB = function (item) {
  this.addIdConvertion();
  return applyConvertersToDB(structuredClone(item), this.converters.itemToDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemsToDB = function (items) {
  return applyConvertersToDB(items.slice(), this.converters.itemsToDB).map(
    this.applyItemToDB.bind(this)
  );
};

/**
 * @api private
 */
BaseStorage.prototype.applyUpdateToDB = function (updatedData) {
  const input = structuredClone(updatedData);
  const data = {};

  if (input.$min != null) {
    data.$min = input.$min;
    delete input.$min;
  }
  if (input.$max != null) {
    data.$max = input.$max;
    delete input.$max;
  }

  if (input.$pull != null) {
    data.$pull = input.$pull;
    delete input.$pull;
  }

  if (input.$inc != null) {
    data.$inc = input.$inc;
    delete input.$inc;
  }

  if (input.$unset != null) {
    data.$unset = input.$unset;
    delete input.$unset;
  } else {
    data.$unset = {}; // code in 'converters.js' depends on this.
  }

  // Maybe add more of these?
  //    https://docs.mongodb.com/manual/reference/operator/update/
  data.$set = input;

  const dbUpdate = applyConvertersToDB(
    data,
    this.converters.updateToDB
  );
  if (_.isEmpty(dbUpdate.$set)) {
    delete dbUpdate.$set;
  }
  if (_.isEmpty(dbUpdate.$unset)) {
    delete dbUpdate.$unset;
  }
  return dbUpdate;
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemFromDB = function (dbItem) {
  this.addIdConvertion();
  return applyConvertersFromDB(dbItem, this.converters.itemFromDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemsFromDB = function (dbItems) {
  return applyConvertersFromDB(
    dbItems.map(this.applyItemFromDB.bind(this)),
    this.converters.itemsFromDB
  );
};

const idToDB = converters.getRenamePropertyFn('id', '_id');
const idFromDB = converters.getRenamePropertyFn('_id', 'id');

function applyConvertersToDB (object, converterFns) {
  return idToDB(applyConverters(object, converterFns));
}

function applyConvertersFromDB (object, converterFns) {
  if (object) {
    if (object.constructor === Array) {
      const length = object.length;
      for (let i = 0; i < length; i++) {
        if (object[i].userId) {
          delete object[i].userId;
        }
      }
    } else {
      if (object.userId) {
        delete object.userId;
      }
    }
  }
  return applyConverters(idFromDB(object), converterFns);
}

function applyConverters (object, converterFns) {
  converterFns.forEach(function (fn) {
    object = fn(object);
  });
  return object;
}
