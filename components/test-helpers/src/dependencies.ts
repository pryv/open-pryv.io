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
    // Plan 32 framework / Plan 66: production runs migrations in
    // `bin/master.js` before forking workers. The test harness calls
    // `storages.init()` directly without going through master, so we
    // run the migration runner ourselves to bring the test DB up to
    // the same schema shape as a deployed server (e.g. Plan 66's
    // `head_id`-aware unique-token index).
    try {
      const { createMigrationRunner } = require('storages/interfaces/migrations/index.ts');
      const runner = await createMigrationRunner();
      await runner.runAll();
    } catch (err) {
      // Some test contexts use engines that don't register the
      // migrations capability — proceed without crashing.
    }
  }
};
export default dependencies;
export { dependencies };
export const settings = dependencies.settings;
export const _storage = dependencies.storage;
export { _storage as storage };
export const init = dependencies.init.bind(dependencies);
