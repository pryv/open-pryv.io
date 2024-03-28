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
/**
 * Contains UserName >> UserId Mapping
 */

const { getConfig, getLogger } = require('@pryv/boiler');
const cache = require('cache');

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

    if ((await getConfig()).get('storageUserIndex:engine') === 'mongodb') {
      const DBIndex = require('./usersLocalIndexMongoDB');
      this.db = new DBIndex();
    } else {
      const DBIndex = require('./usersLocalIndexSQLite');
      this.db = new DBIndex();
    }

    await this.db.init();

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

    for (const collectionName of ['events', 'streams', 'accesses', 'profile', 'webhooks', 'followedSlices']) {
      const userIds = await getAllKnownUserIdsFromDB(collectionName);
      infos['userIdsCount-' + collectionName] = userIds.length;

      for (const userId of userIds) {
        if (checkedMap[userId]) continue;
        const username = this.getUsername(userId);
        checkedMap[userId] = true;
        if (username == null) {
          errors.push(`User id "${userId}" in mongo collection "${collectionName}" is unknown in the user index DB`);
          continue;
        }
      }
    }
    return {
      title: 'Users local index vs MongoDB',
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
  const { getDatabase } = require('storage'); // placed here to avoid some circular dependency
  const database = await getDatabase();
  const collection = await database.getCollection({ name: collectionName });
  const userIds = await collection.distinct('userId', {});
  return userIds;
}

module.exports = new UsersLocalIndex();
