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

type SynchroModule = {
  setCache (cache: unknown): void;
  registerListenerForUserId (userId: string): void;
  removeListenerForUserId (userId: string): void;
  unsetUser (username: string): void;
  unsetUserData (userId: string): void;
  unsetAccessLogic (userId: string, accessLogic: { id: string; token: string }): void;
};

const _caches: Record<string, InstanceType<typeof LRU>> = {};
const MAX_PER_CACHE_SIZE = 2000; // maximum elements for each cache (namespace)
// Invariant: isSynchroActive === true implies synchro != null (both set
// together in loadConfiguration) — the `synchro!` uses below rely on it.
let synchro: SynchroModule | null = null;
let isActive = false;
let isSynchroActive = false;
const logger = getLogger('cache');
const debug: Record<string, (...args: unknown[]) => void> = {};
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
function getNameSpace (namespace: string) {
  if (namespace == null) { console.log('XXXX', new Error('Null namespace')); }
  return (_caches[namespace] ||
        (_caches[namespace] = new LRU({
          max: MAX_PER_CACHE_SIZE
        })));
}
function set (namespace: string, key: string, value: unknown) {
  if (!isActive) { return; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  getNameSpace(namespace).set(key, value);
  debug.set(namespace, key);
  return value;
}
function unset (namespace: string, key: string) {
  if (!isActive) { return; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  getNameSpace(namespace).delete(key);
  debug.unset(namespace, key);
}
function get (namespace: string, key: string) {
  if (!isActive) { return null; }
  if (key == null) { throw new Error('Null key for' + namespace); }
  debug.get(namespace, key);
  return getNameSpace(namespace).get(key);
}
function clear (namespace?: string) {
  if (namespace == null) {
    // clear all
    for (const ns of Object.keys(_caches)) {
      debug.clear(ns);
      delete _caches[ns];
    }
    debug.clear('userIdForUsername');
    userIdForUsername.clear();
    // Counter stays monotonic (NOT reset), so clearing the map is safe: any
    // epoch captured before this clear stays strictly below all future bumps.
    accessLogicEpochByUserId.clear();
    streamsEpochByKey.clear();
  } else {
    delete _caches[namespace];
  }
  loadConfiguration(); // reload configuration
  debug.clear(namespace);
}
// --------------- Users ---------------//
function getUserId (username: string) {
  if (!isActive) { return; }
  debug.get('user-id', username);
  return userIdForUsername.get(username);
}
function setUserId (username: string, userId: string) {
  if (!isActive) { return; }
  debug.set('user-id', username, userId);
  userIdForUsername.set(username, userId);
}
function unsetUser (username: string, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  debug.unset('user-id', username);
  const userId = getUserId(username);
  if (userId == null) { return; }
  unsetUserData(userId, false);
  // notify userId delete
  if (notifyOtherProcesses && isSynchroActive) { synchro!.unsetUser(username); }
  userIdForUsername.delete(username);
}
function unsetUserData (userId: string, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  if (isSynchroActive) {
    synchro!.removeListenerForUserId(userId);
  }
  // notify user data delete
  if (notifyOtherProcesses && isSynchroActive) {
    synchro!.unsetUserData(userId);
  }
  _unsetStreams(userId, 'local'); // for now we hardcode local streams
  _clearAccessLogics(userId);
}
// --------------- Streams ---------------//
// Per-(user, store) "streams unset epoch": the same set-after-unset fence as the
// access-logic epoch above, for the streams cache. A producer captures the epoch
// on a cache miss before its storage read and passes it back to setStreams, which
// skips re-inserting a now-stale stream tree if an invalidation (local unset or a
// cross-process synchro bust) moved it meanwhile. Monotonic counter, same ABA-safe
// reasoning as the access epoch.
let streamsEpochCounter = 0;
const streamsEpochByKey = new Map<string, number>();
function _streamsEpochKey (userId: string, storeId: string): string {
  return storeId + ' ' + userId;
}
function getStreamsEpoch (userId: string, storeId = 'local'): number {
  return streamsEpochByKey.get(_streamsEpochKey(userId, storeId)) ?? 0;
}
function _bumpStreamsEpoch (userId: string, storeId: string): void {
  streamsEpochByKey.set(_streamsEpochKey(userId, storeId), ++streamsEpochCounter);
}
function getStreams (userId: string, storeId = 'local') {
  return get(NS.STREAMS_FOR_USERID + storeId, userId);
}
function setStreams (userId: string, storeId = 'local', streams?: unknown, expectedEpoch?: number) {
  if (!isActive) { return; }
  // set-after-unset fence: skip the insert if an invalidation bumped the epoch
  // since the caller captured it (a stale read must not re-poison the cache).
  if (expectedEpoch != null && expectedEpoch !== getStreamsEpoch(userId, storeId)) { return; }
  if (isSynchroActive) { synchro!.registerListenerForUserId(userId); } // follow this user
  set(NS.STREAMS_FOR_USERID + storeId, userId, streams);
}
function _unsetStreams (userId: string, storeId = 'local') {
  _bumpStreamsEpoch(userId, storeId);
  unset(NS.STREAMS_FOR_USERID + storeId, userId);
}
function unsetStreams (userId: string, _storeId = 'local') {
  unsetUserData(userId);
}
// --------------- Access Logic -----------//
// Per-user "access-logic unset epoch": a fence against a set-after-unset race.
// A caller that reads an access from storage and then calls setAccessLogic can
// have a concurrent invalidation (a local unset, or a cross-process synchro
// bust) land during its await, so its continuation would re-insert a stale
// AccessLogic. Callers capture the epoch BEFORE the read and pass it back to
// setAccessLogic, which skips the insert when the epoch moved. The counter is
// globally monotonic (never reset), so an epoch captured before a clear()/LRU
// eviction can never match a later read, making both safe by construction. The
// map holds one small entry per user ever invalidated since boot: unbounded but
// tiny, no eviction needed.
let accessLogicEpochCounter = 0;
const accessLogicEpochByUserId = new Map<string, number>();
function getAccessLogicEpoch (userId: string): number {
  return accessLogicEpochByUserId.get(userId) ?? 0;
}
function _bumpAccessLogicEpoch (userId: string): void {
  accessLogicEpochByUserId.set(userId, ++accessLogicEpochCounter);
}
function getAccessLogicForToken (userId: string, token: string) {
  if (!isActive) { return null; }
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) { return null; }
  return accessLogics.tokens[token];
}
function getAccessLogicForId (userId: string, accessId: string) {
  if (!isActive) { return null; }
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) { return null; }
  return accessLogics.ids[accessId];
}
function unsetAccessLogic (userId: string, accessLogic: { id: string; token: string }, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  // Bump BEFORE the `accessLogics == null` early return: the invalidation is
  // semantic and must fence an in-flight read even when nothing is cached here
  // (entry evicted, or never cached in this worker).
  _bumpAccessLogicEpoch(userId);
  // notify others to unsed
  if (notifyOtherProcesses && isSynchroActive) { synchro!.unsetAccessLogic(userId, accessLogic); }
  // perform unset
  const accessLogics = get(NS.ACCESS_LOGICS_FOR_USERID, userId);
  if (accessLogics == null) { return; }
  delete accessLogics.tokens[accessLogic.token];
  delete accessLogics.ids[accessLogic.id];
}
function _clearAccessLogics (userId: string) {
  _bumpAccessLogicEpoch(userId);
  unset(NS.ACCESS_LOGICS_FOR_USERID, userId);
}
function setAccessLogic (userId: string, accessLogic: { id: string; token: string }, expectedEpoch?: number) {
  if (!isActive) { return; }
  // set-after-unset fence: skip the insert if an invalidation bumped the epoch
  // since the caller captured it (a stale read must not re-poison the cache).
  if (expectedEpoch != null && expectedEpoch !== getAccessLogicEpoch(userId)) { return; }
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
  getStreamsEpoch,
  unsetStreams,
  getAccessLogicForId,
  getAccessLogicForToken,
  getAccessLogicEpoch,
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
  // Synchro (cross-process cache invalidation) is deliberately ALWAYS ON: with
  // forked API workers, a cache bust in one process MUST propagate to the
  // others, so there is no safe "off" state and no config gate.
  isSynchroActive = true;
  synchro = require('./synchro.ts');
  synchro!.setCache(cache);
}
loadConfiguration().catch((err) => {
  // observability shim already swallows boot failures with a stderr
  // message; do the same here so a config-misconfig doesn't kill the
  // master process. Cache stays inactive, ops no-op.
  process.stderr.write('[cache] loadConfiguration at boot failed: ' + (err.message || err) + '\n');
});

export default cache;
export { cache };
