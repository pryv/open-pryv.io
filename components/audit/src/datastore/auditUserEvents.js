/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const ds = require('@pryv/datastore');
const audit = require('audit');
const { localStorePrepareOptions, localStorePrepareQuery } = require('storage/src/localStoreEventQueries');

module.exports = ds.createUserEvents({
  async getStreamed (userId, storeQuery, storeOptions) {
    const userDB = await audit.storage.forUser(userId);
    const query = localStorePrepareQuery(storeQuery);
    const options = localStorePrepareOptions(storeOptions);
    return userDB.getEventsStreamed({ query, options });
  }
});
