/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { fromCallback } = require('utils');
const converters = require('./../converters.ts');
const { _internals } = require('../_internals.ts');
const logger = _internals.lazyLogger('storage:base-storage');

const BULKWRITE_BATCH_SIZE = 1000;

export { BaseStorage };
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
 */
function BaseStorage (this: any, database: any) {
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

BaseStorage.prototype.getUserIdFromUserOrUserId = function (userOrUserId: any) {
  if (typeof userOrUserId === 'string') return userOrUserId;
  return userOrUserId.id;
};

/**
 * Retrieves collection information (name and indexes).
 * Must be implemented by storage modules.
 *
 * @param userOrUserId The user owning the collection
 */
BaseStorage.prototype.getCollectionInfo = function (userOrUserId: any) {
  return new Error('Not implemented (user: ' + userOrUserId + ')');
};

BaseStorage.prototype.countAll = function (userOrUserId: any, callback: any) {
  this.database.countAll(this.getCollectionInfo(userOrUserId), callback);
};

/// Returns the number of documents in the collection, minus those that are
/// either `deleted` or have a `headId`, aka the number of live / trashed
/// documents.
///
BaseStorage.prototype.count = function (userOrUserId: any, query: any, callback: any) {
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
BaseStorage.prototype.find = function (userOrUserId: any, query: any, options: any, callback: any) {
  query.deleted = null;
  query.headId = null;
  this.findIncludingDeletionsAndVersions(userOrUserId, query, options, callback);
};

/**
 * Used by "mall" only
 */
BaseStorage.prototype.findIncludingDeletionsAndVersions = function (this: any, userOrUserId: any, query: any, options: any, callback: any) {
  this.database.find(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    (err: any, dbItems: any) => {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemsFromDB(dbItems));
    }
  );
};

/**
 * 1. Finds all documents matching the given query
 * 2. Check them against some logic done by `updateIfNeedCallback` one by one
 * 3. Eventually perform an update (in Bulk) if `updateIfNeedCallback` returns an operation
 *
 * This is used by integrity processes to re-set integrity values on updateMany
 *
 * @param query Mongo-style query
 * @param updateIfNeededCallback .. returns update to do on document or null if no update
 */
BaseStorage.prototype.findAndUpdateIfNeeded = function (userOrUserId: any, query: any, options: any, updateIfNeededCallback: any, callback: any) {
  const collectionInfo = this.getCollectionInfo(userOrUserId);
  const database = this.database;
  const finalQuery = this.applyQueryToDB(query);
  const finalOptions = this.applyOptionsToDB(options);
  database.findCursor(
    collectionInfo,
    finalQuery,
    finalOptions,
    async (err: any, cursor: any) => {
      if (err) return callback(err);
      let updatesToDo: any[] = []; // keeps a list of updates to do
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

BaseStorage.prototype.findDeletions = function (
  this: any,
  userOrUserId: any,
  deletedSince: any,
  options: any,
  callback: any
) {
  const query: any = { deleted: { $gt: deletedSince } };
  query.headId = null;
  this.database.find(
    this.getCollectionInfo(userOrUserId),
    query,
    this.applyOptionsToDB(options),
    (err: any, dbItems: any) => {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemsFromDB(dbItems));
    }
  );
};

BaseStorage.prototype.findOne = function (this: any, userOrUserId: any, query: any, options: any, callback: any) {
  query.deleted = null;
  query.headId = null;

  this.database.findOne(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    (err: any, dbItem: any) => {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }
  );
};

BaseStorage.prototype.findDeletion = function (this: any, userOrUserId: any, query: any, options: any, callback: any) {
  query.deleted = { $ne: null };
  this.database.findOne(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    (err: any, dbItem: any) => {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }
  );
};

BaseStorage.prototype.insertOne = function (this: any, userOrUserId: any, item: any, callback: any, options: any) {
  const itemToInsert = this.applyItemToDB(this.applyItemDefaults(item));
  this.database.insertOne(
    this.getCollectionInfo(userOrUserId),
    itemToInsert,
    (err: any) => {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(itemToInsert));
    },
    options
  );
};

/**
 * Finds and updates atomically a single document matching the given query,
 * returning the updated document.
 */
BaseStorage.prototype.findOneAndUpdate = function (this: any, userOrUserId: any, query: any, updatedData: any, callback: any) {
  this.database.findOneAndUpdate(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyUpdateToDB(updatedData),
    (err: any, dbItem: any) => {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }
  );
};

/**
 * Updates the single document matching the given query, returning the updated document.
 *
 */
BaseStorage.prototype.updateOne = BaseStorage.prototype.findOneAndUpdate;

/**
 * Updates the one or multiple document(s) matching the given query.
 *
 */
BaseStorage.prototype.updateMany = function (
  userOrUserId: any,
  query: any,
  updatedData: any,
  callback: any
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
 */
BaseStorage.prototype.delete = function (userOrUserId: any, query: any, callback: any) {
  callback(new Error('Not implemented (user: ' + userOrUserId + ')'));
  // a line like this could work when/if Mongo ever supports "replacement" update on multiple docs:
  // this.database.update(this.getCollectionInfo(user), this.applyQueryToDB(query),
  //    {deleted: timestamp.now()}, callback);
};

BaseStorage.prototype.removeOne = function (userOrUserId: any, query: any, callback: any) {
  this.database.deleteOne(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    callback
  );
};

BaseStorage.prototype.removeMany = function (userOrUserId: any, query: any, callback: any) {
  this.database.deleteMany(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    callback
  );
};

BaseStorage.prototype.removeAll = function (userOrUserId: any, callback: any) {
  this.database.deleteMany(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB({}),
    callback
  );
};

BaseStorage.prototype.dropCollection = function (userOrUserId: any, callback: any) {
  this.database.dropCollection(this.getCollectionInfo(userOrUserId), callback);
};

/**
 * Drops the actual MongoDB collection (including indexes).
 * Primarily for tests when indexes need to be recreated.
 */
BaseStorage.prototype.dropCollectionFully = function (userOrUserId: any, callback: any) {
  this.database.dropCollectionFully(this.getCollectionInfo(userOrUserId), callback);
};

/**
 * Async generator that yields ALL items in the collection (no user filter,
 * no deleted/headId filtering). Used for cross-user scans like integrity checking.
 */
BaseStorage.prototype.iterateAll = async function * () {
  // Use collection name only (no useUserId) to scan ALL rows across users
  const collectionInfo = { name: this.getCollectionInfo('_').name };
  const cursor = await fromCallback((cb: any) =>
    this.database.findCursor(collectionInfo, {}, {}, cb)
  );
  while (await cursor.hasNext()) {
    yield this.applyItemFromDB(await cursor.next());
  }
};

// for tests only (at the moment)

/**
 * For tests only.
 */
BaseStorage.prototype.findAll = function (this: any, userOrUserId: any, options: any, callback: any) {
  this.database.find(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB({}),
    this.applyOptionsToDB(options),
    (err: any, dbItems: any) => {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemsFromDB(dbItems));
    }
  );
};

/**
 * Inserts an array of items; each item must have a valid id and data already. For tests only.
 */
BaseStorage.prototype.insertMany = function (userOrUserId: any, items: any, callback: any, options: any) {
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
 * Gets the indexes set for the collection.
 *
 */
BaseStorage.prototype.listIndexes = function (userOrUserId: any, options: any, callback: any) {
  this.database.listIndexes(this.getCollectionInfo(userOrUserId), options, callback);
};

// --- Migration methods --- //
// These operate directly on the database, bypassing the converter pipeline,
// to ensure raw data fidelity during migration.

/**
 * Export all documents for a user (raw, bypasses converters).
 */
BaseStorage.prototype.exportAll = function (userOrUserId: any, callback: any) {
  this.database.find(
    this.getCollectionInfo(userOrUserId),
    {},
    {},
    callback
  );
};

/**
 * Import raw documents for a user (bypasses converters).
 */
BaseStorage.prototype.importAll = function (userOrUserId: any, items: any, callback: any) {
  if (!items || items.length === 0) return callback(null);
  this.database.insertMany(
    this.getCollectionInfo(userOrUserId),
    items,
    callback
  );
};

/**
 * Remove all documents for a user (actual delete, not soft delete).
 * Same as removeAll but with explicit naming for migration use.
 */
BaseStorage.prototype.clearAll = function (userOrUserId: any, callback: any) {
  this.database.deleteMany(
    this.getCollectionInfo(userOrUserId),
    {},
    callback
  );
};

// converters application functions

/**
 * @api private
 */
BaseStorage.prototype.applyItemDefaults = function (item: any) {
  // no cloning! we do want to alter the original object
  return applyConverters(item, this.converters.itemDefaults);
};

/**
 * @api private
 */
BaseStorage.prototype.applyQueryToDB = function (query: any) {
  this.addIdConvertion();
  return applyConvertersToDB(structuredClone(query), this.converters.queryToDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyOptionsToDB = function (options: any) {
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
BaseStorage.prototype.applyItemToDB = function (item: any) {
  this.addIdConvertion();
  return applyConvertersToDB(structuredClone(item), this.converters.itemToDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemsToDB = function (items: any) {
  return applyConvertersToDB(items.slice(), this.converters.itemsToDB).map(
    this.applyItemToDB.bind(this)
  );
};

/**
 * @api private
 */
BaseStorage.prototype.applyUpdateToDB = function (updatedData: any) {
  const input: any = structuredClone(updatedData);
  const data: any = {};

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
  if (!dbUpdate.$set || Object.keys(dbUpdate.$set).length === 0) {
    delete dbUpdate.$set;
  }
  if (!dbUpdate.$unset || Object.keys(dbUpdate.$unset).length === 0) {
    delete dbUpdate.$unset;
  }
  return dbUpdate;
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemFromDB = function (dbItem: any) {
  this.addIdConvertion();
  return applyConvertersFromDB(dbItem, this.converters.itemFromDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemsFromDB = function (dbItems: any) {
  return applyConvertersFromDB(
    dbItems.map(this.applyItemFromDB.bind(this)),
    this.converters.itemsFromDB
  );
};

const idToDB = converters.getRenamePropertyFn('id', '_id');
const idFromDB = converters.getRenamePropertyFn('_id', 'id');

function applyConvertersToDB (object: any, converterFns: any) {
  return idToDB(applyConverters(object, converterFns));
}

function applyConvertersFromDB (object: any, converterFns: any) {
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

function applyConverters (object: any, converterFns: any) {
  converterFns.forEach(function (fn: any) {
    object = fn(object);
  });
  return object;
}
