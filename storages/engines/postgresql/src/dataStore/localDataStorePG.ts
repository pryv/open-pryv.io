/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL Data Store.
 */
import { createRequire } from 'node:module';
import type { LocalTransactionPG as LocalTransactionPGType } from './LocalTransactionPG.ts';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const { _internals } = require('../_internals.ts');
const { userStreams } = require('./localUserStreamsPG.ts');
const { userEvents } = require('./localUserEventsPG.ts');
const { LocalTransactionPG } = require('./LocalTransactionPG.ts');

type IntegritySetter = (...args: unknown[]) => unknown;
type DataStoreInitParams = {
  settings: unknown;
  integrity: { setOnEvent: IntegritySetter };
  systemStreams: unknown;
};
interface DataStoreInstance { settings: unknown }
type StorageInfos = { streams: { count: number }, events: { count: number }, files: { sizeKb: number } };

const dataStore = ds.createDataStore({

  async init (this: DataStoreInstance, params: DataStoreInitParams): Promise<DataStoreInstance> {
    this.settings = params.settings;

    const db = _internals.databasePG;

    const eventFilesStorage = await _internals.getEventFiles();
    userEvents.init(db, eventFilesStorage, this.settings, params.integrity.setOnEvent, params.systemStreams);
    eventFilesStorage.attachToEventStore(userEvents, params.integrity.setOnEvent);

    const userStreamsStorage = _internals.storageLayer.streams;
    userStreams.init(userStreamsStorage);

    return this;
  },

  streams: userStreams,

  events: userEvents,

  async newTransaction (): Promise<LocalTransactionPGType> {
    const transaction = new LocalTransactionPG(_internals.databasePG);
    await transaction.init();
    return transaction;
  },

  async deleteUser (userId: string): Promise<void> {
    await userStreams._deleteUser(userId);
    await userEvents._deleteUser(userId);
  },

  async getUserStorageInfos (userId: string): Promise<StorageInfos> {
    const streams = await userStreams._getStorageInfos(userId);
    const events = await userEvents._getStorageInfos(userId);
    const files = await userEvents._getFilesStorageInfos(userId);
    return { streams, events, files };
  }
});

export { dataStore };
