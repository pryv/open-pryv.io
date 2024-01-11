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
const path = require('path');
const fs = require('fs/promises');
const LRU = require('lru-cache');

const UserDatabase = require('./UserDatabase');
const { getConfig, getLogger } = require('@pryv/boiler');
const migrations = require('./migrations');
const userLocalDirectory = require('storage').userLocalDirectory;
const ensureUserDirectory = userLocalDirectory.ensureUserDirectory;

const CACHE_SIZE = 500;
const VERSION = '1.0.0';

class Storage {
  initialized = false;
  userDBsCache = null;
  options = null;
  id = null;

  async init () {
    if (this.initialized) {
      throw new Error('Database already initalized');
    }
    this.initialized = true;
    this.config = await getConfig();
    await userLocalDirectory.init();
    await migrations.migrateUserDBsIfNeeded(this);
    this.logger.debug('DB initialized');
    return this;
  }

  constructor (id, options) {
    this.id = id;
    this.logger = getLogger(this.id + ':storage');
    this.options = options || {};
    this.userDBsCache = new LRU({
      max: this.options.max || CACHE_SIZE,
      dispose: function (db, key) { db.close(); }
    });
  }

  getVersion () {
    return VERSION;
  }

  /**
   * @throws if not initalized
   */
  checkInitialized () {
    if (!this.initialized) throw new Error('Initialize db component before using it');
  }

  /**
   * get the database relative to a specific user
   * @param {string} userId
   * @returns {Promise<UserDatabase>}
   */
  async forUser (userId) {
    this.logger.debug('forUser: ' + userId);
    this.checkInitialized();
    return this.userDBsCache.get(userId) || (await open(this, userId, this.logger));
  }

  /**
   * close and delete the database relative to a specific user
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async deleteUser (userId) {
    this.logger.info('deleteUser: ' + userId);
    const userDb = await this.forUser(userId);
    await userDb.close();
    this.userDBsCache.delete(userId);
    const dbPath = await this.dbgetPathForUser(userId);
    try {
      await fs.unlink(dbPath);
    } catch (err) {
      this.logger.debug('deleteUser: Error' + err);
      throw err;
    }
  }

  close () {
    this.checkInitialized();
    this.userDBsCache.clear();
  }

  async dbgetPathForUser (userId) {
    const userPath = await ensureUserDirectory(userId);
    return path.join(userPath, this.id + '-' + this.getVersion() + '.sqlite');
  }
}

async function open (storage, userId, logger) {
  logger.debug('open: ' + userId);
  const db = new UserDatabase(logger, { dbPath: await storage.dbgetPathForUser(userId) });
  await db.init();
  storage.userDBsCache.set(userId, db);
  return db;
}

module.exports = Storage;
