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

const Database = require('storage').Database;

const { getLogger, getConfig } = require('@pryv/boiler');
const logger = getLogger('platform:db');

class DB {
  platformUnique;
  platformIndexed;
  queries;
  db;

  async init () {
    const settings = structuredClone((await getConfig()).get('database'));
    settings.name = settings.name + '-platform';
    this.db = new Database(settings);
    this.platformUnique = await this.db.getCollection({
      name: 'keyValueUnique',
      indexes: [
        {
          index: { field: 1, value: 1 },
          options: { unique: true }
        }
      ]
    });
    this.platformIndexed = await this.db.getCollection({
      name: 'keyValueIndexed',
      indexes: [
        {
          index: { username: 1, field: 1 },
          options: { unique: true }
        },
        {
          index: { field: 1 },
          options: { }
        }
      ]
    });
    logger.debug('PlatformDB (mongo) initialized');
  }

  /** Used by platformCheckIntegrity  */
  async getAllWithPrefix (prefix) {
    logger.debug('getAllWithPrefix', prefix);
    if (prefix !== 'user') throw new Error('Only [user] prefix is supported');
    const res = (await this.platformIndexed.find({}).toArray()).map((i) => { i.isUnique = false; return i; });
    const uniques = (await this.platformUnique.find({}).toArray()).map((i) => { i.isUnique = true; return i; });
    res.push(...uniques);
    logger.debug('getAllWithPrefixDone', prefix);
    return res;
  }

  /** Used by tests  */
  async deleteAll () {
    logger.debug('deleteAll');
    await this.platformIndexed.deleteMany({});
    await this.platformUnique.deleteMany({});
  }

  // ----- utilities ------- //

  async setUserUniqueField (username, field, value) {
    const item = { field, value, username };
    logger.debug('setUserUniqueField', item);
    await this.platformUnique.updateOne({ field, value }, { $set: item }, { upsert: true });
    return item;
  }

  async deleteUserUniqueField (field, value) {
    logger.debug('deleteUserUniqueField', { field, value });
    await this.platformUnique.deleteOne({ field, value });
  }

  async setUserIndexedField (username, field, value) {
    const item = { field, value, username };
    logger.debug('setUserIndexedField', item);
    await this.platformIndexed.updateOne({ field, username }, { $set: item }, { upsert: true });
  }

  async deleteUserIndexedField (username, field) {
    logger.debug('deleteUserIndexedField', { username, field });
    await this.platformIndexed.deleteOne({ username, field });
  }

  async getUserIndexedField (username, field) {
    logger.debug('getUserIndexedField', { username, field });
    const res = await this.platformIndexed.findOne({ username, field });
    return res?.value || null;
  }

  async getUsersUniqueField (field, value) {
    logger.debug('getUsersUniqueField', { field, value });
    const res = await this.platformUnique.findOne({ field, value });
    return res?.username || null;
  }

  async close () {
    await this.db.close();
    this.db = null;
  }

  isClosed () {
    return this.db == null;
  }
}

module.exports = DB;
