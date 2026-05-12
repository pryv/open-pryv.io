/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const timestamp = require('unix-timestamp');
const { Readable } = require('stream');
const { localStorePrepareQuery } = require('storage/src/localStoreEventQueries.ts');

let keyValueData: any;

/**
 * Dummy data store serving predictable static data.
 */
const dummyDataStore: any = ds.createDataStore({
  async init (params: any) {
    keyValueData = params.storeKeyValueData;
    this.streams = createUserStreams();
    this.events = createUserEvents();
    return this;
  },

  async deleteUser (userId: any) {},

  async getUserStorageInfos (userId: any) { return { }; }
});
export default dummyDataStore;

function createUserStreams () {
  return ds.createUserStreams({
    async get (userId: any, query: any) {
      if (query.parentId === '*' || query.parentId == null) {
        return genStreams(userId);
      }
      const parent = await this.getOne(userId, query.parentId, query);
      if (parent == null) return [];
      return parent.children;
    },

    async getOne (userId: any, streamId: any, query: any) {
      // store last call in keyValueStore for tests
      await keyValueData.set(userId, 'lastStreamCall', Object.assign({ id: streamId }, query));
      const stream = findStream(streamId, genStreams(userId));
      return stream;
    },

    async create (userId: any, streamData: any) {
      if (streamData.id !== 'fluffy') throw ds.errors.unsupportedOperation('streams.create');
      const newStream = structuredClone(streamData);
      newStream.name = 'Bluppy';
      return newStream;
    },

    async update (userId: any, streamData: any) {
      const newStream = structuredClone(streamData);
      newStream.name = 'Bluppy';
      return newStream;
    }

  });

  function findStream (streamId: any, streams: any): any {
    for (const stream of streams) {
      if (stream.id === streamId) {
        return stream;
      }
      if (stream.children) {
        const found: any = findStream(streamId, stream.children);
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
    async getStreamed (userId: any, query: any, options: any) {
      const events = await this.get(userId, query, options);
      const readable = Readable.from(events);
      return readable;
    },

    async create (userId: any, eventData: any) {
      const event = structuredClone(eventData);
      event.content = 'Received';
      delete event.integrity;
      ds.defaults.applyOnEvents([event]);
      return event;
    },

    async update (userId: any, eventData: any) {
      const event = structuredClone(eventData);
      event.content = 'Updated';
      delete event.integrity;
      ds.defaults.applyOnEvents([event]);
      return event;
    },

    async getOne (userId: any, eventId: any) {
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
    async get (userId: any, storeQuery: any, options: any) {
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
      const streamQuery = query.filter((i: any) => { return i.type === 'streamsQuery'; });
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
function genStreams (userId: any) {
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
