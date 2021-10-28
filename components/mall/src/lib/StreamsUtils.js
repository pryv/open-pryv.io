/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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

// @flow

const { DataStore } = require('../../interfaces/DataStore');
const LOCAL_STORE = 'local';
import type { Stream } from 'business/src/streams';

/**
 * Create a Stream object from a DataStore 
 * @param {DataStore} store 
 * @param {Object} extraProperties 
 */
function storeToStream(store: DataStore, extraProperties: mixed): Stream {
  return Object.assign({
    id: ':' + store.id + ':',
    name: store.name,
    parentId: null,  
    created: DataStore.UNKOWN_DATE,
    modified: DataStore.UNKOWN_DATE,
    createdBy: DataStore.BY_SYSTEM,
    modifiedBy: DataStore.BY_SYSTEM,
  }, extraProperties);
}

/**
 * Get the storeId related to this stream, and the streamId without the store reference
 * @returns {object} [storeId: ..., streamIdWithoutStorePrefix]
 */
function storeIdAndStreamIdForStreamId(fullStreamId: string): [ string, string ] {
  const isDashed: number = (fullStreamId.indexOf('#') === 0) ? 1 : 0;
  if (fullStreamId.indexOf(':') !== (0 + isDashed)) return [LOCAL_STORE, fullStreamId];
  const semiColonPos: number = fullStreamId.indexOf(':', ( 1 + isDashed) );
  const storeId: string = fullStreamId.substr(1 + isDashed, (semiColonPos - 1));

  if (storeId === 'system' || storeId === '_system') return [ LOCAL_STORE, fullStreamId ];

  let streamId: string = '';
  if (semiColonPos === (fullStreamId.length - 1)) { // if ':store:' or '#:store:'
    streamId = '*';
  } else {
    streamId = fullStreamId.substr(semiColonPos + 1);
  }
  if (isDashed) return [storeId, '#' + streamId];
  return [ storeId, streamId ];
}

/**
 * Get full streamId from store + cleanstreanId
 * @returns {string} 
 */
function streamIdForStoreId(streamId: string, storeId: string): string {
  if (storeId === LOCAL_STORE) return streamId;
  const isDashed: boolean = (streamId.indexOf('#') === 0);
  let sstreamId: string = isDashed ? streamId.substr(1) : streamId;
  if (sstreamId === '*') sstreamId = '';
  if (isDashed) return '#:' + storeId + ':' + sstreamId;
  return ':' + storeId + ':' + sstreamId;
}

/**
 * Add storeId to streamIds to parentIds of a tree
 * Add storeId to "null" parentId
 * @param {identifier} storeId 
 * @param {Array<Streams>} streams 
 */
function addStoreIdPrefixToStreams(storeId: string, streams: Array<Stream>): void {
  for (const stream: Stream of streams) {
    stream.id = streamIdForStoreId(stream.id, storeId);
    if (stream.parentId != null) { 
      stream.parentId = streamIdForStoreId(stream.parentId, storeId);
    } else {
      stream.parentId = streamIdForStoreId('*', storeId);
    }
    if (stream.children != null) addStoreIdPrefixToStreams(storeId, stream.children)
  }
}

module.exports = {
  storeToStream,
  storeIdAndStreamIdForStreamId,
  streamIdForStoreId,
  addStoreIdPrefixToStreams
}