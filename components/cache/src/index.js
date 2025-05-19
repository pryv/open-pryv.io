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
const { getLogger, getConfigUnsafe } = require('@pryv/boiler');
const LRU = require('lru-cache');
const _caches = {};
const MAX_PER_CACHE_SIZE = 2000; // maximum elements for each cache (namespace)
let synchro = null;
let isActive = false;
let isSynchroActive = false;
const logger = getLogger('cache');
const debug = {};
for (const key of ['set', 'get', 'unset', 'clear']) {
  const logg = logger.getLogger(key);
  debug[key] = function () {
    logg.debug(...arguments);
  };
}
const config = getConfigUnsafe(true);
/**
 * username -> userId
 */
const userIdForUsername = new Map();
/**
 * @param {string} namespace
 * @returns {any}
 */
function getNameSpace (namespace) {
  if (namespace == null) { console.log('XXXX', new Error('Null namespace')); }
  return (_caches[namespace] ||
        (_caches[namespace] = new LRU({
          max: MAX_PER_CACHE_SIZE
        })));
}
/**
 * @param {string} namespace
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function set (namespace, key, value) {
  if (!isActive) { return; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  getNameSpace(namespace).set(key, value);
  debug.set(namespace, key);
  return value;
}
/**
 * @param {string} namespace
 * @param {string} key
 * @returns {void}
 */
function unset (namespace, key) {
  if (!isActive) { return; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  getNameSpace(namespace).delete(key);
  debug.unset(namespace, key);
}
/**
 * @param {string} namespace
 * @param {string} key
 * @returns {any}
 */
function get (namespace, key) {
  if (!isActive) { return null; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  debug.get(namespace, key);
  return getNameSpace(namespace).get(key);
}
/**
 * @param {string} namespace
 * @returns {void}
 */
function clear (namespace) {
  if (namespace == null) {
    // clear all
    for (const ns of Object.keys(_caches)) {
      debug.clear(ns);
      delete _caches[ns];
    }
    debug.clear('userIdForUsername');
    userIdForUsername.clear();
  } else {
    delete _caches[namespace];
  }
  loadConfiguration(); // reload configuration
  debug.clear(namespace);
}
// --------------- Users ---------------//
/**
 * @param {string} username
 * @returns {string}
 */
function getUserId (username) {
  if (!isActive) { return; }
  debug.get('user-id', username);
  return userIdForUsername.get(username);
}
/**
 * @param {string} username
 * @param {string} userId
 * @returns {void}
 */
function setUserId (username, userId) {
  if (!isActive) { return; }
  debug.set('user-id', username, userId);
  userIdForUsername.set(username, userId);
}
/**
 * @param {string} username
 * @param {boolean} notifyOtherProcesses
 * @returns {void}
 */
function unsetUser (username, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  debug.unset('user-id', username);
  const userId = getUserId(username);
  if (userId == null) { return; }
  unsetUserData(userId, false);
  // notify userId delete
  if (notifyOtherProcesses && isSynchroActive) { synchro.unsetUser(username); }
  userIdForUsername.delete(username);
}
/**
 * @param {string} userId
 * @param {boolean} notifyOtherProcesses
 * @returns {void}
 */
function unsetUserData (userId, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  if (isSynchroActive) {
    synchro.removeListenerForUserId(userId);
  }
  // notify user data delete
  if (notifyOtherProcesses && isSynchroActive) {
    synchro.unsetUserData(userId);
  }
  _unsetStreams(userId, 'local'); // for now we hardcode local streams
  _clearAccessLogics(userId);
}
// --------------- Streams ---------------//
/**
 * @param {string} userId
 * @param {string} storeId
 * @returns {any[]}
 */
function getStreams (userId, storeId = 'local') {
  return get(NS.STREAMS_FOR_USERID + storeId, userId);
}
/**
 * @param {string} userId
 * @param {string} storeId
 * @param {Array<Stream>} streams
 * @returns {void}
 */
function setStreams (userId, storeId = 'local', streams) {
  if (!isActive) { return; }
  if (isSynchroActive) { synchro.registerListenerForUserId(userId); } // follow this user
  set(NS.STREAMS_FOR_USERID + storeId, userId, streams);
}
/**
 * @param {string} userId
 * @param {string} storeId
 * @returns {void}
 */
function _unsetStreams (userId, storeId = 'local') {
  unset(NS.STREAMS_FOR_USERID + storeId, userId);
}
/**
 * @param {string} userId
 * @param {string} storeId
 * @returns {void}
 */
function unsetStreams (userId, storeId = 'local') {
  unsetUserData(userId);
}
// --------------- Access Logic -----------//
/**
 * @param {string} userId
 * @param {string} token
 * @returns {any}
 */
function getAccessLogicForToken (userId, token) {
  if (!isActive) { return null; }
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) { return null; }
  return accessLogics.tokens[token];
}
/**
 * @param {string} userId
 * @param {string} accessId
 * @returns {any}
 */
function getAccessLogicForId (userId, accessId) {
  if (!isActive) { return null; }
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) { return null; }
  return accessLogics.ids[accessId];
}
/**
 * @param {string} userId
 * @param {string} accessLogic
 * @param {boolean} notifyOtherProcesses
 * @returns {void}
 */
function unsetAccessLogic (userId, accessLogic, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  // notify others to unsed
  if (notifyOtherProcesses && isSynchroActive) { synchro.unsetAccessLogic(userId, accessLogic); }
  // perform unset
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) { return; }
  delete accessLogics.tokens[accessLogic.token];
  delete accessLogics.ids[accessLogic.id];
}
/**
 * @param {string} userId
 * @returns {void}
 */
function _clearAccessLogics (userId) {
  unset(NS.ACCESS_LOGICS_FOR_USERID, userId);
}
/**
 * @param {string} userId
 * @param {{}} accessLogic
 * @returns {void}
 */
function setAccessLogic (userId, accessLogic) {
  if (!isActive) { return; }
  if (synchro != null) { synchro.registerListenerForUserId(userId); }
  let accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) {
    accessLogics = {
      tokens: {},
      ids: {}
    };
    set(NS.ACCESS_LOGICS_FOR_USERID, userId, accessLogics);
  }
  accessLogics.tokens[accessLogic.token] = accessLogic;
  accessLogics.ids[accessLogic.id] = accessLogic;
}
// ---------------
const NS = {
  USERID_BY_USERNAME: 'USERID_BY_USERNAME',
  STREAMS_FOR_USERID: 'STREAMS',
  ACCESS_LOGICS_FOR_USERID: 'ACCESS_LOGICS_BY_USERID'
};
const cache = {
  clear,
  getUserId,
  setUserId,
  unsetUser,
  unsetUserData,
  setStreams,
  getStreams,
  unsetStreams,
  getAccessLogicForId,
  getAccessLogicForToken,
  unsetAccessLogic,
  setAccessLogic,
  loadConfiguration,
  isActive,
  NS
};
/**
 * Used only from tests to reload configuration after settting changes
 * @returns {void}
 */
function loadConfiguration () {
  // could be true/false or 1/0 if launched from command line
  isActive = !!config.get('caching:isActive');
  isSynchroActive = !config.get('openSource:isActive');
  if (isSynchroActive) {
    synchro = require('./synchro');
    synchro.setCache(cache);
  }
}
loadConfiguration();
module.exports = cache;
