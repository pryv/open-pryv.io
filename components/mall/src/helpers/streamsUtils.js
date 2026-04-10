/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const { defaults: dataStoreDefaults } = require('@pryv/datastore');
const { getFullItemId } = require('./storeDataUtils');
module.exports = {
  createStoreRootStream,
  addStoreIdPrefixToStreams
};
/**
 * Create a pseudo-stream representing a data store's root.
 * @param {{id: string, name: string}} storeDescription
 * @param {Object} extraProperties
 * @returns {any}
 */
function createStoreRootStream (storeDescription, extraProperties) {
  return Object.assign({
    id: ':' + storeDescription.id + ':',
    name: storeDescription.name,
    parentId: null,
    created: dataStoreDefaults.UnknownDate + 1,
    modified: dataStoreDefaults.UnknownDate,
    createdBy: dataStoreDefaults.SystemAccessId,
    modifiedBy: dataStoreDefaults.SystemAccessId
  }, extraProperties);
}
/**
 * Add storeId to streamIds to parentIds of a tree
 * Add storeId to "null" parentId
 * @param {string} storeId  undefined
 * @param {Array<Stream>} streams  undefined
 * @returns {void}
 */
function addStoreIdPrefixToStreams (storeId, streams) {
  for (const stream of streams) {
    stream.id = getFullItemId(storeId, stream.id);
    if (stream.parentId != null) {
      stream.parentId = getFullItemId(storeId, stream.parentId);
    } else {
      stream.parentId = getFullItemId(storeId, '*');
    }
    if (stream.children != null) { addStoreIdPrefixToStreams(storeId, stream.children); }
  }
}
