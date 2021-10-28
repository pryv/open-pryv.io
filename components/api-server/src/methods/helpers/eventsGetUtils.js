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
 * Some method used by events.get are shared with audit.getLogs
 */


const streamsQueryUtils = require('./streamsQueryUtils');
const _ = require('lodash');
const timestamp = require('unix-timestamp');
const errors = require('errors').factory;
const { getMall, StreamsUtils } = require('mall');
const { treeUtils } = require('utils');
const SetFileReadTokenStream = require('../streams/SetFileReadTokenStream');
const SetSingleStreamIdStream = require('../streams/SetSingleStreamIdStream');
const ChangeStreamIdPrefixStream = require('../streams/ChangeStreamIdPrefixStream');
const addTagsStream = require('../streams/AddTagsStream');

import type { Stream } from 'business/src/streams';
import type { StreamQuery, StreamQueryWithStoreId } from 'business/src/events';
import type { MethodContext } from 'business';
import type { ApiCallback }  from '../../API';
import type Result  from '../../Result';

export type GetEventsParams = {
  streams?: Array<string> | string | StreamQuery | Array<StreamQuery>,
  arrayOfStreamQueries?: Array<StreamQuery>,
  arrayOfStreamQueriesWithStoreId?: Array<StreamQueryWithStoreId>,
  tags?: Array<string>,
  types?: Array<string>,
  fromTime?: number,
  toTime?: number,
  sortAscending?: boolean,
  skip?: number,
  limit?: number,
  state?: 'default' | 'all' | 'trashed',
  modifiedSince?: number,
  includeDeletions?: boolean,
};
export type StoreQuery = {
  id: string, 
  storeId: string, 
  includeTrashed: boolean,
  expandChildren: boolean,
  excludedIds: Array<string>,
};

let mall;

/**
 *  # Stream Query Flow 
 *  1. coerceStreamParam:
 *    - null `streams` is changed to `[{any: ['*]}]
 *    - transform "stringified" `streams` by parsing JSON object
 * 
 *  2. transformArrayOfStringsToStreamsQuery:
 *    For backwardCompatibility with older streams parameter ['A', 'B'] 
 *    - `streams: ['A', 'B', 'C']` => `streams: [{any: 'A'}, {any: 'B'}, {any: 'C'}]`
 * 
 *  3. validateStreamsQueriesAndSetStore:
 *    - Check syntax and add storeId 
 *      `streams: [{any: 'A'}, {any: ':_audit:B'}]` => `streams: [{any: 'A', storeId: 'local'}, {any: 'B', storeId: 'audit'}]`
 * 
 *  4. streamQueryCheckPermissionsAndReplaceStars:
 *    For `stream.any`ONLY ! (we don't have to check NOT and ALL query as they only reduce scope)  
 *    - check if stream exits and if has "read" access 
 *    - If "stream.any" contains  "*" it's replaced by all root streams with "read" rights
 *   
 *  5. streamQueryAddForcedAndForbiddenStreams
 *    - Add to streams query `all` streams declared as "forced"
 *    - Add to streams query `not` streams that must not be exposed permissions => with level = "none"
 *   
 *  6. streamQueryExpandStreams
 *    - Each "streamId" of the queries is "expanded" (i.e. transformed in an array of streamId that includes the streams and it's chidlren)
 *    - Do not expand streams prefixed with a "#" 
 *       
 *    - A callBack `expandStreamInContext`is used to link the expand process and the "store"
 *      This callBack is designed to be optimized on a Per-Store basis The current implementation is generic
 *      - If streamId is prefixed with a "#" just return the streamId without "#"
 *      - It queries the stores with and standard `store.streams.get({id: streamId, exludedIds: [....]})` 
 *        and return an array of streams.
 * 
 *    - streamsQueryUtils.expandAndTransformStreamQueries
 *      Is in charge of handling 'any', 'all' and 'not' "expand" process
 * 
 *      - "any" is expanded first excluding streamIds in "not"
 *          => The result is kept in `any`
 *      - "all" is expanded in second excluding streamIds in "not"
 *          `all` is tranformed and each "expansion" is kept in `and: [{any: ,..}]`
 *          example: `{all: ['A', 'B']}` => `{and: [{any: [...expand('A')]}, {any: [...expand('B')]}]}`
 *      - "not" is expanded in third and added to `and` -- !! we exclude streamIds that are in 'any' as some authorization might have been given on child now expanded
 *          example: `{all: ['A'], not['B', 'C']}` =>  `{and: [{any: [...expand('A')]}, {not: [...expand('B')...expand('C')]}]}
 * 
 */

function coerceStreamsParam(context: MethodContext, params: GetEventsParams, result: Result, next: ApiCallback) {
  if (params.streams == null) {
    return next();
  }
  if (! context.acceptStreamsQueryNonStringified) {
    if (isStringifiedJSON(params.streams)) {
      try {
        params.streams = parseStreamsParams(params.streams);
      } catch (e) {
        return next(e);
      }
    } else if (isStringOrArrayOfStrings(params.streams)) {
      // good, do nothing
    } else {
      return next(errors.invalidRequestStructure('Invalid "streams" parameter. It should be an array of streamIds or JSON logical query.'))
    }
  } else {
    if (isStringifiedJSON(params.streams)) {
      try {
        params.streams = parseStreamsParams(params.streams);
      } catch (e) {
        return next(e);
      }
    } else {
      // good, do nothing
    }
  }

  // Transform object or string to Array
  if (!Array.isArray(params.streams)) {
    params.streams = [params.streams];
  }

  next();

  function parseStreamsParams(input: string): ?StreamQuery | ?Array<StreamQuery>  {
    try {
      return JSON.parse(input);
    } catch (e) {
      throw errors.invalidRequestStructure('Invalid "streams" parameter. It should be an array of streamIds or JSON logical query. Error while parsing JSON ' + e, input);
    }
  }

  /**
   * we detect if it's JSON by looking at first char. 
   * Note: since RFC 7159 JSON can also starts with ", true, false or number - this does not apply in this case.
   * @param {string} input
   */
  function isStringifiedJSON(input: any): boolean {
    return (typeof input === 'string') && ['[', '{'].includes(input.substr(0, 1));
  }

  function isStringOrArrayOfStrings(input: any): boolean {
    if (typeof input === 'string') return true;
    if (! Array.isArray(input)) return false;
    for (const item of input) {
      if (typeof item !== 'string') return false;
    }
    return true;
  }
}

async function applyDefaultsForRetrieval(context: MethodContext, params: GetEventsParams, result: Result, next: ApiCallback) {
  _.defaults(params, {
    streams: [{ any: ['*'] }],
    tags: null,
    types: null,
    fromTime: null,
    toTime: null,
    sortAscending: false,
    skip: null,
    limit: null,
    state: 'default',
    modifiedSince: null,
    includeDeletions: false
  });
  if (params.fromTime == null && params.toTime != null) {
    params.fromTime = timestamp.add(params.toTime, -24 * 60 * 60);
  }
  if (params.fromTime != null && params.toTime == null) {
    params.toTime = timestamp.now();
  }
  if (params.fromTime == null && params.toTime == null && params.limit == null) {
    // limit to 20 items by default
    params.limit = 20;
  }
  next();
}


function transformArrayOfStringsToStreamsQuery(context: MethodContext, params: GetEventsParams, result: Result, next: ApiCallback) {
  try {
    params.arrayOfStreamQueries = streamsQueryUtils.transformArrayOfStringsToStreamsQuery(params.streams);
  } catch (e) {
    return next(errors.invalidRequestStructure(e, params.streams));
  }
  next();
}

function validateStreamsQueriesAndSetStore(context: MethodContext, params: GetEventsParams, result: Result, next: ApiCallback) {
  try {
    streamsQueryUtils.validateStreamsQueriesAndSetStore(params.arrayOfStreamQueries);
    params.arrayOfStreamQueriesWithStoreId = params.arrayOfStreamQueries;
  } catch (e) {
    return next(errors.invalidRequestStructure('Initial filtering: ' + e, params.streams));
  }
  next();
}

// the two tasks are joined as '*' replaced have their permissions checked 
async function streamQueryCheckPermissionsAndReplaceStars(context: MethodContext, params: GetEventsParams, result: Result, next: ApiCallback) {
  context.tracing.startSpan('streamQueries');
  const unAuthorizedStreamIds: Array<string> = [];
  const unAccessibleStreamIds: Array<string> = [];

  async function streamExistsAndCanGetEventsOnStream(streamId: string, storeId: string, 
    unAuthorizedStreamIds: Array<string>, unAccessibleStreamIds: Array<string>): Promise<void> {
    // remove eventual '#' in streamQuery
    const cleanStreamId: string = streamId.startsWith('#') ? streamId.substr(1) : streamId;

    const stream: Stream = await context.streamForStreamId(cleanStreamId, storeId);
    if (stream == null) {
      unAccessibleStreamIds.push(cleanStreamId);
      return;
    }
    if (! await context.access.canGetEventsOnStream(cleanStreamId, storeId)) {
      unAuthorizedStreamIds.push(cleanStreamId);
    }
  }

  for (const streamQuery: StreamQueryWithStoreId of params.arrayOfStreamQueriesWithStoreId) {
    // ------------ "*" case 
    if (streamQuery.any && streamQuery.any.includes('*')) {
      if (await context.access.canGetEventsOnStream('*', streamQuery.storeId)) continue; // We can keep star

      // replace any by allowed streams for reading
      const canReadStreamIds: Array<string> = [];
      for (const streamPermission of context.access.getStoresPermissions(streamQuery.storeId)) {
        if (await context.access.canGetEventsOnStream(streamPermission.streamId, streamQuery.storeId)) {
          canReadStreamIds.push(streamPermission.streamId);
        }
      }
      streamQuery.any = canReadStreamIds;
    } else { // ------------ All other cases
      /**
       * ! we don't have to check for permissions on 'all' or 'not' as long there is at least one 'any' authorized. 
       */
      if (streamQuery?.any?.length === 0) {
        return next(errors.invalidRequestStructure('streamQueries must have a valid {any: [...]} component'));
      }

      for (const streamId: string of streamQuery.any) {
        await streamExistsAndCanGetEventsOnStream(streamId, streamQuery.storeId, unAuthorizedStreamIds, unAccessibleStreamIds);
      };
    }
  }

  if (unAuthorizedStreamIds.length > 0) {
    context.tracing.finishSpan('streamQueries');
    return next(errors.forbidden('stream [' + unAuthorizedStreamIds[0] + '] has not sufficent permission to get events'));
  }
  if (unAccessibleStreamIds.length > 0) {
    context.tracing.finishSpan('streamQueries');
    return next(errors.unknownReferencedResource(
      'stream' + (unAccessibleStreamIds.length > 1 ? 's' : ''),
      'streams',
      unAccessibleStreamIds));
  }
  next();
}

/**
 * Add "forced" and "none" events from permissions
 */
function streamQueryAddForcedAndForbiddenStreams(context: MethodContext, params: GetEventsParams, result: Result, next: ApiCallback) {
  for (const streamQuery: StreamQueryWithStoreId of params.arrayOfStreamQueriesWithStoreId) {
    // ------------ ALL --------------- //
    // add forced Streams if exists
    const forcedStreamIds: Array<string> = context.access.getForcedStreamsGetEventsStreamIds(streamQuery.storeId);

    if (forcedStreamIds?.length > 0) {
      if (streamQuery.all == null) streamQuery.all = [];
      // TODO check for duplicates
      streamQuery.all.push(...forcedStreamIds);
    }

    // ------------- NOT ------------- //
    const forbiddenStreamIds: Array<string> = context.access.getForbiddenGetEventsStreamIds(streamQuery.storeId);
    if (forbiddenStreamIds?.length > 0) {
      if (streamQuery.not == null) streamQuery.not = [];
      // TODO check for duplicates
      streamQuery.not.push(...forbiddenStreamIds);
    }
  }
  next();
}

async function streamQueryExpandStreams(context: MethodContext, params: GetEventsParams, result: Result, next: ApiCallback) {
  async function expandStreamInContext(streamId: string, storeId: string, excludedIds) {
    // remove eventual '#' in streamQuery
    if (streamId.startsWith('#')) {
      return [streamId.substr(1)]; // do not expand Stream
    }

    const query: StoreQuery =  {
      id: streamId, 
      storeId: storeId, 
      includeTrashed: params.state === 'all' || params.state === 'trashed',
      expandChildren: true,
      excludedIds: excludedIds
    };

    const tree: Array<Stream> = await mall.streams.get(context.user.id, query);
    
    // collect streamIds 
    const resultWithPrefix: Array<string> = treeUtils.collectPluck(tree, 'id');
    // remove storePrefix 
    const result: Array<string> = resultWithPrefix.map((fullStreamId: string) => StreamsUtils.storeIdAndStreamIdForStreamId(fullStreamId)[1]);
    return result;
  }

  try {
    params.arrayOfStreamQueriesWithStoreId = await streamsQueryUtils.expandAndTransformStreamQueries(params.arrayOfStreamQueriesWithStoreId, expandStreamInContext);
  } catch (e) {
    console.log(e);
    context.tracing.finishSpan('streamQueries');
    return next(e);
  }

  // delete streamQueries with no inclusions 
  params.arrayOfStreamQueriesWithStoreId = params.arrayOfStreamQueriesWithStoreId.filter(streamQuery => streamQuery.any != null || streamQuery.and != null);

  context.tracing.finishSpan('streamQueries');
  next();
}

/**
 * - Create a copy of the params per query
 * - Add specific stream queries to each of them
 */
async function findEventsFromStore(filesReadTokenSecret: string, 
  isStreamIdPrefixBackwardCompatibilityActive: boolean, isTagsBackwardCompatibilityActive: boolean,
  context: MethodContext, params: GetEventsParams, result: Result, next: ApiCallback) {
  if (params.arrayOfStreamQueriesWithStoreId?.length === 0)  {
    result.events = [];
    return next();
  }

  // in> params.fromTime = 2 params.streams = [{any: '*' storeId: 'local'}, {any: 'access-gasgsg', storeId: 'audit'}, {any: 'action-events.get', storeId: 'audit'}]
  const paramsByStoreId: Map<string, GetEventsParams> = {};
  for (const streamQuery: StreamQueryWithStoreId of params.arrayOfStreamQueriesWithStoreId) {
    const storeId: string = streamQuery.storeId;
    if (storeId == null) {
      console.error('Missing storeId' + params.arrayOfStreamQueriesWithStoreId);
      throw(new Error("Missing storeId" + params.arrayOfStreamQueriesWithStoreId));
    }
    if (paramsByStoreId[storeId] == null) {
      paramsByStoreId[storeId] = _.cloneDeep(params); // copy the parameters
      paramsByStoreId[storeId].streams = []; // empty the stream query
    }
    delete streamQuery.storeId; 
    paramsByStoreId[storeId].streams.push(streamQuery);
  }
  // out> paramsByStoreId = { local: {fromTime: 2, streams: [{any: '*}]}, audit: {fromTime: 2, streams: [{any: 'access-gagsg'}, {any: 'action-events.get}]}


  /**
   * Will be called by "mall" for each source of event that need to be streames to result
   * @param {Store} store
   * @param {ReadableStream} eventsStream of "Events"
   */
  function addnewEventStreamFromSource (store, eventsStream: ReadableStream) {
    let stream: ReadableStream = eventsStream;
    if (isStreamIdPrefixBackwardCompatibilityActive && !context.disableBackwardCompatibility) {
      stream = eventsStream.pipe(new ChangeStreamIdPrefixStream());
    } 
    if (isTagsBackwardCompatibilityActive) {
      stream = stream.pipe(new addTagsStream());
    }
    stream = stream.pipe(new SetSingleStreamIdStream());
    if (store.settings?.attachments?.setFileReadToken) {
      stream = stream.pipe(new SetFileReadTokenStream({ access: context.access, filesReadTokenSecret }));
    }
    result.addToConcatArrayStream('events', stream);
  }

  await mall.events.generateStreams(context.user.id, paramsByStoreId, addnewEventStreamFromSource);
  result.closeConcatArrayStream('events');

  return next();
}

async function init() {
  mall = await getMall();
}

module.exports = {
  init,
  applyDefaultsForRetrieval,
  coerceStreamsParam,
  validateStreamsQueriesAndSetStore,
  transformArrayOfStringsToStreamsQuery,
  streamQueryCheckPermissionsAndReplaceStars,
  streamQueryAddForcedAndForbiddenStreams,
  streamQueryExpandStreams,
  findEventsFromStore,
}