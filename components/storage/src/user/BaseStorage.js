const _ = require('lodash');
const converters = require('./../converters');
const timestamp = require('unix-timestamp');

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
function BaseStorage(database) {
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

/**
 * Retrieves collection information (name and indexes).
 * Must be implemented by storage modules.
 *
 * @param {Object} user The user owning the collection
 * @return {{name: string, indexes: Array}}
 */
BaseStorage.prototype.getCollectionInfo = function(user) {
  return new Error('Not implemented (user: ' + user + ')');
};

BaseStorage.prototype.countAll = function(user, callback) {
  this.database.countAll(this.getCollectionInfo(user), callback);
};

BaseStorage.prototype.initCollection = function (user, callback) {
  this.database.getCollection(this.getCollectionInfo(user), callback);
};

/// Returns the number of documents in the collection, minus those that are 
/// either `deleted` or have a `headId`, aka the number of live / trashed 
/// documents. 
/// 
BaseStorage.prototype.count = function(user, query, callback) {
  query.deleted = null;
  query.headId = null;
  this.database.count(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    callback
  );
};

/**
 * Ignores item deletions (i.e. documents with `deleted` field) &
 * history items (i.e. documents with `headId` field)
 * @see `findDeletions()`
 */
BaseStorage.prototype.find = function(user, query, options, callback) {
  query.deleted = null;
  query.headId = null;
  this.database.find(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    function(err, dbItems) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemsFromDB(dbItems));
    }.bind(this)
  );
};


/**
 * Same as find(), but returns a readable stream
 */
BaseStorage.prototype.findStreamed = function(user, query, options, callback) {
  callback( new Error('Not implemented (user: ' + user + ')') );
  // Implemented for Events only.
};


/**
 * Retrieves the history for a certain event
 *
 * @param user {Object} user The user owning the collection
 * @param headId {string} the id of the event whose history is queried
 * @param options {Object}
 * @param callback {Function}
 * @returns {Error}
 */
BaseStorage.prototype.findHistory = function(user, headId, options, callback) {
  callback( new Error('Not implemented (user: ' + user + ')') );
  // Implemented for Events only
};

BaseStorage.prototype.findDeletions = function(
  user,
  deletedSince,
  options,
  callback
) {
  const query = { deleted: { $gt: timestamp.toDate(deletedSince) } };
  query.headId = null;
  this.database.find(
    this.getCollectionInfo(user),
    query,
    this.applyOptionsToDB(options),
    function(err, dbItems) {
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
BaseStorage.prototype.findDeletionsStreamed = function(
  user,
  deletedSince,
  options,
  callback
) {
  callback( new Error('Not implemented (user: ' + user + ')') );
  // Implemented for Events only.
};

BaseStorage.prototype.findOne = function(user, query, options, callback) {
  query.deleted = null;
  
  this.database.findOne(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    function(err, dbItem) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }.bind(this)
  );
};

BaseStorage.prototype.findDeletion = function(user, query, options, callback) {
  query.deleted = { $ne: null };
  this.database.findOne(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    function(err, dbItem) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }.bind(this)
  );
};

BaseStorage.prototype.aggregate = function(
  user,
  query,
  projectExpression,
  groupExpression,
  options,
  callback
) {
  this.database.aggregate(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    this.applyQueryToDB(projectExpression),
    this.applyQueryToDB(groupExpression),
    this.applyOptionsToDB(options),
    function(err, dbItems) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemsFromDB(dbItems));
    }.bind(this)
  );
};

BaseStorage.prototype.insertOne = function(user, item, callback) {
  this.database.insertOne(
    this.getCollectionInfo(user),
    this.applyItemToDB(this.applyItemDefaults(item)),
    function(err) {
      if (err) {
        return callback(err);
      }
      callback(null, item);
    }
  );
};


/**
 * Minimizes an event's history, used when in 'keep-authors' deletionMode
 *
 * @param user {Object} user The user owning the collection
 * @param headId {string} the id of the event whose history is minimized
 * @param callback {Function}
 */
BaseStorage.prototype.minimizeEventsHistory = function(user, headId, callback) {
  callback( new Error('Not implemented (user: ' + user + ')') );
  // implemented for events only
};

/**
 * Finds and updates atomically a single document matching the given query,
 * returning the updated document.
 * @param user
 * @param query
 * @param updatedData
 * @param callback
 */
BaseStorage.prototype.findOneAndUpdate = function(user, query, updatedData, callback) {
  this.database.findOneAndUpdate(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    this.applyUpdateToDB(updatedData),
    function(err, dbItem) {
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
BaseStorage.prototype.updateOne = function(user, query, updatedData, callback) {
  this.database.findOneAndUpdate(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    this.applyUpdateToDB(updatedData),
    function(err, dbItem) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemFromDB(dbItem));
    }.bind(this)
  );
};

/**
 * Updates the one or multiple document(s) matching the given query.
 *
 * @param user
 * @param query
 * @param updatedData
 * @param callback
 */
BaseStorage.prototype.updateMany = function(
  user,
  query,
  updatedData,
  callback
) {
  this.database.updateMany(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    this.applyUpdateToDB(updatedData),
    callback
  );
};

/**
 * Update.
 *
 * @param user
 * @param query
 * @param updatedData
 * @param options
 * @param callback
 */
BaseStorage.prototype.updateWithOptions = function (
  user,
  query,
  updatedData,
  options,
  callback
) {
  this.database.updateWithOptions(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    this.applyUpdateToDB(updatedData),
    options,
    callback
  );
};

/* jshint -W024, -W098 */
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
BaseStorage.prototype.delete = function(user, query, callback) {
  callback( new Error('Not implemented (user: ' + user + ')') );
  // a line like this could work when/if Mongo ever supports "replacement" update on multiple docs:
  //this.database.update(this.getCollectionInfo(user), this.applyQueryToDB(query),
  //    {deleted: new Date()}, callback);
};

BaseStorage.prototype.removeOne = function(user, query, callback) {
  this.database.deleteOne(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    callback
  );
};

BaseStorage.prototype.removeMany = function(user, query, callback) {
  this.database.deleteMany(
    this.getCollectionInfo(user),
    this.applyQueryToDB(query),
    callback
  );
};

BaseStorage.prototype.removeAll = function(user, callback) {
  this.database.deleteMany(
    this.getCollectionInfo(user),
    this.applyQueryToDB({}),
    callback
  );
};

BaseStorage.prototype.dropCollection = function(user, callback) {
  this.database.dropCollection(this.getCollectionInfo(user), callback);
};

// for tests only (at the moment)

/**
 * For tests only.
 */
BaseStorage.prototype.findAll = function(user, options, callback) {
  this.database.find(
    this.getCollectionInfo(user),
    this.applyQueryToDB({}),
    this.applyOptionsToDB(options),
    function(err, dbItems) {
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
BaseStorage.prototype.insertMany = function(user, items, callback) {
  this.database.insertMany(
    this.getCollectionInfo(user),
    this.applyItemsToDB(items),
    callback
  );
};

/**
 * Gets the total size of the collection, in bytes.
 *
 * @param {Object} user
 * @param {Function} callback
 */
BaseStorage.prototype.getTotalSize = function(user, callback) {
  this.database.totalSize(this.getCollectionInfo(user), callback);
};

/**
 * Gets the indexes set for the collection.
 *
 * @param {Object} user
 * @param {Object} options
 * @param {Function} callback
 */
BaseStorage.prototype.listIndexes = function(user, options, callback) {
  this.database.listIndexes(this.getCollectionInfo(user), options, callback);
};

// converters application functions

/**
 * @api private
 */
BaseStorage.prototype.applyItemDefaults = function(item) {
  // no cloning! we do want to alter the original object
  return applyConverters(item, this.converters.itemDefaults);
};

/**
 * @api private
 */
BaseStorage.prototype.applyQueryToDB = function(query) {
  this.addIdConvertion();
  return applyConvertersToDB(_.clone(query), this.converters.queryToDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyOptionsToDB = function(options) {
  const dbOptions = _.defaults(
    options ? _.clone(options) : {},
    this.defaultOptions
  );

  if (dbOptions.fields != null) 
    throw new Error("AF: fields key is deprecated; we're not using it anymore.");

  if (dbOptions.projection != null)
    dbOptions.projection = applyConvertersToDB(
      dbOptions.projection,
      this.converters.fieldsToDB);

  dbOptions.sort = applyConvertersToDB(
    dbOptions.sort,
    this.converters.fieldsToDB);

  return dbOptions;
};

/**
 *  @api private
 *  Add needed converters when this.converters.convertIdToItemId
 */
BaseStorage.prototype.addIdConvertion = function() {
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
BaseStorage.prototype.applyItemToDB = function(item) {
  this.addIdConvertion();
  return applyConvertersToDB(_.clone(item), this.converters.itemToDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemsToDB = function(items) {
  return applyConvertersToDB(items.slice(), this.converters.itemsToDB).map(
    this.applyItemToDB.bind(this)
  );
};

/**
 * @api private
 */
BaseStorage.prototype.applyUpdateToDB = function(updatedData) {
  const input = _.cloneDeep(updatedData);
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
  
  // Maybe add more of these?
  //    https://docs.mongodb.com/manual/reference/operator/update/
  data.$set = input;
  data.$unset = {};       // code in 'converters.js' depends on this.
  
  var dbUpdate = applyConvertersToDB(
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
BaseStorage.prototype.applyItemFromDB = function(dbItem) {
  this.addIdConvertion();
  return applyConvertersFromDB(dbItem, this.converters.itemFromDB);
};

/**
 * @api private
 */
BaseStorage.prototype.applyItemsFromDB = function(dbItems) {

  return applyConvertersFromDB(
    dbItems.map(this.applyItemFromDB.bind(this)),
    this.converters.itemsFromDB
  );
};

const idToDB = converters.getRenamePropertyFn('id', '_id');
const idFromDB = converters.getRenamePropertyFn('_id', 'id');

function applyConvertersToDB(object, converterFns) {
  return idToDB(applyConverters(object, converterFns));
}

function applyConvertersFromDB(object, converterFns) {
  if (object) {
    if (object.constructor == Array) {
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

function applyConverters(object, converterFns) {
  converterFns.forEach(function(fn) {
    object = fn(object);
  });
  return object;
}
