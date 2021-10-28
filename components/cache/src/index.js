/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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

const logger = getLogger('cache');
const debug = {};
for (const key of ['set', 'get', 'unset', 'clear']) {
  const logg = logger.getLogger(key);
  debug[key] = function() {
    logg.debug(...arguments);
  }
}

const config = getConfigUnsafe(true);

function getNameSpace(namespace) {
  if (namespace == null) console.log('XXXX', new Error('Null namespace'));
  return _caches[namespace] || ( _caches[namespace] = new LRU(MAX_PER_CACHE_SIZE) ); // seting maxsize of 2000 to LRU cache
}

function set(namespace, key, value) {
  if (! isActive) return;  
  if (key == null) throw new Error('Null key for' + namespace);
  getNameSpace(namespace).set(key, value);
  debug.set(namespace, key);
  return value;
}

function unset(namespace, key) {
  if (! isActive) return;
  if (key == null) throw new Error('Null key for' + namespace);
  getNameSpace(namespace).del(key);
  debug.unset(namespace, key);
}

function get(namespace, key) {
  if (! isActive) return null;
  if (key == null) throw new Error('Null key for' + namespace);
  debug.get(namespace, key);
  return getNameSpace(namespace).get(key);
}

function clear(namespace) {
  if (namespace == null) { // clear all
    for (const ns of Object.keys(_caches)) {
      debug.clear(ns);
      delete _caches[ns];
    }
  } else {
    delete _caches[namespace];
  }
  loadConfiguration(); // reload configuration
  debug.clear(namespace);
}

function clearUserId(userId, notifyOtherProcesses = true) {
  if (! isActive) return;
  if (notifyOtherProcesses && synchro != null) synchro.clearUserId(userId);
  _unsetStreams(userId, 'local'); // for now we hardcode local streams
  clearAccessLogics(userId);
}

//--------------- Streams ---------------//
function getStreams(userId, key) {
  return get(NS.STREAMS_FOR_USERID + key, userId);
}

function setStreams(userId, key, streams) {
  if (! isActive) return;
  if (synchro != null) synchro.trackChangesForUserId(userId); // follow this user
  set(NS.STREAMS_FOR_USERID + key, userId, streams);
}

function _unsetStreams(userId, key) {
  unset(NS.STREAMS_FOR_USERID + key, userId);
}

function unsetStreams(userId, key) { 
  clearUserId(userId); // for now we just fully clear this user.. 
}


//--------------- Access Logic -----------//

function getAccessLogicForToken(userId, token) {
  if (! isActive) return null;
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) return null;
  return accessLogics.tokens[token];
}

function getAccessLogicForId(userId, accessId) {
  if (! isActive) return null;
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) return null;
  return accessLogics.ids[accessId];
}


function unsetAccessLogic(userId, accessLogic, notifyOtherProcesses = true) {
  if (! isActive) return;
  if (notifyOtherProcesses && synchro != null) synchro.unsetAccessLogic(userId, accessLogic); // follow this user
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) return ;
  delete accessLogics.tokens[accessLogic.token];
  delete accessLogics.ids[accessLogic.id];
}

function clearAccessLogics(userId) {
  unset(NS.ACCESS_LOGICS_FOR_USERID, userId);
}

function setAccessLogic(userId, accessLogic) {
  if (! isActive) return;
  if (synchro != null) synchro.trackChangesForUserId(userId);
  let accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) {
    accessLogics = {
      tokens: {},
      ids: {}
    }
    set(NS.ACCESS_LOGICS_FOR_USERID, userId, accessLogics);
  }
  accessLogics.tokens[accessLogic.token] = accessLogic;
  accessLogics.ids[accessLogic.id] = accessLogic;
}

//---------------

/** Used only from tests to reload configuration after settting changes */
function loadConfiguration() {
  // could be true/false or 1/0 if launched from command line
  isActive = config.get('caching:isActive') ? true : false;
}
loadConfiguration();

const NS = {
  USERID_BY_USERNAME: 'USERID_BY_USERNAME',
  STREAMS_FOR_USERID: 'STREAMS',
  ACCESS_LOGICS_FOR_USERID: 'ACCESS_LOGICS_BY_USERID'
}

const cache = {
  set,
  unset,
  get,
  clear,

  clearUserId,

  getAccessLogicForId,
  getAccessLogicForToken,
  unsetAccessLogic,
  setAccessLogic,

  setStreams,
  getStreams,
  unsetStreams,

  loadConfiguration,
  isActive,

  NS
}


// load synchro if needed
if (! config.get('openSource:isActive')) {
  synchro = require('./synchro.js');
  synchro.setCache(cache);
}

module.exports = cache;
