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

/**
 * Local Data Store.
 */
const storage = require('../index');
const ds = require('@pryv/datastore');
const SystemStreamsSerializer = require('business/src/system-streams/serializer'); // loaded just to init upfront
const userStreams = require('../localDataStore/localUserStreams');
const userEvents = require('./localUserEventsSQLite');
const LocalTransaction = require('../localDataStore/LocalTransaction');
const { getStorage } = require('../userSQLite');
const { getEventFiles } = require('../eventFiles/getEventFiles');

module.exports = ds.createDataStore({

  async init (params) {
    this.settings = params.settings;

    await SystemStreamsSerializer.init();
    const database = await storage.getDatabase();

    // init events
    const eventFilesStorage = await getEventFiles();

    const userStorage = await getStorage('local');
    userEvents.init(userStorage, eventFilesStorage, this.settings, params.integrity.setOnEvent);
    eventFilesStorage.attachToEventStore(userEvents, params.integrity.setOnEvent);

    // init streams
    const streamsCollection = await database.getCollection({ name: 'streams' });
    // TODO: clarify why we don't create indexes for streams as done in `localDataStore`
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

  async deleteUser (uid) {
    await userStreams._deleteUser(uid);
    await userEvents._deleteUser(uid);
  },

  async getUserStorageInfos (uid) {
    // TODO: ultimately here we should simply look at the DB file size
    const streams = await userStreams._getStorageInfos(uid);
    const events = await userEvents._getStorageInfos(uid);
    const files = await userEvents._getFilesStorageInfos(uid);
    return { streams, events, files };
  }
});
