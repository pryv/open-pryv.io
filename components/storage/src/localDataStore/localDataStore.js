/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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

/**
 * Local Data Store.
 */
const ds = require('@pryv/datastore');
const storage = require('../index');
const SystemStreamsSerializer = require('business/src/system-streams/serializer'); // loaded just to init upfront
const userStreams = require('./localUserStreams');
const userEvents = require('./localUserEvents');
const LocalTransaction = require('./LocalTransaction');

module.exports = ds.createDataStore({

  async init (params) {
    this.settings = params.settings;
    await SystemStreamsSerializer.init();
    const database = await storage.getDatabase();

    // init events
    const eventsCollection = await database.getCollection({ name: 'events' });
    const eventFilesStorage = (await storage.getStorageLayer()).eventFiles;
    for (const item of eventsIndexes) {
      item.options.background = true;
      await eventsCollection.createIndex(item.index, item.options);
    }
    // forward settings to userEvents
    userEvents.settings = this.settings;
    userEvents.init(eventsCollection, eventFilesStorage, params.integrity.setOnEvent);

    // init streams
    const streamsCollection = await database.getCollection({ name: 'streams' });
    for (const item of streamIndexes) {
      item.options.background = true;
      await streamsCollection.createIndex(item.index, item.options);
    }
    const userStreamsStorage = (await storage.getStorageLayer()).streams;
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

  async getUserStorageSize (userId) {
    const streamsSize = await userStreams._getUserStorageSize(userId);
    const eventsSize = await userEvents._getUserStorageSize(userId);
    return streamsSize + eventsSize;
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
