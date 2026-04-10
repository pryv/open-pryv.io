/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { getConfig, getLogger } = require('@pryv/boiler');
const { validateUserStorage } = require('storages/interfaces/baseStorage/UserStorage');
const { validateSessions } = require('storages/interfaces/baseStorage/Sessions');
const { validatePasswordResetRequests } = require('storages/interfaces/baseStorage/PasswordResetRequests');
const { validateVersions } = require('storages/interfaces/baseStorage/Versions');
const { pluginLoader } = require('storages');

/**
 * 'StorageLayer' is a component that contains all the vertical registries
 * for various database models.
 *
 * Engine selection is handled by the pluginLoader — each engine plugin
 * provides an `initStorageLayer()` method that populates this instance.
 */
class StorageLayer {
  connection;
  engine;
  versions;
  passwordResetRequests;
  sessions;
  accesses;
  profile;
  streams;
  events;
  webhooks;
  logger;

  /**
   * Initialize the storage layer.
   * @param {Object} connection - Database connection (MongoDB Database instance,
   *   DatabasePG instance, or null for SQLite).
   * @param {Object} [options] - Additional options from the barrel.
   * @param {Object} [options.integrityAccesses] - Integrity module for accesses.
   */
  async init (connection, options = {}) {
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
    engineModule.initStorageLayer(this, connection, {
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
    validateVersions(this.versions);
  }

  // iterateAllEvents() is set by the engine's initStorageLayer()

  /**
   * @returns {Promise<any>}
   */
  async waitForConnection () {
    const database = this.connection;
    return await database.waitForConnection();
  }
}
module.exports = StorageLayer;
