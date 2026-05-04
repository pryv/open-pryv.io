/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Access-request state store, backed by PlatformDB (rqlite `keyValue`).
 *
 * Why PlatformDB and not an in-process Map: under `cluster.fork()` each
 * worker is a separate Node process. A POST to `/reg/access` lands on
 * worker A and writes; the polling GETs round-robin across workers, so
 * worker B's lookup sees nothing and 400s. Backing the store on rqlite
 * keeps it cluster-wide and worker-symmetric (and survives restart, which
 * is operator-friendly for mid-flow auth requests).
 *
 * Replaces the in-memory `new Map()` from the original v2 implementation
 * (which itself replaced v1's Redis store; the regression was "Map ≠ shared
 * across workers"). See workspace plan 55 + GH issue
 * pryv/open-pryv.io#67 for the production reproducer.
 */

const crypto = require('node:crypto');

const KEY_LENGTH = 16;
const DEFAULT_TTL_MS = 3600 * 1000; // 1 hour

function getPlatformDB () {
  return require('storages').platformDB;
}

/**
 * Generate a random alphanumeric key.
 * @returns {string}
 */
function generateKey () {
  return crypto.randomBytes(KEY_LENGTH).toString('base64url').slice(0, KEY_LENGTH);
}

/**
 * Build a fresh access-request state in memory. Does NOT persist — callers
 * decorate the state with `pollUrl` / `authUrl` (computed from
 * core-affine routing) and then call `persist()` to flush it to PlatformDB
 * in a single write.
 *
 * Splitting create into build + persist avoids a read-modify-write
 * round-trip we'd otherwise need to add the URLs after the initial save.
 *
 * @param {Object} params
 * @returns {{ key: string, state: Object, expiresAt: number }}
 */
function buildState (params) {
  const key = generateKey();
  const ttl = params.expireAfter || DEFAULT_TTL_MS;
  const expiresAt = Date.now() + ttl;
  const state = {
    status: 'NEED_SIGNIN',
    code: 201,
    key,
    requestingAppId: params.requestingAppId,
    requestedPermissions: params.requestedPermissions,
    languageCode: params.languageCode || 'en',
    returnURL: params.returnURL ?? null,
    oauthState: params.oauthState || null,
    clientData: params.clientData || null,
    deviceName: params.deviceName || null,
    poll_rate_ms: 1000,
    createdAt: Date.now(),
    expiresAt
  };
  return { key, state, expiresAt };
}

/**
 * Persist an in-memory state to PlatformDB. Used both for the initial
 * write after `buildState()` and to push subsequent mutations of `state`
 * back to the store.
 *
 * @param {string} key
 * @param {Object} state
 * @param {number} [expiresAt] - defaults to `state.expiresAt`
 */
async function persist (key, state, expiresAt) {
  const ts = expiresAt ?? state.expiresAt;
  await getPlatformDB().setAccessState(key, state, ts);
}

/**
 * Compatibility shim — older code paths called `create()` and then
 * mutated the returned `state`. The mutation was lost on PlatformDB-backed
 * writes; new code should use `buildState()` + `persist()` instead. Kept
 * for tests and any external caller that doesn't decorate the state.
 *
 * @param {Object} params
 * @returns {Promise<{ key: string, state: Object }>}
 */
async function create (params) {
  const built = buildState(params);
  await persist(built.key, built.state, built.expiresAt);
  return { key: built.key, state: built.state };
}

/**
 * Get an access request state.
 * @param {string} key
 * @returns {Promise<Object|null>}
 */
async function get (key) {
  const row = await getPlatformDB().getAccessState(key);
  return row ? row.value : null;
}

/**
 * Update an access request state (accept or refuse).
 * @param {string} key
 * @param {Object} update
 * @returns {Promise<Object|null>} the updated state, or null if key not found.
 */
async function update (key, update) {
  const platformDB = getPlatformDB();
  const row = await platformDB.getAccessState(key);
  if (!row) return null;
  const state = row.value;
  Object.assign(state, update);
  if (update.status === 'ACCEPTED') {
    state.code = 200;
  } else if (update.status === 'REFUSED' || update.status === 'ERROR') {
    state.code = 403;
  } else if (update.status === 'REDIRECTED') {
    state.code = 301;
  }
  await platformDB.setAccessState(key, state, row.expiresAt);
  return state;
}

/**
 * Delete an access request.
 * @param {string} key
 * @returns {Promise<void>}
 */
async function remove (key) {
  await getPlatformDB().deleteAccessState(key);
}

/**
 * Clear all entries (used by tests). Calls the master sweep with `now =
 * Infinity` so every row is dropped.
 * @returns {Promise<{removed: number}>}
 */
async function clear () {
  return await getPlatformDB().sweepExpiredAccessStates(Number.POSITIVE_INFINITY);
}

module.exports = { buildState, persist, create, get, update, remove, clear };
