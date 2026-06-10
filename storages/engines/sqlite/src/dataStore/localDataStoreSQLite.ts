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

type IntegritySetter = (...args: unknown[]) => unknown;
type DataStoreInitParams = {
  settings: unknown;
  integrity: { setOnEvent: IntegritySetter };
  systemStreams: unknown;
};
interface DataStoreInstance { settings: unknown }
type StorageInfos = { streams: { count: number }, events: { count: number }, files: { sizeKb: number } };

/**
 * Pass-through transaction. SQLite per-user files serialize their own writes
 * via concurrentSafeWrite; the per-call transaction primitive PG uses
 * (LocalTransactionPG) doesn't translate cleanly to per-user-file SQLite.
 * Callers in this codebase use `localTransaction.exec(callback)` to chain a
 * few writes within a single dataStore call; per-call SQLite
 * concurrent-safety subsumes that. We still need to actually run the
 * caller's callback, otherwise the side-effects (e.g.
 * `usersIndex.addUser` inside `usersRepository.insertOne`) never fire and
 * platform DB drifts from the local index. If true ACID-multi-statement is
 * needed later, LocalTransactionSQLite can be hooked in here.
 */
class NoopTransactionSQLite {
  transactionSession: unknown = null;
  async init () { /* noop */ }
  async commit () { /* noop */ }
  async rollback () { /* noop */ }
  async exec (callback?: () => Promise<unknown>): Promise<unknown> {
    if (typeof callback === 'function') return await callback();
  }
}

const dataStore = ds.createDataStore({

  async init (this: DataStoreInstance, params: DataStoreInitParams): Promise<DataStoreInstance> {
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

  async newTransaction (): Promise<NoopTransactionSQLite> {
    return new NoopTransactionSQLite();
  },

  async deleteUser (uid: string): Promise<void> {
    await userStreams._deleteUser(uid);
    await userEvents._deleteUser(uid);
  },

  async getUserStorageInfos (uid: string): Promise<StorageInfos> {
    const streams = await userStreams._getStorageInfos(uid);
    const events = await userEvents._getStorageInfos(uid);
    const files = await userEvents._getFilesStorageInfos(uid);
    return { streams, events, files };
  }
});

export { dataStore };
