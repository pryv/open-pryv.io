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

import type { UsersLocalIndexDB } from 'storages/interfaces/baseStorage/UsersLocalIndexDB.ts';

const { getLogger } = require('@pryv/boiler');
const cache = require('cache').default;
const { validateUsersLocalIndexDB } = require('storages/interfaces/baseStorage/UsersLocalIndexDB.ts');
const { pluginLoader } = require('storages');

const logger = getLogger('users:local-index');

class UsersLocalIndex {
  initialized: boolean;
  db!: UsersLocalIndexDB;

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
   */
  async checkIntegrity (): Promise<{ title: string; infos: Record<string, number>; errors: string[] }> {
    const errors: string[] = [];
    const infos: Record<string, number> = {};
    const checkedMap: Record<string, boolean> = {};

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

  async addUser (username: string, userId: string): Promise<void> {
    await this.db.addUser(username, userId);
    logger.debug('addUser', username, userId);
  }

  /** Rename the canonical (primary) username; leaves aliases intact. */
  async renameUser (oldUsername: string, newUsername: string): Promise<void> {
    cache.unsetUser(oldUsername);
    cache.unsetUser(newUsername);
    await this.db.renameUser(oldUsername, newUsername);
    logger.debug('renameUser', oldUsername, newUsername);
  }

  async usernameExists (username: string): Promise<boolean> {
    const res = ((await this.getUserId(username)) != null);
    logger.debug('usernameExists', username, res);
    return res;
  }

  async getUserId (username: string): Promise<string | undefined> {
    let userId = cache.getUserId(username);
    if (userId == null) {
      // Resolve a primary username first (common path), then fall back to the
      // alias index so de-identifying / superseded-username aliases route to
      // the same user. Both kinds share the name->userId cache.
      userId = await this.db.getIdForName(username);
      if (userId == null) {
        userId = await this.db.getIdForAlias(username);
      }
      if (userId != null) {
        cache.setUserId(username, userId);
      }
    }
    logger.debug('idForName', username, userId);
    return userId;
  }

  /** Returns the canonical (primary) username for a userId — never an alias. */
  async getUsername (userId: string): Promise<string | undefined> {
    const res = await this.db.getNameForId(userId);
    logger.debug('nameForId', userId, res);
    return res;
  }

  // --- Alias index (many aliases : one userId) --- //

  async addAlias (alias: string, userId: string): Promise<void> {
    await this.db.addAlias(alias, userId);
    logger.debug('addAlias', alias, userId);
  }

  async getAliasesForId (userId: string): Promise<string[]> {
    return await this.db.getAliasesForId(userId);
  }

  async deleteAlias (alias: string): Promise<void> {
    cache.unsetUser(alias);
    await this.db.deleteAlias(alias);
    logger.debug('deleteAlias', alias);
  }

  async deleteAliasesForId (userId: string): Promise<void> {
    const aliases = await this.db.getAliasesForId(userId);
    for (const alias of aliases) { cache.unsetUser(alias); }
    await this.db.deleteAliasesForId(userId);
    logger.debug('deleteAliasesForId', userId, aliases.length);
  }

  async getAllByUsername (): Promise<Record<string, string>> {
    logger.debug('getAllByUsername');
    return await this.db.getAllByUsername();
  }

  /**
   * Reset everything – used by tests only
   */
  async deleteAll (): Promise<void> {
    logger.debug('deleteAll');
    cache.clear();
    return await this.db.deleteAll();
  }

  async deleteById (userId: string): Promise<void> {
    logger.debug('deleteById', userId);
    return await this.db.deleteById(userId);
  }
}

async function getAllKnownUserIdsFromDB (collectionName: string): Promise<string[]> {
  const storage = require('storage'); // placed here to avoid some circular dependency
  const storageLayer = await storage.getStorageLayer();
  return await storageLayer.getAllUserIdsFromCollection(collectionName);
}

const usersLocalIndex = new UsersLocalIndex();
export default usersLocalIndex;
export { usersLocalIndex };
