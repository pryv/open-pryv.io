/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const storage = require('storage');

const { getConfigUnsafe } = require('@pryv/boiler');
const config = getConfigUnsafe(true);

const database = storage.getDatabaseSync(true);

// MongoDB-specific classes used as initial placeholders until init() provides engine-agnostic instances
const PasswordResetRequests = require('storages/engines/mongodb/src/PasswordResetRequests');
const Sessions = require('storages/engines/mongodb/src/Sessions');
const Accesses = require('storages/engines/mongodb/src/user/Accesses');
const Profile = require('storages/engines/mongodb/src/user/Profile');
const Webhooks = require('storages/engines/mongodb/src/user/Webhooks');

/**
 * Test process dependencies.
 */
module.exports = {
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
