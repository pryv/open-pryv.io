/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');

/**
 * Faulty data store that always fails.
 * (Implements no data methods, so all calls will throw "not supported" errors.)
 */
const faultyDataStore: any = ds.createDataStore({
  async init (keyValueData) {
    this.streams = createUserStreams();
    this.events = createUserEvents();
    return this;
  },

  async deleteUser (userId) {},

  async getUserStorageInfos (userId) { return { }; }
});
export default faultyDataStore;

function createUserStreams () {
  return ds.createUserStreams({});
}

function createUserEvents () {
  return ds.createUserEvents({});
}
