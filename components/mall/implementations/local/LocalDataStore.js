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

/**
 * Local Data Store. 
 */
const bluebird = require('bluebird');
const _ = require('lodash');

const streamsQueryUtils = require('api-server/src/methods/helpers/streamsQueryUtils');
const querying = require('api-server/src/methods//helpers/querying');
const storage = require('storage');
const { treeUtils } = require('utils');
const { StreamProperties } = require('business/src/streams');
const StreamPropsWithoutChildren: Array<string> = StreamProperties.filter(p => p !== 'children');
const {DataStore, UserStreams, UserEvents}  = require('mall/interfaces/DataStore');
const SystemStreamUtils = require('./SystemStreamUtils');
const cache = require('cache');

import type { StoreQuery } from 'api-server/src/methods/helpers/eventsGetUtils';
import type { Stream } from 'business/src/streams';
const STORE_ID = 'local';
const STORE_NAME = 'Local Store';
const DELTA_TO_CONSIDER_IS_NOW = 5; // 5 seconds

let userEventsStorage;
let userStreamsStorage;

class LocalDataStore extends DataStore {
  
  _id: string = 'local';
  _name: string = 'Local Store';

  constructor() {  
    super(); 
    this.settings = {
      attachments: {
        setFileReadToken: true // method/events js will add a readFileToken
      }
    }
  }

  async init(): Promise<DataStore> {
    // get config and load approriated data store components;
    this._streams = new LocalUserStreams();
    this._events = new LocalUserEvents();

    userEventsStorage = (await storage.getStorageLayer()).events;
    userStreamsStorage = (await storage.getStorageLayer()).streams;
    return this;
  }

  get streams() { return this._streams; }
  get events() { return this._events; }
}

function clone(obj: any): any {
  // Clone streams -- BAd BaD -- To be optimized 
  return _.cloneDeep(obj);
}
function cloneStream(storeStream: Stream, includeChildren: boolean): Stream {
  if (includeChildren) {
    return clone(storeStream);
  } else {
    // _.pick() creates a copy
    const stream: Stream = _.pick(storeStream, StreamPropsWithoutChildren);
    stream.childrenHidden = true;
    stream.children = [];
    return stream;
  }

}
class LocalUserStreams extends UserStreams {
  async get(uid: string, params: StoreQuery): Promise<Array<Stream>> {
    let allStreamsForAccount: Array<Stream> = cache.getStreams(uid, 'local');
    if (allStreamsForAccount == null) { // get from DB
      allStreamsForAccount = await bluebird.fromCallback(cb => userStreamsStorage.find({id: uid}, {}, null, cb));
      // add system streams
      allStreamsForAccount = allStreamsForAccount.concat(SystemStreamUtils.visibleStreamsTree);
      cache.setStreams(uid, 'local', allStreamsForAccount);
    }
    

    let streams: Array<Stream> = [];
    if (params?.id === '*') { 
      // assert: params.expandChildren == true, see "#*" case
      streams = clone(allStreamsForAccount); // clone to be sure they can be mutated without touching the cache
    } else {
      const stream: Stream = treeUtils.findById(allStreamsForAccount, params.id); // find the stream
      if (stream != null) streams = [cloneStream(stream, params.expandChildren)]; // clone to be sure they can be mutated without touching the cache
    }

    if (! params.includeTrashed) { // i.e. === 'default' (return non-trashed items)
      streams = treeUtils.filterTree(streams, false /*no orphans*/, stream => !stream.trashed);
    }
    return streams;
  }
}

class LocalUserEvents extends UserEvents {
  async getStreamed(userId, params) {
    const query = querying.noDeletions(querying.applyState({}, params.state));

    const streamsQuery = streamsQueryUtils.toMongoDBQuery(params.streams, SystemStreamUtils.forbiddenForReadingStreamIds);
    
    if (streamsQuery.$or) query.$or = streamsQuery.$or;
    if (streamsQuery.streamIds) query.streamIds = streamsQuery.streamIds;
    if (streamsQuery.$and) query.$and = streamsQuery.$and;

    if (params.types && params.types.length > 0) {
      // unofficially accept wildcard for sub-type parts
      const types = params.types.map(getTypeQueryValue);
      query.type = {$in: types};
    }
    if (params.fromTime != null) {
      const timeQuery = [
        { // Event started before fromTime, but finished inside from->to.
          time: {$lt: params.fromTime},
          endTime: {$gte: params.fromTime}
        }
      ];
      if (params.toTime != null) {
        timeQuery.push({ // Event has started inside the interval.
          time: { $gte: params.fromTime, $lte: params.toTime }
        });
      }
      
      if (params.toTime == null || ( params.toTime + DELTA_TO_CONSIDER_IS_NOW) > (Date.now() / 1000)) { // toTime is null or greater than now();
        params.running = true;
      }

      if (query.$or) { // mongo support only one $or .. so we nest them into a $and
        if (! query.$and) query.$and = [];
        query.$and.push({$or: query.$or});
        query.$and.push({$or: timeQuery});
        delete query.$or; // clean; 
      } else {
        query.$or = timeQuery;
      }

    }
    if (params.toTime != null) {
      _.defaults(query, {time: {}});
      query.time.$lte = params.toTime;
    }
    if (params.modifiedSince != null) {
      query.modified = {$gt: params.modifiedSince};
    }
    if (params.running) {
      if (query.$or) { 
        query.$or.push({endTime: null})
      } else {
        query.endTime = null; // matches when duration exists and is null
      }
    }

    const options = {
      projection: params.returnOnlyIds ? {id: 1} : {},
      sort: { time: params.sortAscending ? 1 : -1 },
      skip: params.skip,
      limit: params.limit
    };
  
    return await bluebird.fromCallback(cb => userEventsStorage.findStreamed(userId, query, options, cb));
  }
}

module.exports = LocalDataStore;


//--------------- helpers ------------//

/**
 * Returns the query value to use for the given type, handling possible wildcards.
 *
 * @param {String} requestedType
 */
function getTypeQueryValue(requestedType) {
var wildcardIndex = requestedType.indexOf('/*');
return wildcardIndex > 0 ?
  new RegExp('^' + requestedType.substr(0, wildcardIndex + 1)) : 
  requestedType;
}