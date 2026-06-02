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

type KVStore = {
  set (userId: string, key: string, value: unknown): Promise<unknown>;
  get (userId: string, key: string): Promise<unknown>;
};
type Stream = { id: string; name?: string; children?: Stream[]; [k: string]: unknown };
type Event = { id: string; type: string; streamIds: string[]; content: unknown; time: number; integrity?: string; [k: string]: unknown };
type StreamQuery = { parentId?: string | null; [k: string]: unknown };
type QueryItem = { type?: string; content?: unknown[]; [k: string]: unknown };

let keyValueData: KVStore;

/**
 * Dummy data store serving predictable static data.
 */
const dummyDataStore = ds.createDataStore({
  async init (params: { storeKeyValueData: KVStore }) {
    keyValueData = params.storeKeyValueData;
    this.streams = createUserStreams();
    this.events = createUserEvents();
    return this;
  },

  async deleteUser (_userId: string) {},

  async getUserStorageInfos (_userId: string) { return { }; }
});
export default dummyDataStore;

function createUserStreams () {
  return ds.createUserStreams({
    async get (userId: string, query: StreamQuery) {
      if (query.parentId === '*' || query.parentId == null) {
        return genStreams(userId);
      }
      const parent = await this.getOne(userId, query.parentId, query);
      if (parent == null) return [];
      return parent.children;
    },

    async getOne (userId: string, streamId: string, query: StreamQuery) {
      // store last call in keyValueStore for tests
      await keyValueData.set(userId, 'lastStreamCall', Object.assign({ id: streamId }, query));
      const stream = findStream(streamId, genStreams(userId));
      return stream;
    },

    async create (_userId: string, streamData: Stream) {
      if (streamData.id !== 'fluffy') throw ds.errors.unsupportedOperation('streams.create');
      const newStream = structuredClone(streamData);
      newStream.name = 'Bluppy';
      return newStream;
    },

    async update (_userId: string, streamData: Stream) {
      const newStream = structuredClone(streamData);
      newStream.name = 'Bluppy';
      return newStream;
    }

  });

  function findStream (streamId: string, streams: Stream[]): Stream | null {
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
    async getStreamed (userId: string, query: unknown, options: unknown) {
      const events = await this.get(userId, query, options);
      const readable = Readable.from(events);
      return readable;
    },

    async create (_userId: string, eventData: Event) {
      const event = structuredClone(eventData);
      event.content = 'Received';
      delete event.integrity;
      ds.defaults.applyOnEvents([event]);
      return event;
    },

    async update (_userId: string, eventData: Event) {
      const event = structuredClone(eventData);
      event.content = 'Updated';
      delete event.integrity;
      ds.defaults.applyOnEvents([event]);
      return event;
    },

    async getOne (_userId: string, eventId: string) {
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
    async get (userId: string, storeQuery: unknown, _options: unknown) {
      const query = localStorePrepareQuery(storeQuery) as QueryItem[];
      const lastStreamCall = await keyValueData.get(userId, 'lastStreamCall');
      let events: Event[] = [{
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
      const streamQuery = query.filter((i: QueryItem) => { return i.type === 'streamsQuery'; });
      if (streamQuery.length > 0 && streamQuery[0].content?.[0]) {
        const firstOrItem = streamQuery[0].content![0] as Array<{ any?: string[] }>;
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
function genStreams (userId: string): Stream[] {
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
