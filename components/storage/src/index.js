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
const Access = require('./user/Accesses');
const Stream = require('./user/Streams');
const Database = require('./Database');
const StorageLayer = require('./StorageLayer');
const { getConfigUnsafe, getConfig } = require('@pryv/boiler');
const { dataBaseTracer } = require('tracing');
const usersLocalIndex = require('./usersLocalIndex');
const userAccountStorage = require('./userAccountStorage');

module.exports = {
  Database: require('./Database'),
  PasswordResetRequests: require('./PasswordResetRequests'),
  Sessions: require('./Sessions'),
  Size: require('./Size'),
  Versions: require('./Versions'),
  user: {
    Accesses: Access,
    FollowedSlices: require('./user/FollowedSlices'),
    Profile: require('./user/Profile'),
    Streams: Stream,
    Webhooks: require('./user/Webhooks')
  },
  StorageLayer,
  getDatabase,
  getStorageLayer,
  getDatabaseSync,
  userLocalDirectory: require('./userLocalDirectory'),
  getUsersLocalIndex,
  getUserAccountStorage
};

let usersIndex;
async function getUsersLocalIndex () {
  if (!usersIndex) {
    usersIndex = usersLocalIndex;
    await usersIndex.init();
  }
  return usersIndex;
}

let userAccount;
async function getUserAccountStorage () {
  if (!userAccount) {
    userAccount = userAccountStorage;
    await userAccountStorage.init();
  }
  return userAccountStorage;
}

let storageLayer;
/**
 * @returns {StorageLayer}
 */
async function getStorageLayer () {
  if (storageLayer) { return storageLayer; }
  const config = await getConfig();
  storageLayer = new StorageLayer();
  await storageLayer.init(_getDatabase(config));
  return storageLayer;
}

/**
 * @returns {any}
 */
function getDatabaseSync (warnOnly) {
  return _getDatabase(getConfigUnsafe(warnOnly));
}

/**
 * @returns {Promise<any>}
 */
async function getDatabase () {
  const db = _getDatabase(await getConfig());
  await db.ensureConnect();
  return db;
}

let database;
/**
 * @returns {any}
 */
function _getDatabase (config) {
  if (!database) {
    database = new Database(config.get('database'));
    dataBaseTracer(database);
  }
  return database;
}
