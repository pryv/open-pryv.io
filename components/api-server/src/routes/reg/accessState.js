/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * In-memory access request state store with TTL.
 * Replaces Redis-based storage from service-register.
 * Ephemeral by design — access requests don't survive restarts.
 */

const crypto = require('node:crypto');

const KEY_LENGTH = 16;
const DEFAULT_TTL_MS = 3600 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 60 * 1000; // sweep every minute

const store = new Map();
let cleanupTimer = null;

/**
 * Generate a random alphanumeric key.
 * @returns {string}
 */
function generateKey () {
  return crypto.randomBytes(KEY_LENGTH).toString('base64url').slice(0, KEY_LENGTH);
}

/**
 * Create a new access request.
 * @param {Object} params
 * @param {string} params.requestingAppId
 * @param {Array} params.requestedPermissions
 * @param {string} [params.languageCode]
 * @param {string|null} [params.returnURL]
 * @param {string} [params.oauthState]
 * @param {*} [params.clientData]
 * @param {string} [params.deviceName]
 * @param {number} [params.expireAfter] - TTL in ms
 * @returns {{ key: string, state: Object }}
 */
function create (params) {
  const key = generateKey();
  const ttl = params.expireAfter || DEFAULT_TTL_MS;
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
    expiresAt: Date.now() + ttl
  };
  store.set(key, state);
  ensureCleanup();
  return { key, state };
}

/**
 * Get an access request state.
 * @param {string} key
 * @returns {Object|null}
 */
function get (key) {
  const state = store.get(key);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    store.delete(key);
    return null;
  }
  return state;
}

/**
 * Update an access request state (accept or refuse).
 * @param {string} key
 * @param {Object} update - { status, username, token, apiEndpoint, reasonID, message }
 * @returns {Object|null} updated state, or null if key not found
 */
function update (key, update) {
  const state = get(key);
  if (!state) return null;
  Object.assign(state, update);
  if (update.status === 'ACCEPTED') {
    state.code = 200;
  } else if (update.status === 'REFUSED' || update.status === 'ERROR') {
    state.code = 403;
  } else if (update.status === 'REDIRECTED') {
    state.code = 301;
  }
  return state;
}

/**
 * Delete an access request.
 * @param {string} key
 */
function remove (key) {
  store.delete(key);
}

/**
 * Clear all entries (for testing).
 */
function clear () {
  store.clear();
}

/**
 * Start the TTL cleanup timer if not running.
 */
function ensureCleanup () {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of store) {
      if (now > state.expiresAt) store.delete(key);
    }
    if (store.size === 0) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref(); // don't keep process alive
}

module.exports = { create, get, update, remove, clear };
