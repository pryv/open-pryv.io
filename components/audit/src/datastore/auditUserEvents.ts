/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const audit = require('audit').default;
const { localStorePrepareOptions, localStorePrepareQuery } = require('storage/src/localStoreEventQueries.ts');

const auditUserEvents: any = ds.createUserEvents({
  async getStreamed (userId: any, storeQuery: any, storeOptions: any) {
    const userDB = await audit.storage.forUser(userId);
    const query = localStorePrepareQuery(storeQuery);
    const options = localStorePrepareOptions(storeOptions);
    return userDB.getEventsStreamed({ query, options });
  }
});
export default auditUserEvents;
export { auditUserEvents };
