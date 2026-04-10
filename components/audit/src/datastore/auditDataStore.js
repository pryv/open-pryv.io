/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const ds = require('@pryv/datastore');
const auditUserEvents = require('./auditUserEvents');
const auditUserStreams = require('./auditUserStreams');

/**
 * Audit data store.
 */
module.exports = ds.createDataStore({
  id: '_audit',
  name: 'Audit store',

  async init () {
    return this;
  },

  streams: auditUserStreams,
  events: auditUserEvents,

  async deleteUser (userId) {},

  async getUserStorageInfos (userId) {
    return { };
  }
});
