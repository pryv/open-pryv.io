/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const { APIError, factory: apiErrors } = require('errors');
const { errors: dataStoreErrors } = require('@pryv/datastore');
// HACK: replace data store errors factory methods with API errors factory's
Object.assign(dataStoreErrors, apiErrors);

const LOCAL_STORE_ID = 'local';
const ACCOUNT_STORE_ID = 'account';
const STORE_ID_MARKER = ':';

const storeDataUtils = module.exports = {
  LocalStoreId: LOCAL_STORE_ID,
  AccountStoreId: ACCOUNT_STORE_ID,
  parseStoreIdAndStoreItemId,
  getFullItemId,
  isPassthroughStore,
  throwAPIError
};
Object.freeze(storeDataUtils);

/**
 * Whether the given store uses "passthrough" IDs — i.e. store-internal IDs
 * are the same as external IDs (no prefix add/remove by Mall).
 *
 * - `local`: items have no store prefix (e.g. `myStream`)
 * - `account`: items keep their `:_system:` / `:system:` prefix as-is
 *
 * @param {string} storeId
 * @returns {boolean}
 */
function isPassthroughStore (storeId) {
  return storeId === LOCAL_STORE_ID || storeId === ACCOUNT_STORE_ID;
}

/**
 * Extract the store id and the in-store item id (without the store reference) from the given item id.
 * For streams, converts the store's root pseudo-stream id (`:store:`) to `*`.
 * @param {string} fullItemId
 * @returns {string[]} `[storeId, storeItemId]`
 */
function parseStoreIdAndStoreItemId (fullItemId) {
  if (!fullItemId.startsWith(STORE_ID_MARKER)) return [LOCAL_STORE_ID, fullItemId];

  const endMarkerIndex = fullItemId.indexOf(STORE_ID_MARKER, 1);
  const storeId = fullItemId.substring(1, endMarkerIndex);

  // System streams route to the account store (passthrough — prefixed IDs preserved)
  if (storeId === 'system' || storeId === '_system') return [ACCOUNT_STORE_ID, fullItemId];

  let storeItemId;
  if (endMarkerIndex === (fullItemId.length - 1)) { // ':storeId:', i.e. pseudo-stream representing store root
    storeItemId = '*';
  } else {
    storeItemId = fullItemId.substring(endMarkerIndex + 1);
  }
  return [storeId, storeItemId];
}

/**
 * Get full item id from the given store id and in-store item id.
 * For streams, converts the `*` id to the store's root pseudo-stream (`:store:`).
 * @param {string} storeId
 * @param {string} storeItemId
 * @returns {string}
 */
function getFullItemId (storeId, storeItemId) {
  // Passthrough stores: store-internal IDs ARE the external IDs
  if (isPassthroughStore(storeId)) return storeItemId;
  return STORE_ID_MARKER + storeId + STORE_ID_MARKER + (storeItemId === '*' ? '' : storeItemId);
}

/**
 * Handle the given error from a data store, wrapping it as an API error if needed
 * before throwing it further.
 * @param {*} err
 * @param {string} storeId
 */
function throwAPIError (err, storeId) {
  if (!(err instanceof Error)) {
    err = new Error(err);
  }
  if (!(err instanceof APIError)) {
    err = apiErrors.unexpectedError(err);
  }
  if (storeId != null) {
    err.message = `Error from data store "${storeId}": ${err.message}`;
  }
  throw err;
}
