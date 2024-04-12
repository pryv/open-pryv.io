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

const mkdirp = require('mkdirp');
const SQLite3 = require('better-sqlite3');

const { getLogger, getConfig } = require('@pryv/boiler');
const logger = getLogger('platform:db');
const concurrentSafeWrite = require('storage/src/sqliteUtils/concurrentSafeWrite');

class DB {
  db;
  queries;

  async init () {
    const config = await getConfig();
    const basePath = config.get('userFiles:path');
    mkdirp.sync(basePath);

    this.db = new SQLite3(basePath + '/platform-wide.db');
    await concurrentSafeWrite.initWALAndConcurrentSafeWriteCapabilities(this.db);

    await concurrentSafeWrite.execute(() => {
      this.db.prepare('CREATE TABLE IF NOT EXISTS keyValue (key TEXT PRIMARY KEY, value TEXT NOT NULL);').run();
    });
    this.queries = {};
    this.queries.getValueWithKey = this.db.prepare('SELECT key, value FROM keyValue WHERE key = ?');
    this.queries.upsertUniqueKeyValue = this.db.prepare('INSERT OR REPLACE INTO keyValue (key, value) VALUES (@key, @value);');
    this.queries.deleteWithKey = this.db.prepare('DELETE FROM keyValue WHERE key = ?;');
    this.queries.deleteAll = this.db.prepare('DELETE FROM keyValue;');
    this.queries.getAllWithKeyStartsWith = this.db.prepare('SELECT key, value FROM keyValue WHERE key LIKE (? || \'%\')');
    this.queries.getAllWithValue = this.db.prepare('SELECT key, value FROM keyValue WHERE value = ?');
  }

  getOne (key) {
    const value = this.queries.getValueWithKey.all(key);
    const res = (value.length === 0) ? null : value[0].value;
    logger.debug('getOne', key, res);
    return res;
  }

  async getAllWithPrefix (prefix) {
    logger.debug('getAllWithPrefix', prefix);
    return this.queries.getAllWithKeyStartsWith.all(prefix).map(parseEntry);
  }

  getAllWithValue (value) {
    logger.debug('getAllWithValue', value);
    return this.queries.getAllWithKeyStartsWith.all(value).map(parseEntry);
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns
   */
  async set (key, value) {
    logger.debug('set', key, value);
    let result;
    await concurrentSafeWrite.execute(() => {
      result = this.queries.upsertUniqueKeyValue.run({ key, value });
    });
    return result;
  }

  /**
   * @param {string} key
   * @returns
   */
  async delete (key) {
    logger.debug('delete', key);
    let result;
    await concurrentSafeWrite.execute(() => {
      result = this.queries.deleteWithKey.run(key);
    });
    return result;
  }

  async deleteAll () {
    logger.debug('deleteAll');
    await concurrentSafeWrite.execute(() => {
      this.queries.deleteAll.run();
    });
  }

  // ----- utilities ------- //

  async setUserUniqueField (username, field, value) {
    const key = getUserUniqueKey(field, value);
    await this.set(key, username);
  }

  async deleteUserUniqueField (field, value) {
    const key = getUserUniqueKey(field, value);
    await this.delete(key);
  }

  async setUserIndexedField (username, field, value) {
    const key = getUserIndexedKey(username, field);
    await this.set(key, value);
  }

  async deleteUserIndexedField (username, field) {
    const key = getUserIndexedKey(username, field);
    await this.delete(key);
  }

  async getUserIndexedField (username, field) {
    const key = getUserIndexedKey(username, field);
    return this.getOne(key);
  }

  async getUsersUniqueField (field, value) {
    const key = getUserUniqueKey(field, value);
    return this.getOne(key);
  }

  async close () {
    this.db.close();
    this.db = null;
  }

  isClosed () {
    return this.db == null;
  }
}

/**
 * Return an object from an entry in the table
 * @param {Entry} entry
 * @param {string} entry.key
 * @param {string} entry.value
 */
function parseEntry (entry) {
  const [type, field, userNameOrValue] = entry.key.split('/');
  const isUnique = (type === 'user-unique');
  return {
    isUnique,
    field,
    username: isUnique ? entry.value : userNameOrValue,
    value: isUnique ? userNameOrValue : entry.value
  };
}

function getUserUniqueKey (field, value) {
  return 'user-unique/' + field + '/' + value;
}
function getUserIndexedKey (username, field) {
  return 'user-indexed/' + field + '/' + username;
}

module.exports = DB;
