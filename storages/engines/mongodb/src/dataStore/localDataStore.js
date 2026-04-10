/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Local Data Store.
 */
const ds = require('@pryv/datastore');
const _internals = require('../_internals');
const userStreams = require('./localUserStreams');
const userEvents = require('./localUserEvents');
const LocalTransaction = require('./LocalTransaction');

module.exports = ds.createDataStore({

  async init (params) {
    this.settings = params.settings;
    const database = _internals.database;

    // init events
    const eventsCollection = await database.getCollection({ name: 'events' });
    // file storage
    const eventFilesStorage = await _internals.getEventFiles();

    for (const item of eventsIndexes) {
      item.options.background = true;
      await eventsCollection.createIndex(item.index, item.options);
    }
    // forward settings to userEvents
    userEvents.settings = this.settings;
    userEvents.init(eventsCollection, eventFilesStorage, params.integrity.setOnEvent, params.systemStreams);
    eventFilesStorage.attachToEventStore(userEvents, params.integrity.setOnEvent);

    // init streams
    const streamsCollection = await database.getCollection({ name: 'streams' });
    for (const item of streamIndexes) {
      item.options.background = true;
      await streamsCollection.createIndex(item.index, item.options);
    }
    const userStreamsStorage = _internals.storageLayer.streams;
    userStreams.init(streamsCollection, userStreamsStorage);

    return this;
  },

  streams: userStreams,

  events: userEvents,

  async newTransaction () {
    const transaction = new LocalTransaction();
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

const eventsIndexes = [
  {
    index: { userId: 1 },
    options: {}
  },
  {
    index: { userId: 1, _id: 1 },
    options: {}
  },
  {
    index: { userId: 1, time: 1 },
    options: {}
  },
  {
    index: { userId: 1, streamIds: 1 },
    options: {}
  },
  {
    index: { userId: 1, type: 1 },
    options: {}
  },
  // no index by content until we have more actual usage feedback
  {
    index: { userId: 1, trashed: 1 },
    options: {}
  },
  {
    index: { userId: 1, modified: 1 },
    options: {}
  },
  {
    index: { userId: 1, endTime: 1 },
    options: { partialFilterExpression: { endTime: { $exists: true } } }
  }
];

const streamIndexes = [
  {
    index: { userId: 1 },
    options: {}
  },
  {
    index: { userId: 1, streamId: 1 },
    options: { unique: true }
  },
  {
    index: { userId: 1, name: 1 },
    options: {}
  },
  {
    index: { userId: 1, name: 1, parentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        deleted: { $type: 'null' }
      }
    }
  },
  {
    index: { userId: 1, trashed: 1 },
    options: {}
  }
];
