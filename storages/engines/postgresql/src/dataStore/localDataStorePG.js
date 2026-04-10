/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL Data Store.
 * Implements the @pryv/datastore DataStore interface.
 */
const ds = require('@pryv/datastore');
const _internals = require('../_internals');
const userStreams = require('./localUserStreamsPG');
const userEvents = require('./localUserEventsPG');
const LocalTransactionPG = require('./LocalTransactionPG');

module.exports = ds.createDataStore({

  async init (params) {
    this.settings = params.settings;

    // Get the shared DatabasePG instance
    const db = _internals.databasePG;

    // Init events
    const eventFilesStorage = await _internals.getEventFiles();
    userEvents.init(db, eventFilesStorage, this.settings, params.integrity.setOnEvent, params.systemStreams);
    eventFilesStorage.attachToEventStore(userEvents, params.integrity.setOnEvent);

    // Init streams — reuses StorageLayer's StreamsPG via the same pattern as MongoDB
    const userStreamsStorage = _internals.storageLayer.streams;
    userStreams.init(userStreamsStorage);

    return this;
  },

  streams: userStreams,

  events: userEvents,

  async newTransaction () {
    const transaction = new LocalTransactionPG(_internals.databasePG);
    await transaction.init();
    return transaction;
  },

  async deleteUser (userId) {
    await userStreams._deleteUser(userId);
    await userEvents._deleteUser(userId);
  },

  async getUserStorageInfos (userId) {
    const streams = await userStreams._getStorageInfos(userId);
    const events = await userEvents._getStorageInfos(userId);
    const files = await userEvents._getFilesStorageInfos(userId);
    return { streams, events, files };
  }
});
