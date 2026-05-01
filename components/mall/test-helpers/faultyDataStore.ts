/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

const ds = require('@pryv/datastore');

/**
 * Faulty data store that always fails.
 * (Implements no data methods, so all calls will throw "not supported" errors.)
 */
module.exports = ds.createDataStore({
  async init (keyValueData) {
    this.streams = createUserStreams();
    this.events = createUserEvents();
    return this;
  },

  async deleteUser (userId) {},

  async getUserStorageInfos (userId) { return { }; }
});

function createUserStreams () {
  return ds.createUserStreams({});
}

function createUserEvents () {
  return ds.createUserEvents({});
}
