/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { APIError, factory: apiErrors } = require('errors');
const { errors: dataStoreErrors } = require('@pryv/datastore');
// HACK: replace data store errors factory methods with API errors factory's
Object.assign(dataStoreErrors, apiErrors);

const LOCAL_STORE_ID = 'local';
const ACCOUNT_STORE_ID = 'account';
const STORE_ID_MARKER = ':';

const LocalStoreId = LOCAL_STORE_ID;
const AccountStoreId = ACCOUNT_STORE_ID;
export { LocalStoreId, AccountStoreId, parseStoreIdAndStoreItemId, getFullItemId, isPassthroughStore, throwAPIError };

/**
 * Whether the given store uses "passthrough" IDs — i.e. store-internal IDs
 * are the same as external IDs (no prefix add/remove by Mall).
 *
 * - `local`: items have no store prefix (e.g. `myStream`)
 * - `account`: items keep their `:_system:` / `:system:` prefix as-is
 *
 */
function isPassthroughStore (storeId: any) {
  return storeId === LOCAL_STORE_ID || storeId === ACCOUNT_STORE_ID;
}

/**
 * Extract the store id and the in-store item id (without the store reference) from the given item id.
 * For streams, converts the store's root pseudo-stream id (`:store:`) to `*`.
 */
function parseStoreIdAndStoreItemId (fullItemId: any) {
  if (!fullItemId.startsWith(STORE_ID_MARKER)) return [LOCAL_STORE_ID, fullItemId];

  const endMarkerIndex = fullItemId.indexOf(STORE_ID_MARKER, 1);
  const storeId = fullItemId.substring(1, endMarkerIndex);

  // System streams route to the account store (passthrough — prefixed IDs preserved)
  if (storeId === 'system' || storeId === '_system') return [ACCOUNT_STORE_ID, fullItemId];

  // CMC plugin streams route to the local store (passthrough — prefixed IDs preserved).
  // CMC is a plugin (not a storage engine — see components/cmc/README.md "Design pillars");
  // its :_cmc:* events / accesses / streams live alongside the user's other data in main
  // storage. Special-cased here so the same routing-by-prefix pattern that ships :_system:
  // also covers :_cmc: without forcing CMC to register its own storage backend.
  if (storeId === '_cmc') return [LOCAL_STORE_ID, fullItemId];

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
 */
function getFullItemId (storeId: any, storeItemId: any) {
  // Passthrough stores: store-internal IDs ARE the external IDs
  if (isPassthroughStore(storeId)) return storeItemId;
  return STORE_ID_MARKER + storeId + STORE_ID_MARKER + (storeItemId === '*' ? '' : storeItemId);
}

/**
 * Handle the given error from a data store, wrapping it as an API error if needed
 * before throwing it further.
 */
function throwAPIError (err: any, storeId: any) {
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
