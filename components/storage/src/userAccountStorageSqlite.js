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
 * SQLite storage for per-user data such as:
 * - Password and password history
 * - Profile
 * The DB file is located in the root of each user account folder.
 *
 * TODO: This should be refactored and merged with Audit Storage and SQLite Event storage from branch
 * https://github.com/pryv/service-core/tree/test/sqlite-4-events
 * into a single "user-centric" storage
 */

const path = require('path');
const SQLite3 = require('better-sqlite3');
const LRU = require('lru-cache');
const timestamp = require('unix-timestamp');
const encryption = require('utils').encryption;

const userLocalDirectory = require('./userLocalDirectory');

const CACHE_SIZE = 100;
const VERSION = '1.0.0';
const DB_OPTIONS = {};

let dbCache = null;

const InitStates = {
  NOT_INITIALIZED: -1,
  INITIALIZING: 0,
  READY: 1
};
let initState = InitStates.NOT_INITIALIZED;

module.exports = {
  init,
  addPasswordHash,
  getPasswordHash,
  getCurrentPasswordTime,
  passwordExistsInHistory,
  clearHistory,
  getKeyValueDataForStore,
  _getPasswordHistory,
  _getAllStoreData,
  _clearStoreData
};

async function init () {
  while (initState === InitStates.INITIALIZING) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (initState === InitStates.READY) {
    return;
  }
  initState = InitStates.INITIALIZING;

  await userLocalDirectory.init();

  dbCache = new LRU({
    max: CACHE_SIZE,
    dispose: function (db/* , key */) { db.close(); }
  });

  initState = InitStates.READY;
}

// PASSWORD MANAGEMENT

async function getPasswordHash (userId) {
  const db = await getUserDB(userId);
  const last = db.prepare('SELECT hash FROM passwords ORDER BY time DESC LIMIT 1').get();
  return last?.hash;
}

async function addPasswordHash (userId, passwordHash, createdBy, time = timestamp.now()) {
  const db = await getUserDB(userId);
  const result = { time, hash: passwordHash, createdBy };
  db.prepare('INSERT INTO passwords (time, hash, createdBy) VALUES (@time, @hash, @createdBy)').run(result);
  return result;
}

async function getCurrentPasswordTime (userId) {
  const db = await getUserDB(userId);
  const last = db.prepare('SELECT hash, time FROM passwords ORDER BY time DESC LIMIT 1').get();
  if (!last) {
    throw new Error(`No password found in database for user id "${userId}"`);
  }
  return last.time;
}

async function passwordExistsInHistory (userId, password, historyLength) {
  const db = await getUserDB(userId);
  const getLastN = db.prepare('SELECT hash, time FROM passwords ORDER BY time DESC LIMIT ?');
  for (const entry of getLastN.iterate(historyLength)) {
    if (await encryption.compare(password, entry.hash)) {
      return true;
    }
  }
  return false;
}

/**
 * Retreive all password history, used for Migration
 */
async function _getPasswordHistory (userId) {
  const db = await getUserDB(userId);
  const res = [];
  const getALL = db.prepare('SELECT hash, time FROM passwords');
  for (const entry of getALL.iterate()) {
    res.push(entry);
  }
  return res;
}

/**
 * Retreive all strore data, used for Migration
 */
async function _getAllStoreData (userId) {
  const db = await getUserDB(userId);
  const res = [];
  const getALL = db.prepare('SELECT * FROM storeKeyValueData');
  for (const entry of getALL.iterate()) {
    res.push(entry);
  }
  return res;
}

/**
 * Clear data for user, used for migration
 */
async function _clearStoreData (userId) {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM storeKeyValueData').run();
}

// PER-STORE KEY-VALUE DB

function getKeyValueDataForStore (storeId) {
  return new StoreKeyValueData(storeId);
}

/**
 * @constructor
 * @param {string} storeId
 */
function StoreKeyValueData (storeId) {
  this.storeId = storeId;
}

StoreKeyValueData.prototype.getAll = async function (userId) {
  const db = await getUserDB(userId);
  const query = db.prepare('SELECT key, value FROM storeKeyValueData WHERE storeId = @storeId');
  const res = {};
  for (const item of query.iterate({ storeId: this.storeId })) {
    res[item.key] = JSON.parse(item.value);
  }
  return res;
};

StoreKeyValueData.prototype.get = async function (userId, key) {
  const db = await getUserDB(userId);
  const res = db.prepare('SELECT value FROM storeKeyValueData WHERE storeId = @storeId AND key = @key').get({
    storeId: this.storeId,
    key
  });
  if (res?.value == null) return null;
  return JSON.parse(res.value);
};

StoreKeyValueData.prototype.set = async function (userId, key, value) {
  const db = await getUserDB(userId);
  if (value == null) {
    db.prepare('DELETE FROM storeKeyValueData WHERE storeId = @storeId AND key = @key)').run({
      storeId: this.storeId,
      key
    });
  } else {
    const valueStr = JSON.stringify(value);
    db.prepare('REPLACE INTO storeKeyValueData (storeId, key, value) VALUES (@storeId, @key, @value)').run({
      storeId: this.storeId,
      key,
      value: valueStr
    });
  }
};

// COMMON FUNCTIONS

/**
 * For tests
 */
async function clearHistory (userId) {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM passwords').run();
}

async function getUserDB (userId) {
  return dbCache.get(userId) || (await openUserDB(userId));
}

async function openUserDB (userId) {
  const userPath = await userLocalDirectory.ensureUserDirectory(userId);
  const dbPath = path.join(userPath, `account-${VERSION}.sqlite`);
  const db = new SQLite3(dbPath, DB_OPTIONS);
  db.pragma('journal_mode = WAL');
  // db.pragma('busy_timeout = 0'); // We take care of busy timeout ourselves as long as current driver does not go below the second
  db.unsafeMode(true);
  db.prepare('CREATE TABLE IF NOT EXISTS passwords (time REAL PRIMARY KEY, hash TEXT NOT NULL, createdBy TEXT NOT NULL);').run();
  db.prepare('CREATE INDEX IF NOT EXISTS passwords_hash ON passwords(hash);').run();
  db.prepare('CREATE TABLE IF NOT EXISTS storeKeyValueData (storeId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (storeId, key));').run();
  db.prepare('CREATE INDEX IF NOT EXISTS storeKeyValueData_storeId ON storeKeyValueData(storeId);').run();
  dbCache.set(userId, db);
  return db;
}
