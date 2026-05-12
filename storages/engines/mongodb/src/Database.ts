/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const MongoClient = require('mongodb').MongoClient;
const { setTimeout } = require('timers/promises');

const { _internals } = require('./_internals.ts');

// mongodb@5+ removed the callback-based driver API; everything is Promise-only.
// The Database class still exposes a callback shape to the rest of the codebase,
// so we wrap each driver call. `p2c` is the plain Promise→callback bridge;
// `p2cWithDup` adds the duplicate-key annotation that several mutation paths
// rely on (`err.isDuplicate`, `err.isDuplicateIndex`).
function p2c (promise: any, callback: any) {
  promise.then(
    (res: any) => callback(null, res),
    (err: any) => callback(err)
  );
}
function p2cWithDup (promise: any, callback: any) {
  promise.then(
    (res: any) => callback(null, res),
    (err: any) => {
      Database.handleDuplicateError(err);
      callback(err);
    }
  );
}

type DatabaseOptions = {
  writeConcern: {
  j?: boolean;
  w?: number;
  };
  autoReconnect?: boolean;
  connectTimeoutMS?: number;
  socketTimeoutMS?: number;
};
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

  connecting;
  db: any;
  client: any;

  initializedCollections: any;
  collectionConnectionsCache: any;

  logger;

  constructor (settings: any) {
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

  addUserIdToIndexIfNeeded (collectionInfo: any) {
    // force all indexes to have userId -- ! Order is important
    if (collectionInfo.useUserId) {
      const newIndexes = [{ index: { userId: 1 }, options: {} }];
      for (let i = 0; i < collectionInfo.indexes.length; i++) {
        const tempIndex: any = { userId: 1 };
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
   */
  async getCollection (collectionInfo: any) {
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
   */
  async ensureIndexes (collection: any, indexes: any) {
    const initializedCollections: any = this.initializedCollections;
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
  getCollectionSafe (collectionInfo: any, errCallback: any, collCallback: any) {
    this.getCollection(collectionInfo).then(collCallback, errCallback);
  }

  /**
   * Counts all documents in the collection.
   * @param collectionInfo  undefined
   * @param callback  undefined
   */
  countAll (collectionInfo: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    if (collectionInfo.useUserId) {
      return this.count(collectionInfo, {}, callback);
    }
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2c(collection.countDocuments(), callback);
    });
  }

  /**
   * Add User Id to Object or To all Items of an Array
   *
   * @param collectionInfo  undefined
   */
  addUserIdIfneed (collectionInfo: any, mixed: any) {
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
    function addUserIdProperty (object: any) {
      object.userId = collectionInfo.useUserId;
    }
  }

  /**
   * Counts documents matching the given query.
   *
   * @param collectionInfo  undefined
   * @param query  undefined
   * @param callback  undefined
   */
  count (collectionInfo: any, query: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2c(collection.countDocuments(query), callback);
    });
  }

  /**
   * Finds all documents matching the given query.
   *
   * @param collectionInfo  undefined
   * @param query  Mongo-style query
   * @param options  Properties:
   * {Object} projection Mongo-style fields inclusion/exclusion definition
   * {Object} sort Mongo-style sorting definition
   * {Number} skip Number of records to skip (or `null`)
   * {Number} limit Number of records to return (or `null`)
   * @param callback  undefined
   */
  findCursor (collectionInfo: any, query: any, options: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
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
   * @param collectionInfo  undefined
   * @param query  Mongo-style query
   * @param options  Properties:
   * {Object} projection Mongo-style fields inclusion/exclusion definition
   * {Object} sort Mongo-style sorting definition
   * {Number} skip Number of records to skip (or `null`)
   * {Number} limit Number of records to return (or `null`)
   * @param callback  undefined
   */
  find (collectionInfo: any, query: any, options: any, callback: any) {
    this.findCursor(collectionInfo, query, options, (err: any, cursor: any) => {
      if (err) { return callback(err); }
      p2c(cursor.toArray(), callback);
    });
  }

  /**
   * Finds all documents matching the given query and returns a readable stream.
   *
   * @param collectionInfo  undefined
   * @param query  Mongo-style query
   * @param options  Properties:
   * {Object} projection Mongo-style fields inclusion/exclusion definition
   * {Object} sort Mongo-style sorting definition
   * {Number} skip Number of records to skip (or `null`)
   * {Number} limit Number of records to return (or `null`)
   * @param callback  undefined
   */
  /**
   * Finds the first document matching the given query.
   *
   * @param collectionInfo  undefined
   * @param query  Mongo-style query
   * @param options  Mongo-style options
   * @param callback  undefined
   */
  findOne (collectionInfo: any, query: any, options: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2c(collection.findOne(query, options || {}), callback);
    });
  }

  /**
   * Inserts a single item (must have a valid id).
   *
   * @param collectionInfo  undefined
   * @param item  undefined
   * @param callback  undefined
   */
  insertOne (collectionInfo: any, item: any, callback: any, options = {}) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, item);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2cWithDup(collection.insertOne(item, options), callback);
    });
  }

  /**
   * Inserts an array of items (each item must have a valid id already).
   */
  insertMany (collectionInfo: any, items: any, callback: any, options = {}) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, items);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2cWithDup(collection.insertMany(items, options), callback);
    });
  }

  /**
   * Applies the given update to the document matching the given query.
   * Does *not* return the document.
   *
   * @param collectionInfo  undefined
   * @param query  undefined
   * @param update  undefined
   * @param callback  undefined
   */
  updateOne (collectionInfo: any, query: any, update: any, callback: any, options = {}) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2cWithDup(collection.updateOne(query, update, options), callback);
    });
  }

  /**
   * Applies the given update to the document(s) matching the given query.
   * Does *not* return the document(s).
   *
   * @param collectionInfo  undefined
   * @param query  undefined
   * @param update  undefined
   * @param callback  undefined
   */
  updateMany (collectionInfo: any, query: any, update: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2c(collection.updateMany(query, update, {}), callback);
    });
  }

  /**
   * Execute N requests directly on the DB
   */
  async bulkWrite (collectionInfo: any, requests: any) {
    const collection = await this.getCollection(collectionInfo);
    return await collection.bulkWrite(requests);
  }

  /**
   * Applies the given update to the document matching the given query, returning the updated
   * document.
   *
   * @param collectionInfo  undefined
   * @param query  undefined
   * @param update  undefined
   * @param callback  undefined
   */
  findOneAndUpdate (collectionInfo: any, query: any, update: any, callback: any) {
    if (collectionInfo.name === 'streams') { tellMeIfStackDoesNotContains(['localUserStreams.js', 'callbackIntegrity'], { for: collectionInfo.name }); }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      // mongodb v6+ returns the updated doc directly (no `.value` wrapper).
      collection.findOneAndUpdate(query, update, { returnDocument: 'after' }).then(
        (r: any) => callback(null, r),
        (err: any) => {
          Database.handleDuplicateError(err);
          callback(err);
        }
      );
    });
  }

  /**
   * Inserts or update the document matching the query.
   *
   * @param collectionInfo  undefined
   * @param query  undefined
   * @param update  undefined
   * @param callback  undefined
   */
  upsertOne (collectionInfo: any, query: any, update: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreamss.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2c(collection.updateOne(query, update, { upsert: true }), callback);
    });
  }

  /**
   * Deletes the document matching the given query.
   *
   * @param collectionInfo  undefined
   * @param query  undefined
   * @param callback  undefined
   */
  deleteOne (collectionInfo: any, query: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2c(collection.deleteOne(query, {}), callback);
    });
  }

  /**
   * Deletes the document(s) matching the given query.
   *
   * @param collectionInfo  undefined
   * @param query  undefined
   * @param callback  undefined
   */
  deleteMany (collectionInfo: any, query: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    this.addUserIdIfneed(collectionInfo, query);
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2c(collection.deleteMany(query, {}), callback);
    });
  }

  /**
   * @param callback  *
   */
  dropCollection (collectionInfo: any, callback: any) {
    if (collectionInfo.name === 'streams') {
      tellMeIfStackDoesNotContains(['localUserStreams.js'], {
        for: collectionInfo.name
      });
    }
    if (collectionInfo.useUserId) {
      return this.deleteMany(collectionInfo, {}, callback);
    } else {
      return this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
        p2c(collection.drop(), callback);
      });
    }
  }

  /**
   * Drops the actual MongoDB collection (including indexes).
   * Primarily for tests when indexes need to be recreated.
   */
  async dropCollectionFully (collectionInfo: any, callback: any) {
    try {
      await this.ensureConnect();
      // Clear caches so indexes will be recreated on next access
      delete this.initializedCollections[collectionInfo.name];
      delete this.collectionConnectionsCache[collectionInfo.name];
      // Get collection directly without creating indexes
      const collection = this.db.collection(collectionInfo.name);
      collection.drop().then(
        () => callback(null),
        (err: any) => {
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
   * @param callback  undefined
   */
  dropDatabase (callback: any) {
    this.ensureConnect().then(() => {
      p2c(this.db.dropDatabase(), callback);
    }, callback);
  }

  /**
   * Primarily meant for tests
   *
   * @param collectionInfo  undefined
   * @param options  undefined
   * @param callback  undefined
   */
  listIndexes (collectionInfo: any, options: any, callback: any) {
    this.getCollectionSafe(collectionInfo, callback, (collection: any) => {
      p2c(collection.listIndexes(options).toArray(), callback);
    });
  }

  // class utility functions
  /** @static
   * @param {MongoDBError | null} err
   * @returns {boolean}
   */
  static isDuplicateError (err: any) {
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
  static handleDuplicateError (err: any) {
    err.isDuplicate = Database.isDuplicateError(err);
    err.isDuplicateIndex = (key: any) => {
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
  async close () {
    return this.client.close();
  }

  async startSession () {
    const session = this.client.startSession();
    return session;
  }
}

export { Database };
type MongoDBError = {
  errmsg?: string;
  code?: number;
  lastErrorObject?: MongoDBError;
  isDuplicate?: boolean;
  isDuplicateIndex?: (key: string) => boolean;
  getDuplicateSystemStreamId?: () => string;
};
// Collection is the mongodb driver type, not imported as TS type here.
type CollectionCallback = (coll: any) => unknown;
type CollectionInfo = {
  name: string;
  indexes?: Array<IndexDefinition>;
};
type IndexDefinition = {
  index: {
  [field: string]: number;
  };
  options: IndexOptions;
};
type IndexOptions = {
  unique?: boolean;
};
type FindOptions = {
  projection: {
  [key: string]: 0 | 1;
  };
  sort: any;
  skip: number | undefined | null;
  limit: number | undefined | null;
};
function getAuthPart (settings: any) {
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

function tellMeIfStackDoesNotContains (needles: any, info: any) {
  const e = new Error();
  const stack = (e.stack ?? '')
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
