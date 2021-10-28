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

/**
 * Utilities for events.get stream queries.
 * 
 * Documentation and specifications can be found on 
 * https://github.com/pryv/docs-pryv/blob/master/pryv.io/events.get-filtering/README.md
 */
const util = require('util');

const { StreamsUtils } = require('mall');
const { findForbiddenChar } = require('../../schema/streamId');

import type { StreamQuery, StreamQueryWithStoreId } from 'business/src/events';

/**
 * @typedef {Object} StreamQueryScoped
 * @property {Array.<StreamQuery>} streamQuery - An array of streamQueries 
 * @property {Array} nonAuthorizedStreams - The list of stream that have been unAuthorized 
 */

/**
 * @typedef {Object} StreamQuery
 * @property {Array.<StreamId>|'*'} any - Any of the streamIds should match or "*" for all accessible streams
 * @property {Array.<StreamId>} all - All of the streamIds should match
 * @property {Array.<StreamId>} not - All of the streamIds should match
 */

/**
  * A streamId
  * @typedef {string} StreamId
  */

/**
 * For backwardCompatibility with older streams parameter ['A', 'B'] transform it to streams query [{any: ['A', 'B']}]
 * Takes care of grouping by store. ['A', 'B', ':_audit:xx'] => [{any: ['A', 'B']}, {any: ':audit:xx'}]
 * @param {Array.<StreamQuery>} arrayOfQueries 
 * @throws - Error if mixed strings and other are found in array
 */
function transformArrayOfStringsToStreamsQuery(arrayOfQueries: Array<any>): Array<StreamQueryWithStoreId> {

  const { numStreamIds, streamIds }: { numStreamIds: number, streamIds: Array<string>} = countStreamIds(arrayOfQueries);
  if (numStreamIds === 0) return arrayOfQueries;
  if (numStreamIds !== arrayOfQueries.length) {
    throw ('Error in \'streams\' parameter: streams queries and streamIds cannot be mixed');
  }

  // group streamIds per "store"
  const map: Map<string, Array<string>> = {};
  for (const streamId: string of streamIds) {
    const [store: string, cleanStreamId: string] = StreamsUtils.storeIdAndStreamIdForStreamId(streamId);
    if (map[store] == null) map[store] = [];
    map[store].push(streamId);
  }

  const arrayOfStreamQueries: Array<StreamQuery> = [];
  for (const v: Array<string> of Object.values(map)) {
    arrayOfStreamQueries.push({ any: v });
  }

  return arrayOfStreamQueries;

  function countStreamIds(arrayOfQueries: Array<any>): { numStreamIds: number, streamIds: Array<string>} {
    const streamIds: Array<string> = arrayOfQueries.filter(item => typeof item === 'string');
    return { 
      numStreamIds: streamIds.length,
      streamIds,
    };
  }
}
exports.transformArrayOfStringsToStreamsQuery = transformArrayOfStringsToStreamsQuery;

/**
 * @param {Array.<StreamQuery>} arrayOfQueries 
 * @throws - Error if query does not respect the schema
 */
function validateStreamsQueriesAndSetStore(arrayOfQueries: Array<StreamQuery>) {
  arrayOfQueries.forEach((streamQuery: StreamQuery) => {
    validateStreamsQuerySchemaAndSetStore(arrayOfQueries, streamQuery);
  });
  return arrayOfQueries;
}
exports.validateStreamsQueriesAndSetStore = validateStreamsQueriesAndSetStore;

/**
 * throw an error if streamQuery is not of the form {any: all: not: } with at least one of any or all 
 * [{any: ['A', 'B', '.email']}, {any: ':_audit:xx'}] => [{any: ['A', 'B', '.email'], storeId: 'local'}, {any: 'xx', storeId: 'audit'}]
 * @param {Array.<StreamQuery>} arrayOfQueries - the full request for error message
 * @param {StreamQuery} streamQuery 
 */
function validateStreamsQuerySchemaAndSetStore(arrayOfQueries: Array<StreamQuery>, streamQuery: StreamQuery): void {

  /**
   * Get StoreID, add storeId property to query and remove eventual storeId from streamId
   * @param {string} streamIdWithPrefix - a streamId with its store prefix
   * @returns {string} streamId without its prefix
   */
  function validateAndAttachStore(streamIdWithPrefix: string): string {
    // queries must be grouped by store 
    const [thisStore: string, streamId: string] = StreamsUtils.storeIdAndStreamIdForStreamId(streamIdWithPrefix);
    if (streamQuery.storeId == null) streamQuery.storeId = thisStore;
    if (streamQuery.storeId !== thisStore) throw ('Error in \'streams\' parameter \'' + objectToString(arrayOfQueries) + '\' streams query: \'' + objectToString(streamQuery) + '\' queries must me grouped by store.');
    return streamId;
  }

  if (streamQuery.any == null) {
    throw ('Error in \'streams\' parameter \'' + objectToString(arrayOfQueries) + '\' streams query: \'' + objectToString(streamQuery) + '\' must contain at least one of \'any\' property.');
  }

  let hasAnyStar: boolean = false;
  for (const [property: string, arrayOfStreamIds: Array<string>] of Object.entries(streamQuery)) {
    if (!['all', 'any', 'not'].includes(property))
      throw ('Error in \'streams\' parameter \'' + objectToString(arrayOfQueries) + '\' unkown property: \'' + property + '\' in streams query \'' + objectToString(streamQuery) + '\'');

    if (!Array.isArray(arrayOfStreamIds)) {
      throw ('Error in \'streams\' parameter \'' + objectToString(arrayOfQueries) + '\' value of : \'' + property + '\' must be an array. Found: \'' + objectToString(arrayOfStreamIds) + '\'');
    }

    const arrayOfCleanStreamIds: Array<string> = [];
    
    for (const item: string of arrayOfStreamIds) {
      if (typeof item !== 'string')
        throw ('Error in \'streams\' parameter[' + objectToString(arrayOfQueries) + '] all items of ' + objectToString(arrayOfStreamIds) + ' must be streamIds. Found: ' + objectToString(item));
      
      if (item === '#*') throw ('Error in \'streams\' parameter \'' + objectToString(arrayOfQueries) + ', "#*" is not valid.');

      const forbiddenChar: string = findForbiddenChar(item);
      if (forbiddenChar != null) throw ('Error in \'streams\' parameter \'' + objectToString(arrayOfQueries) + '\' forbidden chartacter \'' + forbiddenChar + '\' in streamId \'' + item + '\'.');

      if (property !== 'any' && item === '*')
        throw ('Error in \'streams\' parameter[' + objectToString(arrayOfQueries) + '] only \'any\' can contain \'*\' : ' + objectToString(arrayOfStreamIds));

      if (property === 'any' && item === '*') {
        hasAnyStar = true;
        if (arrayOfStreamIds.length > 1)
          throw ('Error in \'streams\' parameter[' + objectToString(arrayOfQueries) + '] \'*\' cannot be mixed with other streamIds in \'any\': ' + objectToString(arrayOfStreamIds));
      } 
      const cleanStreamid: string = validateAndAttachStore(item);
      arrayOfCleanStreamIds.push(cleanStreamid);

      streamQuery[property] = arrayOfCleanStreamIds;
    }
  }
  if (hasAnyStar && streamQuery.all != null) {
    throw ('Error in \'streams\' parameter[' + objectToString(streamQuery) + '] {any: \'*\'} cannot be mixed with \'all\': ' + objectToString(arrayOfQueries));
  }
}

/**
 * @callback ExpandStream
 * @param {identifier} streamId
 * @param {identifier} storeId
 * @param {Array.<StreamId>} excludedIds - Array of streams to exclude from expand
 * @return {Array.<StreamId>|string} - returns all children recursively for this stream OR a proprietary string to be interpreted by events.get() in the streamQuery OR null if not expandable
 */



function uniqueStreamIds(arrayOfStreamiIs) {
  return [...new Set(arrayOfStreamiIs)];
}

/**
 * @param {Array.<StreamQuery>} streamQueries 
 * @param {ExpandStream} expandStream 
 * @returns 
 */
exports.expandAndTransformStreamQueries = async function expandAndTransformStreamQueries(streamQueries, expandStream) {

  async function expandSet(streamIds, storeId, excludedIds = []) {
    const expandedSet = new Set(); // use a Set to avoid duplicate entries;
    for (let streamId of streamIds) {
      if (! excludedIds.includes(streamId)) // skip streamId presents in exluded set
        (await expandStream(streamId, storeId, excludedIds)).forEach(item => expandedSet.add(item));
    }
    return Array.from(expandedSet);
  }

  const res = [];
  for (let streamQuery of streamQueries) {
    const expandedQuery = await expandAndTransformStreamQuery(streamQuery, expandSet);
    if (expandedQuery) res.push(expandedQuery);
  }
  return res;
}

async function expandAndTransformStreamQuery(streamQuery, expandSet) {
  let containsAtLeastOneInclusion = false; 
  const res = { storeId: streamQuery.storeId };

  // any
  if (streamQuery.any) {
    const expandedSet = await expandSet(streamQuery.any, streamQuery.storeId, streamQuery.not);
    if (expandedSet.length > 0) {
      containsAtLeastOneInclusion = true;
      res.any = uniqueStreamIds(expandedSet);
    }
  }

  // all
  if (streamQuery.all) {
    for (let streamId of streamQuery.all) {
      let expandedSet = await expandSet([streamId], streamQuery.storeId, streamQuery.not);
      if (expandedSet.length == 0) continue; // escape
      if (! res.and) res.and = [];
      containsAtLeastOneInclusion = true;
      res.and.push({any: uniqueStreamIds(expandedSet)});
    }
  }

  // not
  if (streamQuery.not) {
    const not = [];
    for (let streamId of streamQuery.not) { 
      let expandedSet = await expandSet([streamId], streamQuery.storeId, streamQuery.any);
      if (expandedSet.length == 0) continue; // escape
      
      not.push(...expandedSet);
    }
    if (not.length > 0) {
      if (! res.and) res.and = [];
      res.and.push({not: uniqueStreamIds(not)});
    }
  }

  return (containsAtLeastOneInclusion) ? res : null;
}

/**
 * Transform queries for mongoDB - to be run on 
 * @param {Array.<StreamQuery>} streamQueriesArray - array of streamQuery 
 * @param {Array.<StreamId>} forbiddenStreamsIds - an array of streamIds not accessible
 * @returns {MongoQuey} - the necessary components to query streams. Either with a {streamIds: ..} or { $or: ....}
 */
exports.toMongoDBQuery = function toMongoDBQuery(streamQueriesArray, forbiddenStreamsIds) {
  let mongoQuery = null; // no streams

  if (streamQueriesArray !== null) {
    if (streamQueriesArray.length === 1) {
      mongoQuery = streamQueryToMongoDBQuery(streamQueriesArray[0]);
    } else { // pack in $or
      mongoQuery = { $or: streamQueriesArray.map(streamQueryToMongoDBQuery) };
    }
  }

  if (mongoQuery === null) mongoQuery = { streamIds: { $in: [] } }; // no streams

  if (forbiddenStreamsIds && forbiddenStreamsIds.length > 0) {
    mongoQuery.streamIds = mongoQuery.streamIds || {};
    if (mongoQuery.streamIds.$nin) {
      mongoQuery.streamIds.$nin.push(...forbiddenStreamsIds);
    } else {
      mongoQuery.streamIds.$nin = forbiddenStreamsIds;
    }
  }

  return mongoQuery;
}
/**
 * Convert a streamQuery to a query usable by MongoDB 
 * @param {StreamQuery} streamQuery 
 */
function streamQueryToMongoDBQuery(streamQuery) {
  const res = {};
  if (streamQuery.any && streamQuery.any.length > 0) {
    if (streamQuery.any.length === 1) {
      res.streamIds = { $eq: streamQuery.any[0] };
    } else {
      res.streamIds = { $in: streamQuery.any };
    }
  }
  // only reached from a "and" property
  if (streamQuery.not && streamQuery.not.length > 0) {
    if (res.streamIds) res.streamIds = {};
    if (streamQuery.not.length === 1) {
      res.streamIds = { $ne: streamQuery.not[0] };
    } else {
      res.streamIds = { $nin: streamQuery.not };
    }
  }
  if (streamQuery.and) {
    res.$and = [];
    for (let andItem of streamQuery.and) {
      res.$and.push(streamQueryToMongoDBQuery(andItem));
    }
  }
  return res;
}

//------------------------ helpers ----------------------------------//

/** for nice error message with clear query content */
function objectToString(object) {
  return util.inspect(object, { depth: 5 })
}