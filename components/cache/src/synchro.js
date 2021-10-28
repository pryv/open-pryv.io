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

const { getLogger } = require('@pryv/boiler');
const logger = getLogger('cache:synchro');
const { pubsub } = require('messages');
let cache = null;

const listenerMap = {};


// ------- listener 

// listen for a userId
function trackChangesForUserId(userId) {
  logger.debug('activate changes for user:', userId);
  if (listenerMap[userId] != null) return;
  listenerMap[userId] = pubsub.cache.onAndGetRemovable(userId, (msg) => { handleMessage(userId, msg); });
}

// unregister listner
function removeChangeTracker(userId) {
  logger.debug('remove changes for user:', userId);
  if (listenerMap[userId] == null) return;
  listenerMap[userId](); // remove listener
  delete listenerMap[userId];
}

// listener 
function handleMessage(userId, msg) {
  logger.debug('handleMessage', userId, msg);
  if (msg.action == 'unset-access-logic') {
    return cache.unsetAccessLogic(userId, {id: msg.accessId, token: msg.accessToken}, false);
  }
  if (msg.action == 'clear') {
    removeChangeTracker(userId);
    return cache.clearUserId(userId, false);
  }
}

// ------- emitter 

// emit message "unset" to listners
function unsetAccessLogic(userId, accessLogic) {
  pubsub.cache.emit(userId, {action: 'unset-access-logic', userId, accessId: accessLogic.id, accessToken: accessLogic.token});
}

// emit message "clear" to listners
function clearUserId(userId) {
  removeChangeTracker(userId);
  pubsub.cache.emit(userId, {action: 'clear'});
}


// register cache here (to avoid require cycles)
function setCache(c) {
  cache = c;
}


module.exports = {
  trackChangesForUserId,
  unsetAccessLogic,
  clearUserId,
  setCache,
  listenerMap, // exported for tests only
  removeChangeTracker, // exported for tests only
}