/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const storage = require('storage');

const { getConfigUnsafe } = require('@pryv/boiler');
const config = getConfigUnsafe(true);

const database = storage.getDatabaseSync(true);

// MongoDB-specific classes used as initial placeholders until init() provides engine-agnostic instances
const { PasswordResetRequests } = require('storages/engines/mongodb/src/PasswordResetRequests.ts');
const { Sessions } = require('storages/engines/mongodb/src/Sessions.ts');
const { Accesses } = require('storages/engines/mongodb/src/user/Accesses.ts');
const { Profile } = require('storages/engines/mongodb/src/user/Profile.ts');
const { Webhooks } = require('storages/engines/mongodb/src/user/Webhooks.ts');

/**
 * Test process dependencies.
 */
const dependencies = {
  settings: config.get(),
  storage: {
    database,
    passwordResetRequests: new PasswordResetRequests(database),
    sessions: new Sessions(database),
    user: {
      accesses: new Accesses(database),
      profile: new Profile(database),
      webhooks: new Webhooks(database)
    }
  },
  /**
   * Called by global.test.js to initialize async components.
   * Always reconfigures storage via StorageLayer (engine-agnostic).
   */
  init: async function () {
    const storageLayer = await storage.getStorageLayer();
    this.storage.user.accesses = storageLayer.accesses;
    this.storage.user.profile = storageLayer.profile;
    this.storage.user.webhooks = storageLayer.webhooks;
    this.storage.sessions = storageLayer.sessions;
    this.storage.passwordResetRequests = storageLayer.passwordResetRequests;
  }
};
export default dependencies;
export { dependencies };
export const settings = dependencies.settings;
export const _storage = dependencies.storage;
export { _storage as storage };
export const init = dependencies.init.bind(dependencies);
