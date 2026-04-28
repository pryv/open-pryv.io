/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const MongoClient = require('mongodb').MongoClient;
const { setTimeout } = require('timers/promises');

const _internals = require('./_internals');

// mongodb@5+ removed the callback-based driver API; everything is Promise-only.
// The Database class still exposes a callback shape to the rest of the codebase,
// so we wrap each driver call. `p2c` is the plain Promise→callback bridge;
// `p2cWithDup` adds the duplicate-key annotation that several mutation paths
// rely on (`err.isDuplicate`, `err.isDuplicateIndex`).
function p2c (promise, callback) {
  promise.then(
    (res) => callback(null, res),
    (err) => callback(err)
  );
}
function p2cWithDup (promise, callback) {
  promise.then(
    (res) => callback(null, res),
    (err) => {
      Database.handleDuplicateError(err);
      callback(err);
    }
  );
}

/**
 * @typedef {{
 *   writeConcern: {
 *     j?: boolean;
 *     w?: number;
 *   };
 *   autoReconnect?: boolean;
 *   connectTimeoutMS?: number;
 *   socketTimeoutMS?: number;
 * }} DatabaseOptions
 */

/**
 * Handles actual interaction with the Mongo database.
 * It handles Mongo-specific tasks such as connecting, retrieving collections and applying indexes,
 * exposing data querying and manipulation methods.
 *
 * All exposed methods expect a "collection info" object with properties `name` and `indexes`, e.g.
 *    {
 *      name: 'collection-name',
 *      indexes: [
 *        { index: {'field-1': 1}, options: {unique: true} },
 *        { index: {'field-2': 1}, options: {} }
 *      ]
 *    }
 *
 */
class Database {
  connectionString;
  databaseName;
  options;

  /**
   * @type {boolean}
   */
  connecting;
  db;
  client;

  initializedCollections;

  logger;

  constructor (settings) {
    const authPart = getAuthPart(settings);
    this.logger = _internals.getLogger('database');
    this.connectionString = `mongodb://${authPart}${settings.host}:${settings.port}/`;
    this.databaseName = settings.name;
    this.options = {
      writeConcern: {
        j: true,
        w: 1 // Requests acknowledgement that the write operation has propagated.
      },
      connectTimeoutMS: settings.connectTimeoutMS,
      socketTimeoutMS: settings.socketTimeoutMS,
      appname: 'pryv.io core'
    };
    this.db = null;
    this.connecting = false;
    this.initializedCollections = {};
    this.collectionConnectionsCache = {};
  }

  /**
   * Waits until DB engine is up. For use at startup.
   * @returns {Promise<void>}
   */
  async waitForConnection () {
    let connected = false;
    while (!connected) {
      try {
        await this.ensureConnect();
        connected = true;
      } catch (err) {
        this.logger.warn('Cannot connect to ' + this.connectionString + ', retrying in a sec');
        await setTimeout(1000);
        continue;
      }
    }
  }

  /**
   * @private
   * @returns {Promise<void>}
   */
  async ensureConnect () {
    while (this.connecting) {
      this.logger.debug('Connection already in progress, retrying…');
      await setTimeout(100);
    }

    if (this.db) { return; }

    this.connecting = true;
    this.logger.debug('Connecting to ' + this.connectionString);
    this.client = new MongoClient(this.connectionString, this.options);
    try {
      await this.client.connect();
      this.logger.debug('Connected');
      // We previously called `setFeatureCompatibilityVersion: '6.0'` here to
      // pin the server's feature set. Since MongoDB 7.0 the server requires
      // `{confirm: true}` on this admin command (and earlier servers reject
      // that flag with "unknown field"). Server FCV is an operator concern,
      // not an application boot concern — let the deployment manage it.
      this.db = this.client.db(this.databaseName);
      this.connecting = false;
    } catch (err) {
      this.logger.debug(err);
      this.connecting = false;
      throw err;
    }
  }

  /**
   * @returns {any}
   */
  addUserIdToIndexIfNeeded (collectionInfo) {
    // force all indexes to have userId -- ! Order is important
    if (collectionInfo.useUserId) {
      const newIndexes = [{ index: { userId: 1 }, options: {} }];
      for (let i = 0; i < collectionInfo.indexes.length; i++) {
        const tempIndex = { userId: 1 };
        for (const property in collectionInfo.indexes[i].index) {
          if (collectionInfo.indexes[i].index[property] != null) {
            tempIndex[property] = collectionInfo.indexes[i].index[property];
          }
        }
        newIndexes.push({
          index: tempIndex,
          options: collectionInfo.indexes[i].options
        });
      }
      collectionInfo.indexes = newIndexes;
    }
    return collectionInfo;
  }

  /**
   * @protected
   * @param {CollectionInfo} collectionInfo
   * @returns {Promise<any>}
   */
  async getCollection (collectionInfo) {
    await this.ensureConnect();
    if (this.collectionConnectionsCache[collectionInfo.name]) {
      return this.collectionConnectionsCache[collectionInfo.name];
    }
    const collection = this.db.collection(collectionInfo.name);
    this.addUserIdToIndexIfNeeded(collectionInfo);
    await this.ensureIndexes(collection, collectionInfo.indexes);
    this.collectionConnectionsCache[collectionInfo.name] = collection;
    return collection;
  }

  /**
   * @private
   * @param {Collection} collection
   * @returns {Promise<void>}
   */
  async ensureIndexes (collection, indexes) {
    const initializedCollections = this.initializedCollections;
    const collectionName = collection.collectionName;
    if (indexes == null) { return; }
    if (initializedCollections[collectionName]) { return; }
    for (const item of indexes) {
      if (item.options.background !== false) item.options.background = true;
      await collection.createIndex(item.index, item.options);
    }
    initializedCollections[collectionName] = true;
  }

  // Internal function. Does the same job as `getCollection` above, but calls `errCallback`
  // when error would not be null. Otherwise it calls '`callback`, whose code can
  // assume that there has been no error.
  //
  // This should allow you to turn this bit of code:
  //
  //    this.getCollection(collectionInfo, (err, coll) => {
  //      if (err) return callback(err);
  //      ...
  //    }
  //
  // into this:
  //
  //    this.getCollectionSafe(collectionInfo, callback, (collection) => {
  //      ...
  //    }
  //
  /**
   * @param {CollectionInfo} collectionInfo
   * @param {DatabaseCallback} errCallback
   * @param {CollectionCallback} collCallback
   * @returns {void}
   */
  getCollectionSafe (collectionInfo, errCallback, collCallback) {
    this.getCollection(collectionInfo).then(collCallback, errCallback);
  }

  /**
   * Counts all documents in the collection.
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  countAll (collectionInfo, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    if (collectionInfo.useUserId) {
      return this.count(collectionInfo, {}, callback);
    }
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2c(collection.countDocuments(), callback);
    });
  }

  /**
   * Add User Id to Object or To all Items of an Array
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {Object|Array} mixed
   * @returns {void}
   */
  addUserIdIfneed (collectionInfo, mixed) {
    if (collectionInfo.useUserId) {
      if (mixed.constructor === Array) {
        const length = mixed.length;
        for (let i = 0; i < length; i++) {
          addUserIdProperty(mixed[i]);
        }
      } else {
        addUserIdProperty(mixed);
      }
    }
    function addUserIdProperty (object) {
      object.userId = collectionInfo.useUserId;
    }
  }

  /**
   * Counts documents matching the given query.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {{}} query  undefined
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  count (collectionInfo, query, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2c(collection.countDocuments(query), callback);
    });
  }

  /**
   * Finds all documents matching the given query.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {{}} query  Mongo-style query
   * @param {FindOptions} options  Properties:
   * {Object} projection Mongo-style fields inclusion/exclusion definition
   * {Object} sort Mongo-style sorting definition
   * {Number} skip Number of records to skip (or `null`)
   * {Number} limit Number of records to return (or `null`)
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  findCursor (collectionInfo, query, options, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      const queryOptions = {
        projection: options.projection
      };
      let cursor = collection.find(query, queryOptions).sort(options.sort);
      if (options.skip != null) {
        cursor = cursor.skip(options.skip);
      }
      if (options.limit != null) {
        cursor = cursor.limit(options.limit);
      }
      return callback(null, cursor);
    });
  }

  /**
   * Finds all documents matching the given query.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {{}} query  Mongo-style query
   * @param {FindOptions} options  Properties:
   * {Object} projection Mongo-style fields inclusion/exclusion definition
   * {Object} sort Mongo-style sorting definition
   * {Number} skip Number of records to skip (or `null`)
   * {Number} limit Number of records to return (or `null`)
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  find (collectionInfo, query, options, callback) {
    this.findCursor(collectionInfo, query, options, (err, cursor) => {
      if (err) { return callback(err); }
      p2c(cursor.toArray(), callback);
    });
  }

  /**
   * Finds all documents matching the given query and returns a readable stream.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {{}} query  Mongo-style query
   * @param {FindOptions} options  Properties:
   * {Object} projection Mongo-style fields inclusion/exclusion definition
   * {Object} sort Mongo-style sorting definition
   * {Number} skip Number of records to skip (or `null`)
   * {Number} limit Number of records to return (or `null`)
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  /**
   * Finds the first document matching the given query.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {any} query  Mongo-style query
   * @param {FindOptions} options  Mongo-style options
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  findOne (collectionInfo, query, options, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2c(collection.findOne(query, options || {}), callback);
    });
  }

  /**
   * Inserts a single item (must have a valid id).
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {any} item  undefined
   * @param {DatabaseCallback} callback  undefined
   * @param {any} options
   * @returns {void}
   */
  insertOne (collectionInfo, item, callback, options = {}) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, item);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2cWithDup(collection.insertOne(item, options), callback);
    });
  }

  /**
   * Inserts an array of items (each item must have a valid id already).
   * @param {CollectionInfo} collectionInfo
   * @param {Array<any>} items
   * @param {DatabaseCallback} callback
   * @param {any} options
   * @returns {void}
   */
  insertMany (collectionInfo, items, callback, options = {}) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, items);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2cWithDup(collection.insertMany(items, options), callback);
    });
  }

  /**
   * Applies the given update to the document matching the given query.
   * Does *not* return the document.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {any} query  undefined
   * @param {any} update  undefined
   * @param {DatabaseCallback} callback  undefined
   * @param {any} options
   * @returns {void}
   */
  updateOne (collectionInfo, query, update, callback, options = {}) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2cWithDup(collection.updateOne(query, update, options), callback);
    });
  }

  /**
   * Applies the given update to the document(s) matching the given query.
   * Does *not* return the document(s).
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {any} query  undefined
   * @param {any} update  undefined
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  updateMany (collectionInfo, query, update, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2c(collection.updateMany(query, update, {}), callback);
    });
  }

  /**
   * Execute N requests directly on the DB
   * @param {CollectionInfo} collectionInfo
   * @param {Array<any>} requests
   * @returns {Promise<any>}
   */
  async bulkWrite (collectionInfo, requests) {
    const collection = await this.getCollection(collectionInfo);
    return await collection.bulkWrite(requests);
  }

  /**
   * Applies the given update to the document matching the given query, returning the updated
   * document.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {any} query  undefined
   * @param {any} update  undefined
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  findOneAndUpdate (collectionInfo, query, update, callback) {
    if (collectionInfo.name === 'streams') { tellMeIfStackDoesNotContains(['localUserStreams.js', 'callbackIntegrity'], { for: collectionInfo.name }); }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      // mongodb v6+ returns the updated doc directly (no `.value` wrapper).
      collection.findOneAndUpdate(query, update, { returnDocument: 'after' }).then(
        (r) => callback(null, r),
        (err) => {
          Database.handleDuplicateError(err);
          callback(err);
        }
      );
    });
  }

  /**
   * Inserts or update the document matching the query.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {any} query  undefined
   * @param {any} update  undefined
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  upsertOne (collectionInfo, query, update, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreamss.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2c(collection.updateOne(query, update, { upsert: true }), callback);
    });
  }

  /**
   * Deletes the document matching the given query.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {any} query  undefined
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  deleteOne (collectionInfo, query, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2c(collection.deleteOne(query, {}), callback);
    });
  }

  /**
   * Deletes the document(s) matching the given query.
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {any} query  undefined
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  deleteMany (collectionInfo, query, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2c(collection.deleteMany(query, {}), callback);
    });
  }

  /**
   * @param {DatabaseCallback} callback  *
   * @param {CollectionInfo} collectionInfo
   * @returns {void}
   */
  dropCollection (collectionInfo, callback) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    if (collectionInfo.useUserId) {
      return this.deleteMany(collectionInfo, {}, callback);
    } else {
      return this.getCollectionSafe(collectionInfo, callback, (collection) => {
        p2c(collection.drop(), callback);
      });
    }
  }

  /**
   * Drops the actual MongoDB collection (including indexes).
   * Primarily for tests when indexes need to be recreated.
   * @param {CollectionInfo} collectionInfo
   * @param {DatabaseCallback} callback
   * @returns {void}
   */
  async dropCollectionFully (collectionInfo, callback) {
    try {
      await this.ensureConnect();
      // Clear caches so indexes will be recreated on next access
      delete this.initializedCollections[collectionInfo.name];
      delete this.collectionConnectionsCache[collectionInfo.name];
      // Get collection directly without creating indexes
      const collection = this.db.collection(collectionInfo.name);
      collection.drop().then(
        () => callback(null),
        (err) => {
          // Ignore "ns not found" error (collection doesn't exist)
          if (err && err.codeName !== 'NamespaceNotFound') return callback(err);
          callback(null);
        }
      );
    } catch (err) {
      callback(err);
    }
  }

  /**
   * Primarily meant for tests.
   *
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  dropDatabase (callback) {
    this.ensureConnect().then(() => {
      p2c(this.db.dropDatabase(), callback);
    }, callback);
  }

  /**
   * Primarily meant for tests
   *
   * @param {CollectionInfo} collectionInfo  undefined
   * @param {{}} options  undefined
   * @param {DatabaseCallback} callback  undefined
   * @returns {void}
   */
  listIndexes (collectionInfo, options, callback) {
    this.getCollectionSafe(collectionInfo, callback, (collection) => {
      p2c(collection.listIndexes(options).toArray(), callback);
    });
  }

  // class utility functions
  /** @static
   * @param {MongoDBError | null} err
   * @returns {boolean}
   */
  static isDuplicateError (err) {
    if (err == null) {
      return false;
    }
    const errorCode = err.code || (err.lastErrorObject ? err.lastErrorObject.code : null);
    return errorCode === 11000 || errorCode === 11001;
  }

  /** @static
   * @param {MongoDBError} err
   * @returns {void}
   */
  static handleDuplicateError (err) {
    err.isDuplicate = Database.isDuplicateError(err);
    err.isDuplicateIndex = (key) => {
      // Check both errmsg (older drivers) and message (newer drivers)
      const errorMessage = err?.errmsg || err?.message;
      if (err != null && errorMessage != null && err.isDuplicate) {
        // This check depends on the MongoDB storage engine
        // We assume WiredTiger here (and not MMapV1).
        const matching = errorMessage.match(/index:(.+) dup key:/);
        if (Array.isArray(matching) && matching.length >= 2) {
          const matchingKeys = matching[1];
          return (matchingKeys.includes(` ${key}`) ||
                        matchingKeys.includes(`_${key}_`));
        }
      }
      return false;
    };
  }

  /// Closes this database connection. After calling this, all other methods
  /// will produce undefined behaviour.
  ///
  /**
   * @returns {Promise<any>}
   */
  async close () {
    return this.client.close();
  }

  /**
   * @returns {Promise<any>}
   */
  async startSession () {
    const session = this.client.startSession();
    return session;
  }
}

module.exports = Database;

/**
 * @typedef {{
 *   errmsg?: string;
 *   code?: number;
 *   lastErrorObject?: MongoDBError;
 *   isDuplicate?: boolean;
 *   isDuplicateIndex?: (key: string) => boolean;
 *   getDuplicateSystemStreamId?: () => string;
 * }} MongoDBError
 */

/** @typedef {(coll: Collection) => unknown} CollectionCallback */

/**
 * @typedef {object} CollectionInfo
 * @property {string } name
 * @property {Array<IndexDefinition>} [indexes]
 */

/**
 * @typedef {{
 *   index: {
 *     [field: string]: number;
 *   };
 *   options: IndexOptions;
 * }} IndexDefinition
 */

/**
 * @typedef {{
 *   unique?: boolean;
 * }} IndexOptions
 */

/**
 * @typedef {{
 *   projection: {
 *     [key: string]: 0 | 1;
 *   };
 *   sort: any;
 *   skip: number | undefined | null;
 *   limit: number | undefined | null;
 * }} FindOptions
 */

/**
 * @returns {string}
 */
function getAuthPart (settings) {
  const authUser = settings.authUser;
  let authPart = '';
  if (authUser != null && typeof authUser === 'string' && authUser.length > 0) {
    const authPassword = settings.authPassword || '';
    // See
    //  https://github.com/mongodb/specifications/blob/master/source/connection-string/connection-string-spec.rst#key-value-pair
    //
    authPart =
            encodeURIComponent(authUser) +
                ':' +
                encodeURIComponent(authPassword) +
                '@';
  }
  return authPart;
}

/**
 * @returns {boolean}
 */
function tellMeIfStackDoesNotContains (needles, info) {
  const e = new Error();
  const stack = e.stack
    .split('\n')
    .filter((l) => l.indexOf('node_modules') < 0)
    .filter((l) => l.indexOf('node:') < 0)
    .slice(1, 100);
  for (const needle of needles) {
    if (stack.some((l) => l.indexOf(needle) >= 0)) {
      return true;
    }
  }
  console.log(info, stack);
  // throw new Error('Beep');
  return false;
}
