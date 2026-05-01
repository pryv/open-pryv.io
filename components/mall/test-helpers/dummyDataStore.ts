/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

const ds = require('@pryv/datastore');
const timestamp = require('unix-timestamp');
const { Readable } = require('stream');
const { localStorePrepareQuery } = require('storage/src/localStoreEventQueries');

let keyValueData;

/**
 * Dummy data store serving predictable static data.
 */
module.exports = ds.createDataStore({
  async init (params) {
    keyValueData = params.storeKeyValueData;
    this.streams = createUserStreams();
    this.events = createUserEvents();
    return this;
  },

  async deleteUser (userId) {},

  async getUserStorageInfos (userId) { return { }; }
});

function createUserStreams () {
  return ds.createUserStreams({
    async get (userId, query) {
      if (query.parentId === '*' || query.parentId == null) {
        return genStreams(userId);
      }
      const parent = await this.getOne(userId, query.parentId, query);
      if (parent == null) return [];
      return parent.children;
    },

    async getOne (userId, streamId, query) {
      // store last call in keyValueStore for tests
      await keyValueData.set(userId, 'lastStreamCall', Object.assign({ id: streamId }, query));
      const stream = findStream(streamId, genStreams(userId));
      return stream;
    },

    async create (userId, streamData) {
      if (streamData.id !== 'fluffy') throw ds.errors.unsupportedOperation('streams.create');
      const newStream = structuredClone(streamData);
      newStream.name = 'Bluppy';
      return newStream;
    },

    async update (userId, streamData) {
      const newStream = structuredClone(streamData);
      newStream.name = 'Bluppy';
      return newStream;
    }

  });

  function findStream (streamId, streams) {
    for (const stream of streams) {
      if (stream.id === streamId) {
        return stream;
      }
      if (stream.children) {
        const found = findStream(streamId, stream.children);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }
}

function createUserEvents () {
  return ds.createUserEvents({
    async getStreamed (userId, query, options) {
      const events = await this.get(userId, query, options);
      const readable = Readable.from(events);
      return readable;
    },

    async create (userId, eventData) {
      const event = structuredClone(eventData);
      event.content = 'Received';
      delete event.integrity;
      ds.defaults.applyOnEvents([event]);
      return event;
    },

    async update (userId, eventData) {
      const event = structuredClone(eventData);
      event.content = 'Updated';
      delete event.integrity;
      ds.defaults.applyOnEvents([event]);
      return event;
    },

    async getOne (userId, eventId) {
      if (eventId !== 'dummyevent0') throw ds.errors.invalidItemId('Unkown event', { eventId });
      const event = {
        id: 'dummyevent0',
        type: 'note/txt',
        streamIds: ['mariana'],
        content: 'hello',
        time: timestamp.now()
      };
      ds.defaults.applyOnEvents([event]);
      return event;
    },

    /**
     * @returns Array
     */
    async get (userId, storeQuery, options) {
      const query = localStorePrepareQuery(storeQuery);
      const lastStreamCall = await keyValueData.get(userId, 'lastStreamCall');
      let events = [{
        id: 'dummyevent0',
        type: 'note/txt',
        streamIds: ['mariana'],
        content: 'hello',
        time: timestamp.now()
      }, {
        id: 'laststreamcall',
        type: 'data/json',
        streamIds: ['antonia'],
        content: lastStreamCall,
        time: timestamp.now()
      }];

      // support stream filtering (only for one "any")
      const streamQuery = query.filter((i) => { return i.type === 'streamsQuery'; });
      if (streamQuery.length > 0 && streamQuery[0].content[0]) {
        const firstOrItem = streamQuery[0].content[0];
        const anyStreamList = firstOrItem[0]?.any || [];
        events = events.filter((e) => anyStreamList.includes(e.streamIds[0]));
      }
      ds.defaults.applyOnEvents(events);
      return events;
    }
  });
}

/**
 * create a set of streams with a rootstream named with the userId;
 * */
function genStreams (userId) {
  const streams = [
    {
      id: 'myself',
      name: userId,
      children: [
        {
          id: 'mariana',
          name: 'Mariana'
        },
        {
          id: 'antonia',
          name: 'Antonia'
        }
      ]
    }];
  ds.defaults.applyOnStreams(streams);
  return streams;
}
