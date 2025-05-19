/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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
const { APIError, factory: apiErrors } = require('errors');
const { errors: dataStoreErrors } = require('@pryv/datastore');
// HACK: replace data store errors factory methods with API errors factory's
Object.assign(dataStoreErrors, apiErrors);

const LOCAL_STORE_ID = 'local';
const STORE_ID_MARKER = ':';

const storeDataUtils = module.exports = {
  LocalStoreId: LOCAL_STORE_ID,
  parseStoreIdAndStoreItemId,
  getFullItemId,
  throwAPIError
};
Object.freeze(storeDataUtils);

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

  if (storeId === 'system' || storeId === '_system') return [LOCAL_STORE_ID, fullItemId];

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
 * @param {storeStreamId}
 * @returns {string}
 */
function getFullItemId (storeId, storeItemId) {
  if (storeId === LOCAL_STORE_ID) return storeItemId;
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
