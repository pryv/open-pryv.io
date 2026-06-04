/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { defaults: dataStoreDefaults } = require('@pryv/datastore');
const { getFullItemId } = require('./storeDataUtils.ts');

export { createStoreRootStream, addStoreIdPrefixToStreams };
/**
 * Create a pseudo-stream representing a data store's root.
 */
function createStoreRootStream (storeDescription: { id: string; name: string }, extraProperties: Record<string, unknown>) {
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
 * @param storeId  undefined
 * @param streams  undefined
 */
type StreamLike = { id: string; parentId?: string | null; children?: StreamLike[] };
function addStoreIdPrefixToStreams (storeId: string, streams: StreamLike[]) {
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
