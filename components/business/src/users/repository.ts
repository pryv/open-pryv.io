/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const timestamp = require('unix-timestamp');
const { setTimeout } = require('timers/promises');

const User = require('./User.ts').default;
const UserRepositoryOptions = require('./UserRepositoryOptions.ts');
const accountStreams = require('business/src/system-streams/index.ts');
const encryption = require('utils').encryption;
const errors = require('errors').factory;
const { getMall } = require('mall');
const { getPlatform } = require('platform');
const cache = require('cache').default;
const cmc = require('cmc');
const { getLogger } = require('@pryv/boiler');
const cmcLogger = getLogger('cmc:provisioning');

export { getUsersRepository };
/**
 * Repository of the users
 */
class UsersRepository {
  storageLayer: any;
  sessionsStorage: any;
  accessStorage: any;
  mall: any;
  platform: any;
  usersIndex: any;
  userAccountStorage: any;

  async init () {
    this.mall = await getMall();
    this.platform = await getPlatform();
    const storage = require('storage');
    this.storageLayer = await storage.getStorageLayer();
    this.sessionsStorage = this.storageLayer.sessions;
    this.accessStorage = this.storageLayer.accesses;
    this.usersIndex = await storage.getUsersLocalIndex();
    this.userAccountStorage = await storage.getUserAccountStorage();
  }

  /**
   * only for testing and built-in register
   */
  async getAll () {
    const usersMap = await this.usersIndex.getAllByUsername();
    const users: any[] = [];
    for (const [username, userId] of Object.entries(usersMap)) {
      const user = await this.getUserById(userId);
      if (user == null) {
        throw new Error(`Repository inconsistency: user index lists user with id: "${userId}" and username: "${username}", but cannot get it with getUserById()`);
      }
      users.push(user);
    }
    return users;
  }

  /**
   * only for test data to reset all users Dbs.
   */
  async deleteAll () {
    const usersMap = await this.usersIndex.getAllByUsername();
    for (const [, userId] of Object.entries(usersMap)) {
      await this.mall.deleteUser(userId);
    }
    await this.usersIndex.deleteAll();
    await this.platform.deleteAll();
  }

  /**
   * Used only by webhooks could be refactored
   */
  async getAllUsersIdAndName () {
    const usersMap = await this.usersIndex.getAllByUsername();
    const users: any[] = [];
    for (const [username, userId] of Object.entries(usersMap)) {
      users.push({ id: userId, username });
    }
    return users;
  }

  async getUserIdForUsername (username: any) {
    return await this.usersIndex.getUserId(username);
  }

  async getUserById (userId: any) {
    const userAccountStreamsIds = Object.keys(accountStreams.accountMap);
    const query = {
      state: 'all',
      streams: [
        {
          any: userAccountStreamsIds
        }
      ]
    };
    const userAccountEvents = await this.mall.events.get(userId, query);
    const username = await this.usersIndex.getUsername(userId);
    // convert events to the account info structure
    if (userAccountEvents.length === 0) {
      return null;
    }
    if (username == null) {
      // Transient state: index entry already deleted (deleteOne removes it
      // first) but mall data not yet removed.  Return null — the deletion
      // will finish momentarily.
      // Note: a truly stalled partial deletion would leave orphan events
      // with no index entry.  These can be detected by scanning mall user
      // collections that have no matching usersIndex entry (an admin task,
      // not something getUserById should enforce).
      return null;
    }
    const user = new User({
      id: userId,
      username,
      events: userAccountEvents
    });
    return user;
  }

  async usernameExists (username: any) {
    return await this.usersIndex.usernameExists(username);
  }

  async getUserByUsername (username: any) {
    const userId = await this.getUserIdForUsername(username);
    if (userId) {
      const user = await this.getUserById(userId);
      return user;
    }
    return null;
  }

  async getStorageUsedByUserId (userId: any) {
    return {
      dbDocuments: (await this.getOnePropertyValue(userId, 'dbDocuments')) || 0,
      attachedFiles: (await this.getOnePropertyValue(userId, 'attachedFiles')) || 0
    };
  }

  async getOnePropertyValue (userId: any, propertyKey: any) {
    const query = {
      limit: 1,
      state: 'all',
      streams: [
        {
          any: [
            accountStreams.toStreamId(propertyKey)
          ]
        }
      ]
    };
    const userAccountEvents = await this.mall.events.get(userId, query);
    if (!userAccountEvents || !userAccountEvents[0]) { return null; }
    return userAccountEvents[0].content;
  }

  async createSessionForUser (username: any, appId: any, transactionSession: any) {
    return await fromCallback((cb: any) => this.sessionsStorage.generate({ username, appId }, { transactionSession }, cb));
  }

  async createPersonalAccessForUser (userId: any, token: any, appId: any, transactionSession: any) {
    const accessData = {
      token,
      name: appId,
      type: UserRepositoryOptions.ACCESS_TYPE_PERSONAL,
      created: timestamp.now(),
      createdBy: UserRepositoryOptions.SYSTEM_USER_ACCESS_ID,
      modified: timestamp.now(),
      modifiedBy: UserRepositoryOptions.SYSTEM_USER_ACCESS_ID
    };
    return await fromCallback((cb: any) => this.accessStorage.insertOne({ id: userId }, accessData, cb, {
      transactionSession
    }));
  }

  validateAllStorageObjectsInitialized () {
    if (this.accessStorage == null || this.sessionsStorage == null) {
      throw new Error('Please initialize the user repository with all dependencies.');
    }
    return true;
  }

  async insertOne (user: any, withSession = false) {
    // Create the User at a Platform Level
    const operations: any[] = [];
    for (const key of accountStreams.indexedFieldNames) {
      // use default value is null;
      const value = user[key] != null
        ? user[key]
        : accountStreams.accountMap[':_system:' + key]?.default;
      if (value != null) {
        operations.push({
          action: 'create',
          key,
          value,
          isUnique: accountStreams.uniqueFieldNames.includes(key),
          isActive: true
        });
      }
    }
    // check locally for username
    if (await this.usersIndex.usernameExists(user.username)) {
      // gather eventual other uniqueness conflicts
      const eventualPlatformUniquenessErrors = await this.platform.checkUpdateOperationUniqueness(user.username, operations);
      const uniquenessError = errors.itemAlreadyExists('user', eventualPlatformUniquenessErrors);
      uniquenessError.data.username = user.username;
      throw uniquenessError;
    }
    // could throw uniqueness errors
    await this.platform.updateUser(user.username, operations);
    const mallTransaction = await this.mall.newTransaction();
    const localTransaction = await mallTransaction.getStoreTransaction('local');
    await localTransaction.exec(async () => {
      let accessId = UserRepositoryOptions.SYSTEM_USER_ACCESS_ID;
      if (withSession &&
                this.validateAllStorageObjectsInitialized() &&
                user.appId != null) {
        const token = await this.createSessionForUser(user.username, user.appId, localTransaction.transactionSession);
        const access = await this.createPersonalAccessForUser(user.id, token, user.appId, localTransaction.transactionSession);
        accessId = access?.id;
        user.token = access.token;
      }
      user.accessId = accessId;
      // add the user to local index
      await this.usersIndex.addUser(user.username, user.id);
      // Store account fields directly in userAccountStorage (Platform already called above)
      const accountData = user.getFullAccount();
      const accountLeavesMap = accountStreams.accountLeavesMap;
      const now = timestamp.now();
      for (const [streamId, stream] of Object.entries(accountLeavesMap) as Array<[string, any]>) {
        const fieldName = accountStreams.toFieldName(streamId);
        const value = accountData[fieldName] != null
          ? accountData[fieldName]
          : stream.default;
        if (value != null) {
          await this.userAccountStorage.setAccountField(user.id, fieldName, value, accessId, now);
        }
      }
      // set user password
      if (user.passwordHash) {
        // if passwordHash was provided directly (via system.createUser)
        await this.userAccountStorage.addPasswordHash(user.id, user.passwordHash, user.accessId);
      } else {
        // regular user creation
        await this.setUserPassword(user.id, user.password, user.accessId);
      }
    });
    // Provision the reserved `:_cmc:*` parent tree eagerly so that a
    // brand-new user's first `streams.get` lists it. Lazy creation at
    // first :_cmc:* operation still covers users created before this
    // landed. Idempotent — `provisionUserStreams` swallows
    // already-exists errors per stream. No accessId: the prior
    // attempt at passing `user.accessId` here surfaced a stray
    // [6041] invalid-access-token in cumulative test runs.
    try {
      await cmc.provisionUserStreams({
        mall: this.mall,
        userId: user.id,
        logger: cmcLogger
      });
    } catch (err: any) {
      cmcLogger.warn('cmc: reserved-parent provisioning at user creation failed (lazy path will retry)', {
        userId: user.id,
        error: err?.message || err
      });
    }
    return user;
  }

  async updateOne (user: any, update: any, accessId: any) {
    // change password into hash if it exists
    if (update.password) {
      await this.setUserPassword(user.id, update.password, accessId);
    }
    delete update.password;
    // Start a transaction session
    const mallTransaction = await this.mall.newTransaction();
    const localTransaction = await mallTransaction.getStoreTransaction('local');
    const modifiedTime = timestamp.now();
    await localTransaction.exec(async () => {
      // update all account streams and don't allow additional properties
      for (const [streamIdWithoutPrefix, content] of Object.entries(update)) {
        const query = {
          streams: [
            {
              any: [
                accountStreams.toStreamId(streamIdWithoutPrefix)
              ]
            }
          ]
        };
        const updateFields = {
          content,
          modified: modifiedTime,
          modifiedBy: accessId
        };
        await this.mall.events.updateMany(user.id, query, { fieldsToSet: updateFields }, null, mallTransaction);
      }
    });
  }

  async deleteOne (userId: any, username: any) {
    // Fetch user object BEFORE any deletions — platform.deleteUser needs it
    // for unique field cleanup (e.g. email).
    const user = await this.getUserById(userId);
    if (username == null) {
      username = user?.username;
    }
    // Delete index FIRST so that getAll() never lists a user whose data is
    // being deleted.  The reverse race (index gone but events still exist)
    // is handled by getUserById() returning null when username is null.
    await this.usersIndex.init();
    await this.usersIndex.deleteById(userId);
    if (username != null) {
      cache.unsetUser(username);
      await this.platform.deleteUser(username, user);
    }
    await this.mall.deleteUser(userId);
  }

  async count () {
    const users = await this.usersIndex.getAllByUsername();
    return Object.keys(users).length;
  }

  // -------------------- Password Management ------------------- //

  async checkUserPassword (userId: any, password: any) {
    const currentPass = await this.userAccountStorage.getPasswordHash(userId);
    let isValid = false;
    if (currentPass != null) {
      isValid = await encryption.compare(password, currentPass);
    }
    return isValid;
  }

  /**
   * @param userId  undefined
   * @param password  undefined
   */
  async setUserPassword (userId: any, password: any, accessId = 'system', modifiedTime?: any) {
    const passwordHash = await encryption.hash(password);
    await this.userAccountStorage.addPasswordHash(userId, passwordHash, accessId, modifiedTime);
  }
}

let usersRepository: any = null;
let usersRepositoryInitializing = false;

async function getUsersRepository () {
  // eslint-disable-next-line no-unmodified-loop-condition
  while (usersRepositoryInitializing) {
    await setTimeout(100);
  }
  if (!usersRepository) {
    await accountStreams.init();
    usersRepositoryInitializing = true;
    usersRepository = new UsersRepository();
    await usersRepository.init();
    usersRepositoryInitializing = false;
  }
  return usersRepository;
}
