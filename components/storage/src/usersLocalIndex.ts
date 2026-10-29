/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';

/**
 * Contains UserName >> UserId Mapping
 */

import type { UsersLocalIndexDB } from 'storages/interfaces/baseStorage/UsersLocalIndexDB.ts';
const require = createRequire(import.meta.url);

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
   * Check the integrity of the users index against the stored data: every
   * user id holding rows in a user collection must be an account of the
   * index (an id that is not is reported: rows an account deletion left).
   */
  async checkIntegrity (): Promise<{ title: string; infos: Record<string, number>; errors: string[] }> {
    const errors: string[] = [];
    const infos: Record<string, number> = {};
    const idsByCollection: Array<[string, string[]]> = [];
    for (const collectionName of ['events', 'streams', 'accesses', 'profile', 'webhooks']) {
      const userIds = await getAllKnownUserIdsFromDB(collectionName);
      infos['userIdsCount-' + collectionName] = userIds.length;
      idsByCollection.push([collectionName, userIds]);
    }
    // Read after the collections: an account registered meanwhile is known.
    const indexed = new Set(Object.values(await this.getAllByUsername()));
    const reported = new Set<string>();
    for (const [collectionName, userIds] of idsByCollection) {
      for (const userId of userIds) {
        if (indexed.has(userId) || reported.has(userId)) continue;
        reported.add(userId);
        errors.push(`User id "${userId}" in "${collectionName}" is unknown in the user index DB`);
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

  /**
   * Rename the canonical (primary) username; leaves aliases intact.
   * @returns false when no user holds `oldUsername` (nothing renamed); rejects
   *   when another user holds `newUsername`.
   */
  async renameUser (oldUsername: string, newUsername: string): Promise<boolean> {
    const renamed = await this.db.renameUser(oldUsername, newUsername);
    // Bust AFTER the write so a concurrent getUserId cannot re-cache the stale
    // name->userId mapping past the rename.
    cache.unsetUser(oldUsername);
    cache.unsetUser(newUsername);
    logger.debug('renameUser', oldUsername, newUsername, renamed);
    return renamed;
  }

  async usernameExists (username: string): Promise<boolean> {
    const res = ((await this.getUserId(username)) != null);
    logger.debug('usernameExists', username, res);
    return res;
  }

  async getUserId (username: string): Promise<string | undefined> {
    return (await this.resolveName(username))?.userId;
  }

  /**
   * Resolve a name (username or alias) to its account, telling whether the
   * name is the account's canonical username.
   */
  async resolveName (username: string): Promise<{ userId: string; isCanonical: boolean } | undefined> {
    let userId = cache.getUserId(username);
    let isCanonical: boolean;
    if (userId != null) {
      isCanonical = cache.isCanonicalUsername(username);
    } else {
      // Resolve a primary username first (common path), then fall back to the
      // alias index so de-identifying / superseded-username aliases route to
      // the same user. Both kinds share the name->userId cache.
      userId = await this.db.getIdForName(username);
      isCanonical = userId != null;
      if (userId == null) {
        userId = await this.db.getIdForAlias(username);
      }
      if (userId != null) {
        cache.setUserId(username, userId, isCanonical);
      }
    }
    logger.debug('idForName', username, userId);
    return userId == null ? undefined : { userId, isCanonical };
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

  /** The user holding `alias` as an alias (not as a username), uncached. */
  async getUserIdForAlias (alias: string): Promise<string | undefined> {
    return await this.db.getIdForAlias(alias);
  }

  async deleteAlias (alias: string, userId: string): Promise<void> {
    await this.db.deleteAlias(alias, userId);
    cache.unsetUser(alias); // bust AFTER the write (see renameUser)
    logger.debug('deleteAlias', alias);
  }

  async deleteAliasesForId (userId: string): Promise<void> {
    const aliases = await this.db.getAliasesForId(userId);
    await this.db.deleteAliasesForId(userId);
    for (const alias of aliases) { cache.unsetUser(alias); } // bust AFTER the write
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
