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

const { DataStore, UserStreams }  = require('../interfaces/DataStore');
const StreamsUtils = require('./lib/StreamsUtils');
const { treeUtils } = require('utils');

import type { StoreQuery } from 'api-server/src/methods/helpers/eventsGetUtils';
import type { Stream } from 'business/src/streams';
import typeof Mall from './Mall';

/**
 * Handle Store.streams.* methods
 */
class MallUserStreams extends UserStreams {

  mall: Mall;
 
  /**
   * @param {Mall} mall 
   */
  constructor(mall: Mall) {
    super();
    this.mall = mall;
  }

  /**
   * Helper to get a single stream
   */
  async getOne(uid: string, streamId: string, storeId: string): Promise<?Stream> {
    if (storeId == null) { [storeId, streamId] = StreamsUtils.storeIdAndStreamIdForStreamId(streamId); }
    const store: DataStore = this.mall._storeForId(storeId);
    if (store == null) return null;
    const streams: Array<Stream> = await store.streams.get(uid, { id: streamId, includeTrashed: true, storeId });
    if (streams?.length === 1) return streams[0];
    return null;
  }

  /**
   * Get the stream that will be set as root for all Stream Structure of this Data Store.
   * @see https://api.pryv.com/reference/#get-streams
   * @param {identifier} uid
   * @param {Object} params
   * @param {identifier} [params.id] null, means root streamId. Notice parentId is not implemented by Mall 
   * @param {identifier} [params.storeId] null, means streamId is a "FullStreamId that includes store informations"
   * @param {identifier} [params.expandChildren] default false, if true also return childrens
   * @param {Array<identifier>} [params.excludeIds] list of streamIds to exclude from query. if expandChildren is true, children of excludedIds should be excludded too
   * @param {boolean} [params.includeTrashed] (equivalent to state = 'all')
   * @param {timestamp} [params.includeDeletionsSince] 
   * @returns {UserStream|null} - the stream or null if not found:
   */
  async get(uid: string, params: StoreQuery) {

    // -------- cleanup params --------- //
    const streamId: string = params.id || '*'; // why?? -- IT SHOULD NOT HAVE DEFAULT VALUES
    const storeId: string = params.storeId; // might me null -- how? IT DOES NOT HAPPEN
    const excludedIds: Array<string> = params.excludedIds;

    // ------- create result ------//
    let res: Array<Stream> = [];

    // *** root query we just expose store handles & local streams
    // might be moved in LocalDataStore ? 
    if (streamId === '*' && storeId === 'local') {
      res = getChildlessRootStreamsForOtherStores(this.mall.stores);
    }
    //------ Query Store -------------//

    const store: DataStore = this.mall._storeForId(storeId);

    const myParams: StoreQuery = {
      id: streamId,
      includeDeletionsSince: params.includeDeletionsSince,
      includeTrashed: params.includeTrashed,
      expandChildren: params.expandChildren,
      excludedIds: store.streams.hasFeatureGetParamsExcludedIds ? excludedIds : null,
      storeId: null, // we'll address this request to the store directly
    }

    // add it to parameters if feature is supported by store.
    if (store.streams.hasFeatureGetParamsExcludedIds) myParams.excludedIds = excludedIds;

    const storeStreams = await store.streams.get(uid, myParams);

    // add storeStreams to result
    res.push(...storeStreams);

    // if store does not support excludeIds, perform it here
    if (! store.streams.hasFeatureGetParamsExcludedIds && excludedIds.length > 0) {
      res = performExclusion(res, excludedIds);
    }

    if (storeId !== 'local') { // add Prefix
      StreamsUtils.addStoreIdPrefixToStreams(storeId, res);
      if (streamId === '*') { // add root stream
        res = [StreamsUtils.storeToStream(store, {
          children: res,
        })];
      }
    }

    return res;

    function getChildlessRootStreamsForOtherStores(stores: Array<DataStore>): Array<Stream> {
      const res: Array<Stream> = [];
      for (const store: DataStore of stores) {
        if (store.id !== 'local') {
          res.push(StreamsUtils.storeToStream(store, {
            children: [],
            childrenHidden: true // To be discussed
          }));
        }
      }
      return res;
    }

    function performExclusion(res: Array<Stream>, excludedIds: Array<string>): Array<Stream> {
      return treeUtils.filterTree(res, false, (stream) => ! excludedIds.includes(stream.id));
    }
  }

}

module.exports = MallUserStreams;