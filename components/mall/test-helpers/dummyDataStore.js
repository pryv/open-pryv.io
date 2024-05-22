/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

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

  async deleteUser (userId) {}, // eslint-disable-line no-unused-vars

  async getUserStorageInfos (userId) { return { }; } // eslint-disable-line no-unused-vars
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
    async get (userId, storeQuery, options) { // eslint-disable-line no-unused-vars
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
