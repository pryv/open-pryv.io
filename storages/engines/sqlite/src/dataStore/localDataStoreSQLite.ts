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
const { _internals } = require('../_internals.ts');
const { userStreams } = require('./localUserStreamsSQLite.ts');
const { userEvents } = require('./localUserEventsSQLite.ts');
const { getStorage } = require('../userSQLite/index.ts');

/**
 * No-op transaction. SQLite per-user files serialize their own writes via
 * concurrentSafeWrite; the per-call transaction primitive PG uses
 * (LocalTransactionPG) doesn't translate cleanly to per-user-file SQLite.
 * Callers in this codebase use transactions only to chain a few writes
 * within a single dataStore call; per-call SQLite concurrent-safety
 * subsumes that. If true ACID-multi-statement is needed later,
 * LocalTransactionSQLite can be hooked in here.
 */
class NoopTransactionSQLite {
  async init () { /* noop */ }
  async commit () { /* noop */ }
  async rollback () { /* noop */ }
  async exec () { /* noop */ }
}

const dataStore = ds.createDataStore({

  async init (this: any, params: any): Promise<any> {
    this.settings = params.settings;

    const eventFilesStorage = await _internals.getEventFiles();
    const userStorage = await getStorage('local');
    userEvents.init(userStorage, eventFilesStorage, this.settings, params.integrity.setOnEvent, params.systemStreams);
    eventFilesStorage.attachToEventStore(userEvents, params.integrity.setOnEvent);

    const userStreamsStorage = _internals.storageLayer.streams;
    userStreams.init(userStreamsStorage);

    return this;
  },

  streams: userStreams,

  events: userEvents,

  async newTransaction (): Promise<any> {
    return new NoopTransactionSQLite();
  },

  async deleteUser (uid: string): Promise<void> {
    await userStreams._deleteUser(uid);
    await userEvents._deleteUser(uid);
  },

  async getUserStorageInfos (uid: string): Promise<any> {
    const streams = await userStreams._getStorageInfos(uid);
    const events = await userEvents._getStorageInfos(uid);
    const files = await userEvents._getFilesStorageInfos(uid);
    return { streams, events, files };
  }
});

export { dataStore };
