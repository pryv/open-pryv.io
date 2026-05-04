/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * Some method used by events.get are shared with audit.getLogs
 */
const streamsQueryUtils = require('./streamsQueryUtils');
const timestamp = require('unix-timestamp');
const errors = require('errors').factory;
const { getMall, storeDataUtils } = require('mall');
const { treeUtils } = require('utils');
const utils = require('utils');
const { Readable } = require('stream');
const SetFileReadTokenStream = require('../streams/SetFileReadTokenStream');
const accountStreams = require('business/src/system-streams');
const integrity = require('business/src/integrity');
let mall;

module.exports = {
  init,
  applyDefaultsForRetrieval,
  coerceStreamsParam,
  validateStreamsQueriesAndSetStore,
  transformArrayOfStringsToStreamsQuery,
  streamQueryCheckPermissionsAndReplaceStars,
  streamQueryAddForcedAndForbiddenStreams,
  streamQueryExpandStreams,
  streamQueryAddHiddenStreams,
  findEventsFromStore
};

/**
 *  # Stream Query Flow
 *  1. coerceStreamParam:
 *    - null `streams` is changed to `[{any: ['*']}]`
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
 *    - Do not expand streams whose id is followed by a `!` (a.k.a. "do not expand" marker)
 *
 *    - A callBack `expandStreamInContext` is used to link the expand process and the "store"
 *      This callBack is designed to be optimized on a Per-Store basis The current implementation is generic
 *      - If streamId is followed by the "do not expand" marker (`!`) just return the bare streamId
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
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {any}
 */
function coerceStreamsParam (context, params, result, next) {
  if (params.streams == null) {
    return next();
  }
  if (!context.acceptStreamsQueryNonStringified) {
    if (isStringifiedJSON(params.streams)) {
      try {
        params.streams = parseStreamsParams(params.streams);
      } catch (e) {
        return next(e);
      }
    } else if (isStringOrArrayOfStrings(params.streams)) {
      // good, do nothing
    } else {
      return next(errors.invalidRequestStructure('Invalid "streams" parameter. It should be an array of streamIds or JSON logical query.'));
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
  function parseStreamsParams (input) {
    try {
      return JSON.parse(input);
    } catch (e) {
      throw errors.invalidRequestStructure('Invalid "streams" parameter. It should be an array of streamIds or JSON logical query. Error while parsing JSON ' +
                e, input);
    }
  }
  /**
   * we detect if it's JSON by looking at first char.
   * Note: since RFC 7159 JSON can also starts with ", true, false or number - this does not apply in this case.
   * @param {string} input
   */
  function isStringifiedJSON (input) {
    return typeof input === 'string' && ['[', '{'].includes(input.substr(0, 1));
  }
  function isStringOrArrayOfStrings (input) {
    if (typeof input === 'string') { return true; }
    if (!Array.isArray(input)) { return false; }
    for (const item of input) {
      if (typeof item !== 'string') { return false; }
    }
    return true;
  }
}
/**
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {Promise<void>}
 */
async function applyDefaultsForRetrieval (context, params, result, next) {
  params.streams ??= [{ any: ['*'] }];
  params.types ??= null;
  params.fromTime ??= null;
  params.toTime ??= null;
  params.sortAscending ??= false;
  params.skip ??= null;
  params.limit ??= null;
  params.state ??= 'default';
  params.modifiedSince ??= null;
  params.includeDeletions ??= false;
  if (params.fromTime == null && params.toTime != null) {
    params.fromTime = timestamp.add(params.toTime, -24 * 60 * 60);
  }
  if (params.fromTime != null && params.toTime == null) {
    params.toTime = timestamp.now();
  }
  if (params.fromTime == null &&
        params.toTime == null &&
        params.limit == null) {
    // limit to 20 items by default
    params.limit = 20;
  }
  next();
}
/**
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {any}
 */
function transformArrayOfStringsToStreamsQuery (context, params, result, next) {
  try {
    params.arrayOfStreamQueries =
            streamsQueryUtils.transformArrayOfStringsToStreamsQuery(params.streams);
  } catch (e) {
    return next(errors.invalidRequestStructure(e, params.streams));
  }
  next();
}
/**
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {any}
 */
function validateStreamsQueriesAndSetStore (context, params, result, next) {
  try {
    streamsQueryUtils.validateStreamsQueriesAndSetStore(params.arrayOfStreamQueries);
    params.arrayOfStreamQueriesWithStoreId = params.arrayOfStreamQueries;
  } catch (e) {
    return next(errors.invalidRequestStructure('Initial filtering: ' + e, params.streams));
  }
  next();
}
// the two tasks are joined as '*' replaced have their permissions checked
/**
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {Promise<any>}
 */
async function streamQueryCheckPermissionsAndReplaceStars (context, params, result, next) {
  context.tracing.startSpan('streamQueries');
  const unAuthorizedStreamIds = [];
  const unAccessibleStreamIds = [];
  async function streamExistsAndCanGetEventsOnStream (streamId, storeId, unAuthorizedStreamIds, unAccessibleStreamIds) {
    const cleanStreamId = hasDoNotExpandMarker(streamId)
      ? stripDoNotExpandMarker(streamId)
      : streamId;
    const stream = await context.streamForStreamId(cleanStreamId, storeId);
    if (stream == null) {
      unAccessibleStreamIds.push(cleanStreamId);
      return;
    }
    if (!(await context.access.canGetEventsOnStream(cleanStreamId, storeId))) {
      unAuthorizedStreamIds.push(cleanStreamId);
    }
  }
  const additionalStoreQueries = [];
  for (const streamQuery of params.arrayOfStreamQueriesWithStoreId) {
    // ------------ "*" case
    if (streamQuery.any && streamQuery.any.includes('*')) {
      if (await context.access.canGetEventsOnStream('*', streamQuery.storeId)) {
        // Personal access with '*' on local store: also query account store
        if (streamQuery.storeId === storeDataUtils.LocalStoreId) {
          additionalStoreQueries.push({ any: ['*'], storeId: storeDataUtils.AccountStoreId });
        }
        continue;
      } // We can keep star
      // replace any by allowed streams for reading
      const canReadStreamIds = [];
      for (const streamPermission of context.access.getStoresPermissions(streamQuery.storeId)) {
        if (await context.access.canGetEventsOnStream(streamPermission.streamId, streamQuery.storeId)) {
          canReadStreamIds.push(streamPermission.streamId);
        }
      }
      streamQuery.any = canReadStreamIds;
      // For limited accesses on local store, also create queries for the account
      // store (account events are stored locally but routed via account permissions,
      // e.g. :system:email). Only applies to local store star queries — explicit
      // queries to other stores (like :_audit:) should not leak into unrelated stores.
      if (streamQuery.storeId !== storeDataUtils.LocalStoreId) continue;
      for (const [otherStoreId, perms] of Object.entries(context.access._streamByStorePermissionsMap || {})) {
        if (otherStoreId === streamQuery.storeId) continue;
        if (params.arrayOfStreamQueriesWithStoreId.some(q => q.storeId === otherStoreId)) continue;
        // Skip audit store — audit events should only appear via explicit :_audit: queries
        if (otherStoreId === '_audit') continue;
        const otherStreamIds = [];
        for (const perm of Object.values(perms)) {
          if (await context.access.canGetEventsOnStream(perm.streamId, otherStoreId)) {
            otherStreamIds.push(perm.streamId);
          }
        }
        if (otherStreamIds.length > 0) {
          additionalStoreQueries.push({ any: otherStreamIds, storeId: otherStoreId });
        }
      }
    } else {
      // ------------ All other cases
      /**
       * ! we don't have to check for permissions on 'all' or 'not' as long there is at least one 'any' authorized.
       */
      if (streamQuery?.any?.length === 0) {
        return next(errors.invalidRequestStructure('streamQueries must have a valid {any: [...]} component'));
      }
      for (const streamId of streamQuery.any) {
        await streamExistsAndCanGetEventsOnStream(streamId, streamQuery.storeId, unAuthorizedStreamIds, unAccessibleStreamIds);
      }
    }
  }
  // Append queries for other stores discovered during '*' expansion (limited accesses)
  if (additionalStoreQueries.length > 0) {
    params.arrayOfStreamQueriesWithStoreId.push(...additionalStoreQueries);
  }
  if (unAuthorizedStreamIds.length > 0) {
    context.tracing.finishSpan('streamQueries');
    return next(errors.forbidden('stream [' +
            unAuthorizedStreamIds[0] +
            '] has not sufficent permission to get events'));
  }
  if (unAccessibleStreamIds.length > 0) {
    context.tracing.finishSpan('streamQueries');
    return next(errors.unknownReferencedResource('stream' + (unAccessibleStreamIds.length > 1 ? 's' : ''), 'streams', unAccessibleStreamIds));
  }
  next();
}
/**
 * Add "forced" and "none" events from permissions
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {void}
 */
function streamQueryAddForcedAndForbiddenStreams (context, params, result, next) {
  for (const streamQuery of params.arrayOfStreamQueriesWithStoreId) {
    // ------------ ALL --------------- //
    // add forced Streams if exists
    const forcedStreamIds = context.access.getForcedStreamsGetEventsStreamIds(streamQuery.storeId);
    if (forcedStreamIds?.length > 0) {
      if (streamQuery.all == null) { streamQuery.all = []; }
      // TODO check for duplicates
      streamQuery.all.push(...forcedStreamIds);
    }
    // ------------- NOT ------------- //
    const forbiddenStreamIds = context.access.getForbiddenGetEventsStreamIds(streamQuery.storeId);
    if (forbiddenStreamIds?.length > 0) {
      if (streamQuery.not == null) { streamQuery.not = []; }
      // TODO check for duplicates
      streamQuery.not.push(...forbiddenStreamIds);
    }
    // For non-personal local store queries, exclude account streams root.
    // Account events physically live in local MongoDB but are gated by
    // account store permissions. The root exclusion propagates through
    // stream expansion to exclude all children.
    if (streamQuery.storeId === storeDataUtils.LocalStoreId && !context.access.isPersonal()) {
      if (streamQuery.not == null) { streamQuery.not = []; }
      streamQuery.not.push(accountStreams.STREAM_ID_ACCOUNT);
    }
  }
  next();
}
/**
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {Promise<any>}
 */
async function streamQueryExpandStreams (context, params, result, next) {
  try {
    params.arrayOfStreamQueriesWithStoreId =
            await streamsQueryUtils.expandAndTransformStreamQueries(params.arrayOfStreamQueriesWithStoreId, expandStreamInContext);
  } catch (e) {
    console.log(e);
    context.tracing.finishSpan('streamQueries');
    return next(e);
  }
  // delete streamQueries with no inclusions
  params.arrayOfStreamQueriesWithStoreId =
        params.arrayOfStreamQueriesWithStoreId.filter((streamQuery) => streamQuery.any != null || streamQuery.and != null);
  context.tracing.finishSpan('streamQueries');
  next();
  async function expandStreamInContext (streamId, storeId, excludedIds) {
    if (hasDoNotExpandMarker(streamId)) {
      return [stripDoNotExpandMarker(streamId)];
    }
    const query = {
      id: streamId,
      storeId,
      includeTrashed: params.state === 'all' || params.state === 'trashed',
      childrenDepth: -1,
      excludedIds,
      hideStoreRoots: true
    };
    const tree = await mall.streams.get(context.user.id, query);
    // collect streamIds
    const resultWithPrefix = treeUtils.collectPluck(tree, 'id');
    // remove storePrefix
    const result = resultWithPrefix.map((fullStreamId) => storeDataUtils.parseStoreIdAndStoreItemId(fullStreamId)[1]);
    return result;
  }
}
/**
 * @returns {any}
 */
function hasDoNotExpandMarker (streamId) {
  return streamId.endsWith('!');
}
/**
 * Warning: assumes (without checking) that the "do not expand" marker is present!
 * @returns {any}
 */
function stripDoNotExpandMarker (streamIdWithDoNotExpandMarker) {
  return streamIdWithDoNotExpandMarker.slice(0, -1);
}
/**
 * Add Hidden StreamsId (System) to local queries and eventually trashed streams if state !== 'all'
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {Promise<void>}
 */
async function streamQueryAddHiddenStreams (context, params, result, next) {
  // forbidden stream
  const forbiddenStreamIds = accountStreams.hiddenStreamIds;
  for (const streamQuery of params.arrayOfStreamQueriesWithStoreId) {
    if (streamQuery.storeId !== 'local' && streamQuery.storeId !== storeDataUtils.AccountStoreId) { continue; }
    if (streamQuery.and == null) { streamQuery.and = []; }
    streamQuery.and.push({ not: forbiddenStreamIds });
  }
  // trashed stream (it's enough to add only root streams, as they will expanded later on)
  if (params.state !== 'all' && params.state !== 'trashed') {
    // if query contains '*' make sure to not include Trashed root streams
    for (const streamQuery of params.arrayOfStreamQueriesWithStoreId) {
      if (streamQuery.any == null || !streamQuery.any.includes('*')) { continue; }
      // get trashed root streams from store
      const rootStreams = await mall.streams.get(context.user.id, {
        id: '*',
        storeId: streamQuery.storeId,
        childrenDepth: 0,
        includeTrashed: true,
        excludedIds: []
      });
      const trashedRootStreamsIds = rootStreams
        .filter((stream) => stream.trashed)
        .map((stream) => stream.id);
      if (streamQuery.and == null) { streamQuery.and = []; }
      streamQuery.and.push({ not: trashedRootStreamsIds });
    }
  }
  next();
}
/**
 * - Create a copy of the params per query
 * - Add specific stream queries to each of them
 * @param {string} filesReadTokenSecret
 * @param {MethodContext} context
 * @param {GetEventsParams} params
 * @param {Result} result
 * @param {ApiCallback} next
 * @returns {Promise<any>}
 */
async function findEventsFromStore (filesReadTokenSecret, context, params, result, next) {
  if (params.arrayOfStreamQueriesWithStoreId?.length === 0) {
    result.events = [];
    return next();
  }
  // in> params.fromTime = 2 params.streams = [{any: '*' storeId: 'local'}, {any: 'access-gasgsg', storeId: 'audit'}, {any: 'action-events.get', storeId: 'audit'}]
  const paramsByStoreId = {};
  for (const streamQuery of params.arrayOfStreamQueriesWithStoreId) {
    const storeId = streamQuery.storeId;
    if (storeId == null) {
      console.error('Missing storeId' + params.arrayOfStreamQueriesWithStoreId);
      throw new Error('Missing storeId' + params.arrayOfStreamQueriesWithStoreId);
    }
    if (paramsByStoreId[storeId] == null) {
      paramsByStoreId[storeId] = structuredClone(params); // copy the parameters
      paramsByStoreId[storeId].streams = []; // empty the stream query
    }
    delete streamQuery.storeId;
    paramsByStoreId[storeId].streams.push(streamQuery);
  }
  // out> paramsByStoreId = { local: {fromTime: 2, streams: [{any: '*}]}, audit: {fromTime: 2, streams: [{any: 'access-gagsg'}, {any: 'action-events.get}]}
  /**
   * Will be called by "mall" for each store of events that need to be streamed to result
   * @param {Object} storeSettings
   * @param {ReadableStream} eventsStream of "Events"
   */
  function addEventsStreamFromStore (storeSettings, eventsStream) {
    let stream = eventsStream;
    if (storeSettings?.attachments?.setFileReadToken) {
      stream = stream.pipe(new SetFileReadTokenStream({
        access: context.access,
        filesReadTokenSecret
      }));
    }
    result.addToConcatArrayStream('events', stream);
  }
  // When account store is included (from * queries), fetch its events non-streaming
  // and merge with local store results to respect global skip/limit.
  const accountStoreId = storeDataUtils.AccountStoreId;
  if (paramsByStoreId[accountStoreId]) {
    // Fetch account events non-streaming (always a small set: < 10 account fields).
    // Remove skip/limit — account events are few and we apply global skip/limit after merge.
    const accountParams = paramsByStoreId[accountStoreId];
    delete accountParams.skip;
    delete accountParams.limit;
    const accountEvents = await mall.events.getWithParamsByStore(
      context.user.id, { [accountStoreId]: accountParams }
    );
    if (integrity.events.isActive) {
      for (const event of accountEvents) {
        integrity.events.set(event);
      }
    }
    delete paramsByStoreId[accountStoreId];

    // Fetch local store events non-streaming. Adjust limit to fetch enough for
    // merged sort/skip (skip + limit pool), then apply global skip/limit after merge.
    const localStoreId = storeDataUtils.LocalStoreId;
    if (paramsByStoreId[localStoreId]) {
      const localParams = paramsByStoreId[localStoreId];
      const origSkip = localParams.skip || 0;
      const origLimit = localParams.limit;
      // Fetch skip+limit events with no skip (we apply skip globally after merge)
      localParams.skip = 0;
      if (origLimit != null) {
        localParams.limit = origSkip + origLimit;
      }
      const localEvents = await mall.events.getWithParamsByStore(
        context.user.id, { [localStoreId]: localParams }
      );
      // Apply file read tokens to local events with attachments
      for (const event of localEvents) {
        if (event.attachments) {
          for (const att of event.attachments) {
            att.readToken = utils.encryption.fileReadToken(
              att.id, context.access.id, context.access.token, filesReadTokenSecret
            );
          }
        }
      }
      // Merge, sort, apply global skip/limit
      let merged = accountEvents.concat(localEvents);
      const sortDir = params.sortAscending ? 1 : -1;
      merged.sort((a, b) => sortDir * (a.time - b.time));
      if (origSkip) merged = merged.slice(origSkip);
      if (origLimit != null) merged = merged.slice(0, origLimit);
      result.addToConcatArrayStream('events', Readable.from(merged));
      delete paramsByStoreId[localStoreId];
    } else {
      // Only account store, no local store
      result.addToConcatArrayStream('events', Readable.from(accountEvents));
    }
  }
  // Stream remaining stores (audit, etc.) as before
  if (Object.keys(paramsByStoreId).length > 0) {
    await mall.events.generateStreamsWithParamsByStore(context.user.id, paramsByStoreId, addEventsStreamFromStore);
  }
  result.closeConcatArrayStream('events');
  return next();
}
/**
 * @returns {Promise<void>}
 */
async function init () {
  mall = await getMall();
}

/**
 * @typedef {{
 *   streams?: Array<string> | string | StreamQuery | Array<StreamQuery>;
 *   arrayOfStreamQueries?: Array<StreamQuery>;
 *   arrayOfStreamQueriesWithStoreId?: Array<StreamQueryWithStoreId>;
 *   types?: Array<string>;
 *   fromTime?: number;
 *   toTime?: number;
 *   sortAscending?: boolean;
 *   skip?: number;
 *   limit?: number;
 *   state?: 'default' | 'all' | 'trashed';
 *   modifiedSince?: number;
 *   includeDeletions?: boolean;
 * }} GetEventsParams
 */

/**
 * @typedef {{
 *   id: string;
 *   storeId: string;
 *   includeTrashed: boolean;
 *   childrenDepth: integer;
 *   excludedIds: Array<string>;
 *   hideStoreRoots?: boolean;
 * }} StoreQuery
 */
