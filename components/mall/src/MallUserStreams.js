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

const storeDataUtils = require('./helpers/storeDataUtils');
const streamsUtils = require('./helpers/streamsUtils');
const { treeUtils } = require('utils');
const cuid = require('cuid');
const errorFactory = require('errors').factory;

/**
 * Storage for streams.
 * Dispatches requests to each data store's streams.
 */
class MallUserStreams {
  /**
   * @type {Map<string, UserStream>}
   * @default new Map()
   */
  streamsStores = new Map();
  /**
   * Store names are used for the stores' root pseudo-streams.
   * @type {Map<string, string>}
   * @default new Map()
   */
  storeNames = new Map();

  /**
   * @param {{ storesById: Map, storeDescriptionsByStore: Map }} storesHolder
   */
  constructor (storesHolder) {
    for (const [storeId, store] of storesHolder.storesById) {
      this.streamsStores.set(storeId, store.streams);
      this.storeNames.set(storeId, storesHolder.storeDescriptionsByStore.get(store).name);
    }
  }

  /**
   * Get a single stream from id and optional storeId.
   * Will not expand children.
   * @param {string} userId
   * @param {string} streamId
   * @param {string} [storeId]
   * @returns {Promise<any>}
   */
  async getOneWithNoChildren (userId, streamId, storeId) {
    if (storeId == null) {
      // TODO: clarify smelly code (replace full stream id with in-store id?)
      [storeId, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    }
    const streamsStore = this.streamsStores.get(storeId);
    if (!streamsStore) { return null; }

    if (streamId === '*' && storeId !== 'local') {
      return streamsUtils.createStoreRootStream({
        id: storeId,
        name: this.storeNames.get(storeId)
      }, {
        children: [],
        childrenHidden: true // To be discussed
      });
    }

    const stream = await streamsStore.getOne(userId, streamId, {
      includeTrashed: true,
      childrenDepth: 0
    });
    return stream;
  }

  /**
   * Get the stream that will be set as root for all Stream Structure of this Data Store.
   * @see https://pryv.github.io/reference/#get-streams
   * @param {string} userId  undefined
   * @param {StoreQuery} params  undefined
   * @returns {Promise<any[]>} - the stream or null if not found:
   */
  async get (userId, params) {
    // -------- cleanup params --------- //
    let streamId = params.id || '*';
    let storeId = params.storeId;
    if (storeId == null) {
      // TODO: clarify smelly code (replace full stream id with in-store id?)
      [storeId, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    }
    params.childrenDepth = params.childrenDepth || 0;
    const excludedIds = params.excludedIds || [];
    const hideStoreRoots = params.hideStoreRoots || false;
    // ------- create result ------//
    let res = [];
    // *** root query we just expose store handles & local streams
    // might be moved in localDataStore ?
    if (streamId === '*' &&
            storeId === storeDataUtils.LocalStoreId &&
            !hideStoreRoots) {
      res = getChildlessRootStreamsForOtherStores(this.storeNames);
    }
    // ------ Query Store -------------//
    const streamsStore = this.streamsStores.get(storeId);
    if (streamsStore == null) {
      throw errorFactory.unknownResource('Store', storeId);
    }
    const storeQuery = {
      includeTrashed: params.includeTrashed,
      childrenDepth: params.childrenDepth,
      excludedIds: streamsStore.hasFeatureGetParamsExcludedIds
        ? excludedIds
        : []
    };

    if (streamId !== '*') {
      const stream = await streamsStore.getOne(userId, streamId, storeQuery);
      if (stream != null) res.push(stream);
    } else { // root query
      const streams = await streamsStore.get(userId, storeQuery);
      res.push(...streams);
    }

    // if store does not support excludeIds, perform it here
    if (!streamsStore.hasFeatureGetParamsExcludedIds &&
            excludedIds.length > 0) {
      res = performExclusion(res, excludedIds);
    }
    if (storeId !== storeDataUtils.LocalStoreId) {
      // add Prefix
      streamsUtils.addStoreIdPrefixToStreams(storeId, res);
      if (streamId === '*') {
        // add root stream
        res = [
          streamsUtils.createStoreRootStream({
            id: storeId,
            name: this.storeNames.get(storeId)
          }, {
            children: res
          })
        ];
      }
    }
    return res;
    // TODO: move utility func out of object
    function getChildlessRootStreamsForOtherStores (storeNames) {
      const res = [];
      for (const [storeId, storeName] of storeNames) {
        if (storeId !== storeDataUtils.LocalStoreId) {
          res.push(streamsUtils.createStoreRootStream({
            id: storeId,
            name: storeName
          }, {
            children: [],
            childrenHidden: true // To be discussed
          }));
        }
      }
      return res;
    }
    // TODO: move utility func out of object
    function performExclusion (res, excludedIds) {
      return treeUtils.filterTree(res, false, (stream) => !excludedIds.includes(stream.id));
    }
  }

  /**
   * @param {String} userId
   * @param {timestamp} [deletedSince]
   * @param {Array<string>} [storeIds]
   * @returns {Promise<any[]>}
   */
  async getDeletions (userId, deletedSince, storeIds) {
    if (deletedSince == null) { deletedSince = Number.MIN_SAFE_INTEGER; }
    storeIds = storeIds || [storeDataUtils.LocalStoreId];
    const result = [];
    for (const storeId of storeIds) {
      const streamsStore = this.streamsStores.get(storeId);
      const deletedStreams = await streamsStore.getDeletions(userId, { deletedSince });
      result.push(...deletedStreams);
    }
    return result;
  }

  /**
   * As some stores might not keep "deletion" records
   * A "local" cache of deleted streams could be implemented
   * This is mostly used by tests fixtures for now
   * @param {string} userId
   * @param {Stream} streamData
   * @returns {Promise<any>}
   */
  async createDeleted (userId, streamData) {
    const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(streamData.id);
    if (streamData.deleted == null) { throw errorFactory.invalidRequestStructure('Missing deleted timestamp for deleted stream', streamData); }
    const streamsStore = this.streamsStores.get(storeId);
    const res = await streamsStore.createDeleted(userId, streamData);
    return res;
  }

  /**
   * @param {string} userId
   * @param {Stream} streamData
   * @returns {Promise<any>}
   */
  async create (userId, streamData) {
    if (streamData.deleted != null) {
      return await this.createDeleted(userId, streamData);
    }
    const streamForStore = structuredClone(streamData);
    // 0- Prepare default values
    if (streamForStore.trashed !== true) {
      delete streamForStore.trashed;
    }
    if (streamForStore.deleted === undefined) {
      streamForStore.deleted = null;
    }
    // 1- Check if there is a parent stream
    let parentStoreId = storeDataUtils.LocalStoreId;
    let parentStoreStreamId;
    if (streamForStore.parentId != null) {
      [parentStoreId, parentStoreStreamId] =
                storeDataUtils.parseStoreIdAndStoreItemId(streamData.parentId);
      streamForStore.parentId = parentStoreStreamId;
    }
    // 2- Check streamId and store
    let storeId, storeStreamId;
    if (streamForStore.id == null) {
      storeId = parentStoreId;
      streamForStore.id = cuid();
    } else {
      [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamData.id);
      if (parentStoreId !== storeId) {
        throw errorFactory.invalidRequestStructure('streams cannot have an id different non matching from their parentId store', streamData);
      }
      streamForStore.id = storeStreamId;
    }
    const streamsStore = this.streamsStores.get(storeId);
    // 3 - Check if this Id has already been taken
    const existingStream = await streamsStore.getOne(userId, streamForStore.id, { includeTrashed: true });
    if (existingStream != null) {
      throw errorFactory.itemAlreadyExists('stream', { id: streamData.id });
    }

    // 4- Check if a sibbling stream with the same name exists
    const siblingNames = await this.getNamesOfChildren(userId, streamData.parentId, []);
    if (siblingNames.includes(streamForStore.name)) {
      throw errorFactory.itemAlreadyExists('stream', { name: streamData.name });
    }
    // 3 - Insert stream
    const res = await streamsStore.create(userId, streamForStore);

    if (storeId !== storeDataUtils.LocalStoreId) {
      // add Prefix
      streamsUtils.addStoreIdPrefixToStreams(storeId, [res]);
    }
    return res;
  }

  /**
   * @param {string} userId
   * @param {Stream} streamData
   * @returns {Promise<any>}
   */
  async update (userId, streamData) {
    const streamForStore = structuredClone(streamData);
    const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamData.id);
    streamForStore.id = storeStreamId;

    // 1- Check if there is a parent stream update
    if (streamForStore.parentId != null) {
      const [parentStoreId, parentStoreStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamData.parentId);
      if (parentStoreId !== storeId) {
        throw errorFactory.invalidRequestStructure('streams cannot have an id different non matching from their parentId store', streamData);
      }
      streamForStore.parentId = parentStoreStreamId;
    }

    // 2- Check if a sibbling stream with the same name exists
    const siblingNames = await this.getNamesOfChildren(userId, streamData.parentId, [streamData.id]);
    if (siblingNames.includes(streamForStore.name)) {
      throw errorFactory.itemAlreadyExists('stream', { name: streamData.name });
    }
    // 3 - Insert stream
    const streamsStore = this.streamsStores.get(storeId);
    const res = await streamsStore.update(userId, streamForStore);
    if (storeId !== storeDataUtils.LocalStoreId) {
      // add Prefix
      streamsUtils.addStoreIdPrefixToStreams(storeId, [res]);
    }
    return res;
  }

  // ---------------------- delete ----------------- //
  /**
   * @returns {Promise<any>}
   */
  async delete (userId, streamId) {
    const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    const streamsStore = this.streamsStores.get(storeId);
    return await streamsStore.delete(userId, storeStreamId);
  }

  /**
   * Used by tests
   * Might be replaced by standard delete.
   * @param {string} userId  undefined
   * @param {string} storeId
   * @returns {Promise<void>}
   */
  async deleteAll (userId, storeId) {
    const streamsStore = this.streamsStores.get(storeId);
    await streamsStore.deleteAll(userId);
  }

  // -------------------- utils ------------------- //
  /**
   * @private
   * get name of children stream
   * @param {string} userId
   * @param {string} streamId
   * @param {Array<string>} exludedIds
   * @returns {Promise<any[]>}
   */
  async getNamesOfChildren (userId, streamId, exludedIds) {
    const streams = await this.get(userId, {
      id: streamId,
      childrenDepth: 1,
      includeTrashed: true
    });
    let streamsToCheck = [];
    if (streamId == null) {
      // root
      streamsToCheck = streams;
    } else if (streams.length > 0) {
      streamsToCheck = streams[0].children || [];
    }
    const names = streamsToCheck
      .filter((s) => !exludedIds.includes(s.id))
      .map((s) => s.name);
    return names;
  }
}
module.exports = MallUserStreams;
