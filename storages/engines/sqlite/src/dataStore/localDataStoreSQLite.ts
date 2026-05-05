/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Local Data Store.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const { _internals } = require('../_internals');
const userStreams = ds.createUserStreams({});
const { userEvents } = require('./localUserEventsSQLite');
const { getStorage } = require('../userSQLite');

const dataStore = ds.createDataStore({

  async init (this: any, params: any): Promise<any> {
    this.settings = params.settings;

    // init events
    const eventFilesStorage = await _internals.getEventFiles();

    const userStorage = await getStorage('local');
    userEvents.init(userStorage, eventFilesStorage, this.settings, params.integrity.setOnEvent, params.systemStreams);
    eventFilesStorage.attachToEventStore(userEvents, params.integrity.setOnEvent);

    // streams not implemented for SQLite — stub via ds.createUserStreams({})

    return this;
  },

  streams: userStreams,

  events: userEvents,

  async deleteUser (uid: string): Promise<void> {
    // streams not implemented for SQLite — nothing to delete
    await userEvents._deleteUser(uid);
  },

  async getUserStorageInfos (uid: string): Promise<any> {
    const events = await userEvents._getStorageInfos(uid);
    const files = await userEvents._getFilesStorageInfos(uid);
    return { streams: { count: 0 }, events, files };
  }
});

export { dataStore };
