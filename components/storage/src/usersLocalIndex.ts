/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Contains UserName >> UserId Mapping
 */

const { getLogger } = require('@pryv/boiler');
const cache = require('cache').default;
const { validateUsersLocalIndexDB } = require('storages/interfaces/baseStorage/UsersLocalIndexDB');
const { pluginLoader } = require('storages');

const logger = getLogger('users:local-index');

class UsersLocalIndex {
  initialized;
  /**
   * @type {DBIndex}
   */
  db;

  constructor () {
    this.initialized = false;
  }

  async init () {
    if (this.initialized) { return; }
    this.initialized = true;

    const engine = pluginLoader.getEngineFor('baseStorage');
    const engineModule = pluginLoader.getEngineModule(engine);
    const DBIndex = engineModule.getUsersLocalIndex();
    this.db = new DBIndex();

    await this.db.init();
    validateUsersLocalIndexDB(this.db);

    logger.debug('init');
  }

  /**
   * Check the integrity of the userIndex compared to the username events in SystemStreams
   * @returns {Promise<Object>} With `errors` an array of error messages if discrepencies are found
   */
  async checkIntegrity () {
    const errors = [];
    const infos = {};
    const checkedMap = {};

    for (const collectionName of ['events', 'streams', 'accesses', 'profile', 'webhooks']) {
      const userIds = await getAllKnownUserIdsFromDB(collectionName);
      infos['userIdsCount-' + collectionName] = userIds.length;

      for (const userId of userIds) {
        if (checkedMap[userId]) continue;
        const username = this.getUsername(userId);
        checkedMap[userId] = true;
        if (username == null) {
          errors.push(`User id "${userId}" in "${collectionName}" is unknown in the user index DB`);
          continue;
        }
      }
    }
    return {
      title: 'Users local index vs database',
      infos,
      errors
    };
  }

  async addUser (username, userId) {
    await this.db.addUser(username, userId);
    logger.debug('addUser', username, userId);
  }

  async usernameExists (username) {
    const res = ((await this.getUserId(username)) != null);
    logger.debug('usernameExists', username, res);
    return res;
  }

  async getUserId (username) {
    let userId = cache.getUserId(username);
    if (userId == null) {
      userId = await this.db.getIdForName(username);
      if (userId != null) {
        cache.setUserId(username, userId);
      }
    }
    logger.debug('idForName', username, userId);
    return userId;
  }

  async getUsername (userId) {
    const res = await this.db.getNameForId(userId);
    logger.debug('nameForId', userId, res);
    return res;
  }

  /**
   * @returns {Promise<Object>} An object whose keys are the usernames and values are the user ids.
   */
  async getAllByUsername () {
    logger.debug('getAllByUsername');
    return await this.db.getAllByUsername();
  }

  /**
   * Reset everything – used by tests only
   */
  async deleteAll () {
    logger.debug('deleteAll');
    cache.clear();
    return await this.db.deleteAll();
  }

  async deleteById (userId) {
    logger.debug('deleteById', userId);
    return await this.db.deleteById(userId);
  }
}

async function getAllKnownUserIdsFromDB (collectionName) {
  const storage = require('storage'); // placed here to avoid some circular dependency
  const storageLayer = await storage.getStorageLayer();
  return await storageLayer.getAllUserIdsFromCollection(collectionName);
}

const usersLocalIndex = new UsersLocalIndex();
export default usersLocalIndex;
export { usersLocalIndex };
