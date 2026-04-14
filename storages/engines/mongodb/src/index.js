/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * MongoDB storage engine plugin.
 *
 * Provides factories for all MongoDB-backed storage types.
 * Currently delegates to existing component implementations;
 * code will be physically moved here in a later cleanup phase.
 */

const bluebird = require('bluebird');
const _internals = require('./_internals');

/**
 * Receive host internals from the barrel.
 * Populates the engine-local _internals registry so that all engine
 * files can access host capabilities without direct require() calls.
 * @param {Object} config - Engine-specific configuration from manifest configKey
 * @param {Function} getLogger - Logger factory
 * @param {Object} internals - Map of name → value (remaining host internals)
 */
function init (config, getLogger, internals) {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

/**
 * Initialize a StorageLayer with MongoDB backends.
 * @param {Object} storageLayer - StorageLayer instance to populate
 * @param {Object} connection - MongoDB Database instance
 * @param {Object} options - { passwordResetRequestMaxAge, sessionMaxAge }
 */
function initStorageLayer (storageLayer, connection, options) {
  const PasswordResetRequests = require('./PasswordResetRequests');
  const Sessions = require('./Sessions');
  const Accesses = require('./user/Accesses');
  const Profile = require('./user/Profile');
  const Streams = require('./user/Streams');
  const Webhooks = require('./user/Webhooks');

  storageLayer.connection = connection;
  storageLayer.passwordResetRequests = new PasswordResetRequests(connection, {
    maxAge: options.passwordResetRequestMaxAge
  });
  storageLayer.sessions = new Sessions(connection, { maxAge: options.sessionMaxAge });
  storageLayer.accesses = new Accesses(connection, options.integrityAccesses);
  storageLayer.profile = new Profile(connection);
  storageLayer.streams = new Streams(connection);
  storageLayer.webhooks = new Webhooks(connection);

  // Events import/clear for backup restore (not used in normal operation —
  // normal event CRUD goes through the DataStore/Mall layer).
  storageLayer.events = {
    importAll (userOrUserId, items, callback) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      if (!items || items.length === 0) return callback(null);
      const docs = items.map(item => {
        const doc = Object.assign({}, item);
        doc._id = doc.id;
        delete doc.id;
        doc.userId = userId;
        return doc;
      });
      connection.insertMany({ name: 'events' }, docs, callback);
    },
    clearAll (userOrUserId, callback) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      connection.deleteMany({ name: 'events' }, { userId }, callback);
    }
  };

  storageLayer.iterateAllEvents = async function * () {
    const cursor = await bluebird.fromCallback(cb =>
      connection.findCursor({ name: 'events' }, {}, {}, cb)
    );
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      doc.id = doc._id;
      delete doc._id;
      delete doc.userId;
      yield doc;
    }
  };

  storageLayer.getAllUserIdsFromCollection = async function (collectionName) {
    const collection = await connection.getCollection({ name: collectionName });
    return await collection.distinct('userId', {});
  };

  storageLayer.clearCollection = async function (collectionName) {
    await bluebird.fromCallback((cb) => connection.deleteMany({ name: collectionName }, {}, cb));
  };
}

/**
 * @returns {Object} userAccountStorage module
 */
function getUserAccountStorage () {
  return require('./userAccountStorage');
}

/**
 * @returns {Function} UsersLocalIndex constructor
 */
function getUsersLocalIndex () {
  return require('./usersLocalIndex');
}

// -- DataStore ----------------------------------------------------------

/**
 * @returns {Object} datastore module for mall
 */
function getDataStoreModule () {
  return require('./dataStore');
}

// -- PlatformStorage ----------------------------------------------------

/**
 * @returns {Object} PlatformDB instance (not yet init'd)
 */
function createPlatformDB () {
  const DB = require('./DBmongodb');
  return new DB();
}

module.exports = {
  init,
  initStorageLayer,
  getUserAccountStorage,
  getUsersLocalIndex,
  getDataStoreModule,
  createPlatformDB
};
