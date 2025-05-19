/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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
const concurrentSafeWrite = require('./sqliteUtils/concurrentSafeWrite');

const { getConfig } = require('@pryv/boiler');

class DBIndex {
  db;
  queryGetIdForName;
  queryGetNameForId;
  queryGetAll;
  queryInsert;
  queryDeleteAll;
  queryDeleteById;

  async init () {
    const config = await getConfig();
    const basePath = config.get('userFiles:path');
    mkdirp.sync(basePath);

    this.db = new SQLite3(basePath + '/user-index.db');
    await concurrentSafeWrite.initWALAndConcurrentSafeWriteCapabilities(this.db);

    concurrentSafeWrite.execute(() => {
      this.db.prepare('CREATE TABLE IF NOT EXISTS id4name (username TEXT PRIMARY KEY, userId TEXT NOT NULL);').run();
    });
    concurrentSafeWrite.execute(() => {
      this.db.prepare('CREATE INDEX IF NOT EXISTS id4name_id ON id4name(userId);').run();
    });

    this.queryGetIdForName = this.db.prepare('SELECT userId FROM id4name WHERE username = ?');
    this.queryGetNameForId = this.db.prepare('SELECT username FROM id4name WHERE userId = ?');
    this.queryInsert = this.db.prepare('INSERT INTO id4name (username, userId) VALUES (@username, @userId)');
    this.queryGetAll = this.db.prepare('SELECT username, userId FROM id4name');
    this.queryDeleteById = this.db.prepare('DELETE FROM id4name WHERE userId = @userId');
    this.queryDeleteAll = this.db.prepare('DELETE FROM id4name');
  }

  async getIdForName (username) {
    return this.queryGetIdForName.get(username)?.userId;
  }

  async getNameForId (userId) {
    return this.queryGetNameForId.get(userId)?.username;
  }

  async addUser (username, userId) {
    let result = null;
    await concurrentSafeWrite.execute(() => {
      result = this.queryInsert.run({ username, userId });
    });
    return result;
  }

  async deleteById (userId) {
    await concurrentSafeWrite.execute(() => {
      return this.queryDeleteById.run({ userId });
    });
  }

  /**
   * @returns {Object} An object whose keys are the usernames and values are the user ids.
   */
  async getAllByUsername () {
    const users = {};
    for (const user of this.queryGetAll.iterate()) {
      users[user.username] = user.userId;
    }
    return users;
  }

  async deleteAll () {
    concurrentSafeWrite.execute(() => {
      return this.queryDeleteAll.run();
    });
  }
}

module.exports = DBIndex;
