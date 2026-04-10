/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
