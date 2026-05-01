/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * MongoDB storage engine plugin.
 */

import type {} from 'node:fs';

const { fromCallback } = require('utils');
const _internals = require('./_internals');

/**
 * Receive host internals from the barrel.
 */
function init (config: Record<string, any>, getLogger: (name: string) => any, internals: Record<string, any>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

function initStorageLayer (storageLayer: any, connection: any, options: any): void {
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

  storageLayer.events = {
    importAll (userOrUserId: any, items: any[], callback: (err: any) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      if (!items || items.length === 0) return callback(null);
      const docs = items.map((item: any) => {
        const doc = Object.assign({}, item);
        doc._id = doc.id;
        delete doc.id;
        doc.userId = userId;
        return doc;
      });
      connection.insertMany({ name: 'events' }, docs, callback);
    },
    clearAll (userOrUserId: any, callback: (err: any) => void) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      connection.deleteMany({ name: 'events' }, { userId }, callback);
    }
  };

  storageLayer.iterateAllEvents = async function * () {
    const cursor: any = await fromCallback((cb: any) =>
      connection.findCursor({ name: 'events' }, {}, {}, cb)
    );
    while (await cursor.hasNext()) {
      const doc: any = await cursor.next();
      doc.id = doc._id;
      delete doc._id;
      delete doc.userId;
      yield doc;
    }
  };

  storageLayer.getAllUserIdsFromCollection = async function (collectionName: string): Promise<string[]> {
    const collection = await connection.getCollection({ name: collectionName });
    return await collection.distinct('userId', {});
  };

  storageLayer.clearCollection = async function (collectionName: string): Promise<void> {
    await fromCallback((cb: any) => connection.deleteMany({ name: collectionName }, {}, cb));
  };
}

function getUserAccountStorage (): any {
  return require('./userAccountStorage');
}

function getUsersLocalIndex (): any {
  return require('./usersLocalIndex');
}

// -- DataStore ----------------------------------------------------------

function getDataStoreModule (): any {
  return require('./dataStore');
}

// -- PlatformStorage ----------------------------------------------------

function createPlatformDB (): any {
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
