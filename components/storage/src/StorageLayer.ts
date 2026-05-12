/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getConfig, getLogger } = require('@pryv/boiler');
const { validateUserStorage } = require('storages/interfaces/baseStorage/UserStorage.ts');
const { validateSessions } = require('storages/interfaces/baseStorage/Sessions.ts');
const { validatePasswordResetRequests } = require('storages/interfaces/baseStorage/PasswordResetRequests.ts');
const { pluginLoader } = require('storages');

/**
 * 'StorageLayer' is a component that contains all the vertical registries
 * for various database models.
 *
 * Engine selection is handled by the pluginLoader — each engine plugin
 * provides an `initStorageLayer()` method that populates this instance.
 */
class StorageLayer {
  connection: any;
  engine: any;
  passwordResetRequests: any;
  sessions: any;
  accesses: any;
  profile: any;
  streams: any;
  events: any;
  webhooks: any;
  logger: any;

  /**
   * Initialize the storage layer.
   * @param connection - Database connection (MongoDB Database instance,
   *   DatabasePG instance, or null for SQLite).
   * @param [options] - Additional options from the barrel.
   * @param [options.integrityAccesses] - Integrity module for accesses.
   */
  async init (connection: any, options: any = {}) {
    if (this.connection != null) {
      this.logger.info('Already initialized');
      return;
    }

    const config = await getConfig();
    this.logger = getLogger('storage');

    this.engine = pluginLoader.getEngineFor('baseStorage');

    const passwordResetRequestMaxAge = config.get('auth:passwordResetRequestMaxAge');
    const sessionMaxAge = config.get('auth:sessionMaxAge');

    const engineModule = pluginLoader.getEngineModule(this.engine);
    await engineModule.initStorageLayer(this, connection, {
      passwordResetRequestMaxAge,
      sessionMaxAge,
      integrityAccesses: options.integrityAccesses
    });

    // Validate all storage instances against their interface contracts
    validateUserStorage(this.accesses);
    validateUserStorage(this.profile);
    validateUserStorage(this.streams);
    validateUserStorage(this.webhooks);
    validateSessions(this.sessions);
    validatePasswordResetRequests(this.passwordResetRequests);
  }

  // iterateAllEvents() is set by the engine's initStorageLayer()

  async waitForConnection () {
    const database = this.connection;
    return await database.waitForConnection();
  }
}
export { StorageLayer };
