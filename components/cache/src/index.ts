/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getLogger, getConfig } = require('@pryv/boiler');
const { LRUCache: LRU } = require('lru-cache');
const _caches: any = {};
const MAX_PER_CACHE_SIZE = 2000; // maximum elements for each cache (namespace)
let synchro: any = null;
let isActive = false;
let isSynchroActive = false;
const logger = getLogger('cache');
const debug: any = {};
for (const key of ['set', 'get', 'unset', 'clear']) {
  const logg = logger.getLogger(key);
  debug[key] = function () {
    logg.debug(...arguments);
  };
}
/**
 * username -> userId
 */
const userIdForUsername = new Map();
function getNameSpace (namespace) {
  if (namespace == null) { console.log('XXXX', new Error('Null namespace')); }
  return (_caches[namespace] ||
        (_caches[namespace] = new LRU({
          max: MAX_PER_CACHE_SIZE
        })));
}
function set (namespace, key, value) {
  if (!isActive) { return; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  getNameSpace(namespace).set(key, value);
  debug.set(namespace, key);
  return value;
}
function unset (namespace, key) {
  if (!isActive) { return; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  getNameSpace(namespace).delete(key);
  debug.unset(namespace, key);
}
function get (namespace, key) {
  if (!isActive) { return null; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  debug.get(namespace, key);
  return getNameSpace(namespace).get(key);
}
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
function getUserId (username) {
  if (!isActive) { return; }
  debug.get('user-id', username);
  return userIdForUsername.get(username);
}
function setUserId (username, userId) {
  if (!isActive) { return; }
  debug.set('user-id', username, userId);
  userIdForUsername.set(username, userId);
}
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
function getStreams (userId, storeId = 'local') {
  return get(NS.STREAMS_FOR_USERID + storeId, userId);
}
function setStreams (userId, storeId = 'local', streams) {
  if (!isActive) { return; }
  if (isSynchroActive) { synchro.registerListenerForUserId(userId); } // follow this user
  set(NS.STREAMS_FOR_USERID + storeId, userId, streams);
}
function _unsetStreams (userId, storeId = 'local') {
  unset(NS.STREAMS_FOR_USERID + storeId, userId);
}
function unsetStreams (userId, storeId = 'local') {
  unsetUserData(userId);
}
// --------------- Access Logic -----------//
function getAccessLogicForToken (userId, token) {
  if (!isActive) { return null; }
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) { return null; }
  return accessLogics.tokens[token];
}
function getAccessLogicForId (userId, accessId) {
  if (!isActive) { return null; }
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) { return null; }
  return accessLogics.ids[accessId];
}
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
function _clearAccessLogics (userId) {
  unset(NS.ACCESS_LOGICS_FOR_USERID, userId);
}
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
 * Awaits boiler's full config then activates the cache + wires the
 * cluster-wide synchro. Runs as a fire-and-forget at module-bottom so
 * every consumer of `require('cache')` sees the same eventually-active
 * instance — and crucially, sees the SAME view across the api-server
 * forked-child + mocha-parent processes (they both await the full config
 * before flipping `isActive`, instead of capturing a partial snapshot at
 * module-load like the legacy `getConfigUnsafe(true)` pattern did).
 *
 * Cache ops short-circuit on `!isActive`, so the brief async window
 * between module-load and `loadConfiguration` resolving is safe — it
 * just no-ops, matching what partial-config used to do.
 *
 * Consumers that want to reload after mutating config (test helpers
 * calling `cache.clear()`) get the reload async too; the returned
 * promise can be awaited if a test needs the post-reload state.
 */
async function loadConfiguration () {
  const config = await getConfig();
  // could be true/false or 1/0 if launched from command line
  isActive = !!config.get('caching:isActive');
  isSynchroActive = true;
  if (isSynchroActive) {
    synchro = require('./synchro.ts');
    synchro.setCache(cache);
  }
}
loadConfiguration().catch((err) => {
  // observability shim already swallows boot failures with a stderr
  // message; do the same here so a config-misconfig doesn't kill the
  // master process. Cache stays inactive, ops no-op.
  process.stderr.write('[cache] loadConfiguration at boot failed: ' + (err.message || err) + '\n');
});

export default cache;
export { cache };
