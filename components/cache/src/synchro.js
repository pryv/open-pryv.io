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
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('cache:synchro');
const { pubsub } = require('messages');
let cache = null;
/**
 * userId -> listener
 */
const listenerMap = new Map();
const MESSAGES = {
  UNSET_ACCESS_LOGIC: 'unset-access-logic',
  UNSET_USER_DATA: 'unset-user-data',
  UNSET_USER: 'unset-user'
};
// ------- listener
// listen for a userId
/**
 * @param {string} userId
 * @returns {void}
 */
function registerListenerForUserId (userId) {
  logger.debug('activate listener for user:', userId);
  if (listenerMap.has(userId)) { return; }
  listenerMap.set(userId, pubsub.cache.onAndGetRemovable(userId, (msg) => {
    handleMessage(userId, msg);
  }));
}
// unregister listner
/**
 * @param {string} userId
 * @returns {void}
 */
function removeListenerForUserId (userId) {
  logger.debug('disable listener for user:', userId);
  if (!listenerMap.has(userId)) { return; }
  listenerMap.get(userId)(); // remove listener
  listenerMap.delete(userId);
}
// listener
/**
 * @param {string} userId
 * @param {Message} msg
 * @returns {any}
 */
function handleMessage (userId, msg) {
  logger.debug('handleMessage', userId, msg);
  if (msg.action === MESSAGES.UNSET_ACCESS_LOGIC) {
    return cache.unsetAccessLogic(userId, { id: msg.accessId, token: msg.accessToken }, false);
  }
  if (msg.action === MESSAGES.UNSET_USER_DATA) {
    // streams and accesses
    return cache.unsetUserData(userId, false);
  }
  if (msg.action === MESSAGES.UNSET_USER) {
    return cache.unsetUser(msg.username, false);
  }
}
// ------- emitter
/**
 * @param {string} userId
 * @returns {void}
 */
function unsetAccessLogic (userId, accessLogic) {
  pubsub.cache.emit(userId, {
    action: MESSAGES.UNSET_ACCESS_LOGIC,
    accessId: accessLogic.id,
    accessToken: accessLogic.token
  });
}
/**
 * @param {string} userId
 * @returns {void}
 */
function unsetUserData (userId) {
  pubsub.cache.emit(userId, {
    action: MESSAGES.UNSET_USER_DATA
  });
}
/**
 * @param {string} username
 * @returns {void}
 */
function unsetUser (username) {
  pubsub.cache.emit(MESSAGES.UNSET_USER, {
    username
  });
}
// register cache here (to avoid require cycles)
/**
 * @returns {void}
 */
function setCache (c) {
  if (cache !== null) {
    return; // cache already set
  }
  cache = c;
  pubsub.cache.on(MESSAGES.UNSET_USER, function (msg) {
    cache.unsetUser(msg.username, false);
  });
}
module.exports = {
  registerListenerForUserId,
  unsetAccessLogic,
  unsetUserData,
  unsetUser,
  setCache,
  listenerMap,
  removeListenerForUserId,
  MESSAGES
};

/**
 * @typedef {{
 *   action: string;
 *   username?: string;
 *   accessId?: string;
 *   accessToken?: string;
 * }} Message
 */
