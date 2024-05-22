/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const bluebird = require('bluebird');
const timestamp = require('unix-timestamp');
const { setTimeout } = require('timers/promises');

const User = require('./User');
const UserRepositoryOptions = require('./UserRepositoryOptions');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const encryption = require('utils').encryption;
const errors = require('errors').factory;
const { getMall } = require('mall');
const { getPlatform } = require('platform');
const cache = require('cache');

module.exports = {
  getUsersRepository
};

/**
 * Repository of the users
 */
class UsersRepository {
  storageLayer;
  sessionsStorage;
  accessStorage;
  mall;
  platform;
  usersIndex;
  userAccountStorage;

  /**
   * @returns {Promise<void>}
   */
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
   * @returns {Promise<{ id: string, username: string, events: any[] }[]>}
   */
  async getAll () {
    const usersMap = await this.usersIndex.getAllByUsername();
    const users = [];
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
   * @returns {Promise<void>}
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
   * @returns {Promise<{ id: string, username: string }[]>}
   */
  async getAllUsersIdAndName () {
    const usersMap = await this.usersIndex.getAllByUsername();
    const users = [];
    for (const [username, userId] of Object.entries(usersMap)) {
      users.push({ id: userId, username });
    }
    return users;
  }

  /**
   * @param {string} username
   * @returns {Promise<any>}
   */
  async getUserIdForUsername (username) {
    return await this.usersIndex.getUserId(username);
  }

  /**
   * @param {string} userId
   * @returns {Promise<{ id: string, username: string, events: any[] }>}
   */
  async getUserById (userId) {
    const userAccountStreamsIds = Object.keys(SystemStreamsSerializer.getAccountMap());
    const query = {
      state: 'all',
      streams: [
        {
          any: userAccountStreamsIds,
          and: [{ any: [SystemStreamsSerializer.options.STREAM_ID_ACTIVE] }]
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
      throw new Error('Inconsistency between userEvents and this.usersIndex, found null username for userId: "' +
                userId +
                '" with ' +
                userAccountEvents.length +
                ' user account events');
    }
    const user = new User({
      id: userId,
      username,
      events: userAccountEvents
    });
    return user;
  }

  /**
   * @param {string} username
   * @returns {Promise<boolean>}
   */
  async usernameExists (username) {
    return await this.usersIndex.usernameExists(username);
  }

  /**
   * @param {string} username
   * @returns {Promise<any>}
   */
  async getUserByUsername (username) {
    const userId = await this.getUserIdForUsername(username);
    if (userId) {
      const user = await this.getUserById(userId);
      return user;
    }
    return null;
  }

  /**
   * @param {string} userId
   * @returns {Promise<any>}
   */
  async getStorageUsedByUserId (userId) {
    return {
      dbDocuments: (await this.getOnePropertyValue(userId, 'dbDocuments')) || 0,
      attachedFiles: (await this.getOnePropertyValue(userId, 'attachedFiles')) || 0
    };
  }

  /**
   * @param {string} userId
   * @param {string} propertyKey
   * @returns {Promise<any>}
   */
  async getOnePropertyValue (userId, propertyKey) {
    const query = {
      limit: 1,
      state: 'all',
      streams: [
        {
          any: [
            SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(propertyKey)
          ]
        }
      ]
    };
    const userAccountEvents = await this.mall.events.get(userId, query);
    if (!userAccountEvents || !userAccountEvents[0]) { return null; }
    return userAccountEvents[0].content;
  }

  /**
   * @param {string} username
   * @param {string} appId
   * @param {any} transactionSession
   * @returns {Promise<string>}
   */
  async createSessionForUser (username, appId, transactionSession) {
    return await bluebird.fromCallback((cb) => this.sessionsStorage.generate({ username, appId }, { transactionSession }, cb));
  }

  /**
   * @param {string} userId
   * @param {string} token
   * @param {string} appId
   * @returns {any}
   */
  async createPersonalAccessForUser (userId, token, appId, transactionSession) {
    const accessData = {
      token,
      name: appId,
      type: UserRepositoryOptions.ACCESS_TYPE_PERSONAL,
      created: timestamp.now(),
      createdBy: UserRepositoryOptions.SYSTEM_USER_ACCESS_ID,
      modified: timestamp.now(),
      modifiedBy: UserRepositoryOptions.SYSTEM_USER_ACCESS_ID
    };
    return await bluebird.fromCallback((cb) => this.accessStorage.insertOne({ id: userId }, accessData, cb, {
      transactionSession
    }));
  }

  /**
   * @returns {boolean}
   */
  validateAllStorageObjectsInitialized () {
    if (this.accessStorage == null || this.sessionsStorage == null) {
      throw new Error('Please initialize the user repository with all dependencies.');
    }
    return true;
  }

  /**
   * @param {User} user
   * @param {boolean | undefined | null} withSession
   * @param {boolean | undefined | null} skipFowardToRegister
   * @returns {Promise<any>}
   */
  async insertOne (user, withSession = false, skipFowardToRegister = false) {
    // Create the User at a Platfrom Level..
    const operations = [];
    for (const key of SystemStreamsSerializer.getIndexedAccountStreamsIdsWithoutPrefix()) {
      // use default value is null;
      const value = user[key] != null
        ? user[key]
        : SystemStreamsSerializer.getAccountFieldDefaultValue(key);
      if (value != null) {
        operations.push({
          action: 'create',
          key,
          value,
          isUnique: SystemStreamsSerializer.isUniqueAccountField(key),
          isActive: true
        });
      }
    }
    // check locally for username // <== maybe this this.usersIndex should be fully moved to platform
    if (await this.usersIndex.usernameExists(user.username)) {
      // gather eventual other uniqueness conflicts
      const eventualPlatformUniquenessErrors = await this.platform.checkUpdateOperationUniqueness(user.username, operations);
      const uniquenessError = errors.itemAlreadyExists('user', eventualPlatformUniquenessErrors);
      uniquenessError.data.username = user.username;
      throw uniquenessError;
    }
    // could throw uniqueness errors
    await this.platform.updateUserAndForward(user.username, operations, skipFowardToRegister);
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
      const events = await user.getEvents();
      // add the user to local index
      await this.usersIndex.addUser(user.username, user.id);
      for (const event of events) await this.mall.events.create(user.id, event, mallTransaction);
      // set user password
      if (user.passwordHash) {
        // if coming from deprecated `system.createUser`; TODO: remove when that method is removed
        await this.userAccountStorage.addPasswordHash(user.id, user.passwordHash, user.accessId);
      } else {
        // regular user creation
        await await this.setUserPassword(user.id, user.password, user.accessId);
      }
    });
    return user;
  }

  /**
   * @param {User} user
   * @param {{}} update
   * @param {string} accessId
   * @returns {Promise<void>}
   */
  async updateOne (user, update, accessId) {
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
        // for (let i = 0; i < eventsForUpdate.length; i++) {
        const query = {
          streams: [
            {
              any: [
                SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(streamIdWithoutPrefix)
              ],
              and: [
                { any: [SystemStreamsSerializer.options.STREAM_ID_ACTIVE] }
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

  /**
   * @param {string} userId
   * @param {string | null} username
   * @param {boolean | null} skipFowardToRegister
   * @returns {Promise<number>}
   */
  async deleteOne (userId, username, skipFowardToRegister) {
    const user = await this.getUserById(userId);
    if (username == null) {
      username = user?.username;
    }
    await this.usersIndex.init();
    await this.usersIndex.deleteById(userId);
    if (username != null) {
      // can happen during tests
      cache.unsetUser(username);
      // Clear data for this user in Platform
      await this.platform.deleteUser(username, user, skipFowardToRegister);
    }
    await this.mall.deleteUser(userId);
  }

  /**
   * @returns {Promise<number>}
   */
  async count () {
    const users = await this.usersIndex.getAllByUsername();
    return Object.keys(users).length;
  }

  // -------------------- Password Management ------------------- //

  /**
   * @param {string} userId
   * @param {string} password
   * @returns {Promise<boolean>}
   */
  async checkUserPassword (userId, password) {
    const currentPass = await this.userAccountStorage.getPasswordHash(userId);
    let isValid = false;
    if (currentPass != null) {
      isValid = await encryption.compare(password, currentPass);
    }
    return isValid;
  }

  /**
   * @param {String} userId  undefined
   * @param {String} password  undefined
   */
  async setUserPassword (userId, password, accessId = 'system', modifiedTime) {
    const passwordHash = await encryption.hash(password);
    await this.userAccountStorage.addPasswordHash(userId, passwordHash, accessId, modifiedTime);
  }
}

let usersRepository = null;
let usersRepositoryInitializing = false;

/**
 * @returns {Promise<UsersRepository>}
 */
async function getUsersRepository () {
  // eslint-disable-next-line no-unmodified-loop-condition
  while (usersRepositoryInitializing) {
    await setTimeout(100);
  }
  if (!usersRepository) {
    await SystemStreamsSerializer.init();
    usersRepositoryInitializing = true;
    usersRepository = new UsersRepository();
    await usersRepository.init();
    usersRepositoryInitializing = false;
  }
  return usersRepository;
}
