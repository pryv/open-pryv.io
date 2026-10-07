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
  unsetUser (username: string | null, userId?: string | null): void;
  unsetUserData (userId: string): void;
  unsetAccessLogic (userId: string, accessLogic: { id: string; token: string }): void;
};

const _caches: Record<string, InstanceType<typeof LRU>> = {};
const MAX_PER_CACHE_SIZE = 2000; // maximum elements for each cache (namespace)
const MAX_USERNAMES = 20000; // name -> userId entries (usernames and aliases)
const DEFAULT_MAX_AGE_SECONDS = 60;
// Max age of every cached entry (accesses, streams, name -> userId). Bounds how
// long a worker that missed an invalidation message can serve stale data.
let maxAgeMs = DEFAULT_MAX_AGE_SECONDS * 1000;
// Invariant: isSynchroActive === true implies synchro != null (both set
// together in loadConfiguration) — the `synchro!` uses below rely on it.
let synchro: SynchroModule | null = null;
let isActive = false;
let isSynchroActive = false;
// False while the pub/sub broker connection is down: invalidations sent in the
// meantime are lost, so reads miss and nothing is cached until it is back.
let isTrusted = true;
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
let userIdForUsername = newUsernameMap();
function newUsernameMap () {
  return new LRU({ max: MAX_USERNAMES, ttl: maxAgeMs });
}
function getNameSpace (namespace: string) {
  if (namespace == null) { console.log('XXXX', new Error('Null namespace')); }
  return (_caches[namespace] ||
        (_caches[namespace] = new LRU({
          max: MAX_PER_CACHE_SIZE,
          ttl: maxAgeMs
        })));
}
function set (namespace: string, key: string, value: unknown) {
  if (!isActive || !isTrusted) { return; }
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
  if (!isActive || !isTrusted) { return null; }
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
    _resetEpochs();
  } else {
    delete _caches[namespace];
  }
  loadConfiguration(); // reload configuration
  debug.clear(namespace);
}
// Every in-flight fill captured an epoch below the new floor, so none of them
// can insert after this (the counters are monotonic, never reset).
function _resetEpochs () {
  accessLogicEpochByUserId.clear();
  accessLogicEpochFloor = ++accessLogicEpochCounter;
  streamsEpochByKey.clear();
  streamsEpochFloor = ++streamsEpochCounter;
}
/**
 * Broker connection lost: stop serving and filling until it is back.
 */
function setUntrusted () {
  if (isTrusted) { logger.warn('pub/sub connection lost: caching suspended'); }
  isTrusted = false;
}
/**
 * Broker connection restored: drop everything cached before or during the gap
 * (invalidations sent then were lost), fence the fills in flight, resume.
 */
function flushAfterReconnect () {
  for (const ns of Object.keys(_caches)) { _caches[ns].clear(); }
  userIdForUsername.clear();
  _resetEpochs();
  isTrusted = true;
  logger.info('pub/sub connection restored: caches flushed');
}
function getMaxAgeMs (): number {
  return maxAgeMs;
}
// --------------- Users ---------------//
function getUserId (username: string) {
  if (!isActive || !isTrusted) { return; }
  debug.get('user-id', username);
  return userIdForUsername.get(username);
}
function setUserId (username: string, userId: string) {
  if (!isActive || !isTrusted) { return; }
  debug.set('user-id', username, userId);
  userIdForUsername.set(username, userId);
}
/**
 * Busts a name (username or alias). The message is always sent, with the
 * userId when this process knows it, so processes holding only the other
 * half of the mapping still clear it.
 */
function unsetUser (username: string, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  debug.unset('user-id', username);
  const userId = userIdForUsername.peek(username, { allowStale: true });
  if (notifyOtherProcesses && isSynchroActive) { synchro!.unsetUser(username, userId); }
  userIdForUsername.delete(username);
  if (userId != null) { _unsetUserLocal(userId); }
}
/**
 * Busts everything held for a userId (data and every name pointing to it), in
 * every process. Used on account deletion, where names may be unknown here.
 */
function unsetUserById (userId: string, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  debug.unset('user-id', userId);
  if (notifyOtherProcesses && isSynchroActive) { synchro!.unsetUser(null, userId); }
  _unsetUserLocal(userId);
}
function _unsetUserLocal (userId: string) {
  const names = [];
  for (const [name, id] of userIdForUsername.entries()) {
    if (id === userId) { names.push(name); }
  }
  for (const name of names) { userIdForUsername.delete(name); }
  unsetUserData(userId, false);
}
function unsetUserData (userId: string, notifyOtherProcesses = true) {
  if (!isActive) { return; }
  // The listener is kept: this user is still followed, so a bust sent before
  // the next fill is not missed.
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
let streamsEpochFloor = 0;
const streamsEpochByKey = new Map<string, number>();
function _streamsEpochKey (userId: string, storeId: string): string {
  return storeId + ' ' + userId;
}
/**
 * Called before a storage read whose result goes to setStreams. Also starts
 * following the user, so an invalidation sent during the read is received.
 */
function getStreamsEpoch (userId: string, storeId = 'local'): number {
  _followUser(userId);
  return streamsEpochByKey.get(_streamsEpochKey(userId, storeId)) ?? streamsEpochFloor;
}
function _peekStreamsEpoch (userId: string, storeId: string): number {
  return streamsEpochByKey.get(_streamsEpochKey(userId, storeId)) ?? streamsEpochFloor;
}
function _followUser (userId: string) {
  if (isActive && isSynchroActive) { synchro!.registerListenerForUserId(userId); }
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
  if (expectedEpoch != null && expectedEpoch !== _peekStreamsEpoch(userId, storeId)) { return; }
  _followUser(userId);
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
let accessLogicEpochFloor = 0;
const accessLogicEpochByUserId = new Map<string, number>();
/**
 * Called before a storage read whose result goes to setAccessLogic. Also
 * starts following the user, so an invalidation sent during the read is
 * received (and moves the epoch) instead of being missed.
 */
function getAccessLogicEpoch (userId: string): number {
  _followUser(userId);
  return _peekAccessLogicEpoch(userId);
}
function _peekAccessLogicEpoch (userId: string): number {
  return accessLogicEpochByUserId.get(userId) ?? accessLogicEpochFloor;
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
  if (expectedEpoch != null && expectedEpoch !== _peekAccessLogicEpoch(userId)) { return; }
  if (!isTrusted) { return; }
  _followUser(userId);
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
  unsetUserById,
  unsetUserData,
  setUntrusted,
  flushAfterReconnect,
  getMaxAgeMs,
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
  const maxAgeSeconds = Number(config.get('caching:accessMaxAgeSeconds') ?? DEFAULT_MAX_AGE_SECONDS);
  if (Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0) {
    maxAgeMs = Math.max(1, Math.round(maxAgeSeconds * 1000));
  } else {
    // 0 would mean "no expiry" to the LRU: never accept it silently
    logger.warn('caching:accessMaxAgeSeconds must be a positive number, using ' + DEFAULT_MAX_AGE_SECONDS);
    maxAgeMs = DEFAULT_MAX_AGE_SECONDS * 1000;
  }
  if (userIdForUsername.ttl !== maxAgeMs) {
    // max age changed: entries built with the previous one are dropped
    userIdForUsername = newUsernameMap();
    for (const ns of Object.keys(_caches)) { delete _caches[ns]; }
  }
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
