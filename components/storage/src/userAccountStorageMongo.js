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

const timestamp = require('unix-timestamp');
const encryption = require('utils').encryption;

let passwordsCollection = null;
let storesKeyValueCollection = null;

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
  _addKeyValueData
};

async function init () {
  while (initState === InitStates.INITIALIZING) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (initState === InitStates.READY) {
    return;
  }
  initState = InitStates.INITIALIZING;
  const { getDatabase } = require('storage');
  const db = await getDatabase();
  passwordsCollection = await db.getCollection({
    name: 'passwords',
    indexes: [
      {
        index: { userId: 1 },
        options: { }
      },
      {
        index: { userId: 1, time: 1 },
        options: { unique: true, background: false }
      }
    ]
  });
  storesKeyValueCollection = await db.getCollection({
    name: 'stores-key-value',
    indexes: [
      {
        index: { storeId: 1, userId: 1, key: 1 },
        options: { unique: true }
      }
    ]
  });
  initState = InitStates.READY;
}

// PASSWORD MANAGEMENT

async function getPasswordHash (userId) {
  const last = await passwordsCollection.findOne({ userId }, { sort: { time: -1 } });
  return last?.hash;
}

async function addPasswordHash (userId, passwordHash, createdBy, time = timestamp.now()) {
  const item = { userId, time, hash: passwordHash, createdBy };
  try {
    await passwordsCollection.insertOne(item);
  } catch (e) {
    console.log(e.message);
    if (e.message && e.message.startsWith('E11000 duplicate key error collection: pryv-node-test.passwords index: userId_1_time_1 dup key')) {
      throw new Error('UNIQUE constraint failed: passwords.time');
    }
    throw e;
  }

  return item;
}

async function getCurrentPasswordTime (userId) {
  const last = await passwordsCollection.findOne({ userId }, { sort: { time: -1 } });
  if (!last) {
    throw new Error(`No password found in database for user id "${userId}"`);
  }
  return last.time;
}

async function passwordExistsInHistory (userId, password, historyLength) {
  const lastCursor = await passwordsCollection.find({ userId }, { sort: { time: -1 }, limit: historyLength });
  for await (const entry of lastCursor) {
    if (await encryption.compare(password, entry.hash)) {
      return true;
    }
  }
  return false;
}

// PER-STORE KEY-VALUE DB

/**
 * Raw insert used for migration
 */
async function _addKeyValueData (storeId, userId, key, value) {
  await storesKeyValueCollection.insertOne({ storeId, userId, key, value });
}

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
  const resultCursor = await storesKeyValueCollection.find({ userId, storeId: this.storeId });
  const res = {};
  for await (const item of resultCursor) {
    res[item.key] = item.value;
  }
  return res;
};

StoreKeyValueData.prototype.get = async function (userId, key) {
  const res = await storesKeyValueCollection.findOne({ userId, storeId: this.storeId, key });
  return res?.value || null;
};

StoreKeyValueData.prototype.set = async function (userId, key, value) {
  if (value == null) {
    await storesKeyValueCollection.deleteOne({ userId, storeId: this.storeId, key });
  } else {
    await storesKeyValueCollection.updateOne({ userId, storeId: this.storeId, key }, { $set: { userId, storeId: this.storeId, key, value } }, { upsert: true });
  }
};

// COMMON FUNCTIONS

/**
 * For tests
 */
async function clearHistory (userId) {
  await passwordsCollection.deleteMany({ userId });
}
