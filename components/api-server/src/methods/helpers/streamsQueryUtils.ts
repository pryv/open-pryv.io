/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Utilities for events.get stream queries.
 *
 * Documentation and specifications can be found on
 * https://github.com/pryv/docs-pryv/blob/master/pryv.io/events.get-filtering/README.md
 */
const util = require('util');
const { storeDataUtils } = require('mall');
const { findForbiddenChar } = require('../../schema/streamId.ts');
/**
 * @typedef {Object} StreamQueryScoped
 * @property {Array.<StreamQuery>} streamQuery - An array of streamQueries
 * @property {Array} nonAuthorizedStreams - The list of stream that have been unAuthorized
 */
type StreamQuery = {
  any?: Array<StreamId>; // Any of the streamIds should match or "*" for all accessible streams
  all?: Array<StreamId>; // All of the streamIds should match
  not?: Array<StreamId>; // All of the streamIds should match
  storeId?: string;
};
// A streamId
type StreamId = string;
type ExpandSetFn = (streamIds: StreamId[], storeId: string, excludedIds?: StreamId[]) => Promise<StreamId[]>;
type ExpandStreamFn = (streamId: StreamId, storeId: string, excludedIds?: StreamId[]) => Promise<StreamId[]>;
type ExpandedQuery = {
  storeId?: string;
  any?: StreamId[];
  and?: Array<{ any?: StreamId[]; not?: StreamId[] }>;
};
/**
 * For backwardCompatibility with older streams parameter ['A', 'B'] transform it to streams query [{any: ['A', 'B']}]
 * Takes care of grouping by store. ['A', 'B', ':_audit:xx'] => [{any: ['A', 'B']}, {any: ':audit:xx'}]
 * @throws - Error if mixed strings and other are found in array
 */
function transformArrayOfStringsToStreamsQuery (arrayOfQueries: Array<StreamId | StreamQuery>) {
  const { numStreamIds, streamIds } = countStreamIds(arrayOfQueries);
  if (numStreamIds === 0) { return arrayOfQueries; }
  if (numStreamIds !== arrayOfQueries.length) {
    throw new Error("Error in 'streams' parameter: streams queries and streamIds cannot be mixed");
  }
  // group streamIds per "store"
  const map: Record<string, StreamId[]> = {};
  for (const streamId of streamIds) {
    const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    if (map[storeId] == null) { map[storeId] = []; }
    map[storeId].push(streamId);
  }
  const arrayOfStreamQueries: StreamQuery[] = [];
  for (const v of Object.values(map)) {
    arrayOfStreamQueries.push({ any: v });
  }
  return arrayOfStreamQueries;
  function countStreamIds (arrayOfQueries: Array<StreamId | StreamQuery>) {
    const streamIds = arrayOfQueries.filter((item): item is StreamId => typeof item === 'string');
    return {
      numStreamIds: streamIds.length,
      streamIds
    };
  }
}
export { transformArrayOfStringsToStreamsQuery };
/**
 * @param arrayOfQueries  undefined
 * @throws - Error if query does not respect the schema
 */
function validateStreamsQueriesAndSetStore (arrayOfQueries: StreamQuery[]) {
  arrayOfQueries.forEach((streamQuery: StreamQuery) => {
    validateStreamsQuerySchemaAndSetStore(arrayOfQueries, streamQuery);
  });
  return arrayOfQueries;
}
export { validateStreamsQueriesAndSetStore };
/**
 * throw an error if streamQuery is not of the form {any: all: not: } with at least one of any or all
 * [{any: ['A', 'B', '.email']}, {any: ':_audit:xx'}] => [{any: ['A', 'B', '.email'], storeId: 'local'}, {any: 'xx', storeId: 'audit'}]
 * @param arrayOfQueries  - the full request for error message
 * @param streamQuery  undefined
 */
function validateStreamsQuerySchemaAndSetStore (arrayOfQueries: StreamQuery[], streamQuery: StreamQuery) {
  /**
   * Get StoreID, add storeId property to query and remove eventual storeId from streamId
   * @param fullStreamId - a streamId with its store prefix
   */
  function validateAndAttachStore (fullStreamId: StreamId) {
    // queries must be grouped by store
    const [thisStoreId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(fullStreamId);
    if (streamQuery.storeId == null) { streamQuery.storeId = thisStoreId; }
    if (streamQuery.storeId !== thisStoreId) {
      throw new Error("Error in 'streams' parameter '" +
                objectToString(arrayOfQueries) +
                "' streams query: '" +
                objectToString(streamQuery) +
                "' queries must me grouped by store.");
    }
    return storeStreamId;
  }
  if (streamQuery.any == null) {
    throw new Error("Error in 'streams' parameter '" +
            objectToString(arrayOfQueries) +
            "' streams query: '" +
            objectToString(streamQuery) +
            "' must contain at least one of 'any' property.");
  }
  let hasAnyStar = false;
  for (const [property, arrayOfStreamIds] of Object.entries(streamQuery)) {
    if (!['all', 'any', 'not'].includes(property)) {
      throw new Error("Error in 'streams' parameter '" +
                objectToString(arrayOfQueries) +
                "' unknown property: '" +
                property +
                "' in streams query '" +
                objectToString(streamQuery) +
                "'");
    }
    if (!Array.isArray(arrayOfStreamIds)) {
      throw new Error("Error in 'streams' parameter '" +
                objectToString(arrayOfQueries) +
                "' value of : '" +
                property +
                "' must be an array. Found: '" +
                objectToString(arrayOfStreamIds) +
                "'");
    }
    const arrayOfCleanStreamIds: StreamId[] = [];
    for (const item of arrayOfStreamIds) {
      if (typeof item !== 'string') {
        throw new Error("Error in 'streams' parameter[" +
                    objectToString(arrayOfQueries) +
                    '] all items of ' +
                    objectToString(arrayOfStreamIds) +
                    ' must be streamIds. Found: ' +
                    objectToString(item));
      }
      if (item === '#*') {
        throw new Error("Error in 'streams' parameter '" +
                    objectToString(arrayOfQueries) +
                    ', "#*" is not valid.');
      }
      const forbiddenChar = findForbiddenChar(item);
      if (forbiddenChar != null) {
        throw new Error("Error in 'streams' parameter '" +
                    objectToString(arrayOfQueries) +
                    "' forbidden character '" +
                    forbiddenChar +
                    "' in streamId '" +
                    item +
                    "'.");
      }
      if (property !== 'any' && item === '*') {
        throw new Error("Error in 'streams' parameter[" +
                    objectToString(arrayOfQueries) +
                    "] only 'any' can contain '*' : " +
                    objectToString(arrayOfStreamIds));
      }
      if (property === 'any' && item === '*') {
        hasAnyStar = true;
        if (arrayOfStreamIds.length > 1) {
          throw new Error("Error in 'streams' parameter[" +
                        objectToString(arrayOfQueries) +
                        "] '*' cannot be mixed with other streamIds in 'any': " +
                        objectToString(arrayOfStreamIds));
        }
      }
      const cleanStreamid = validateAndAttachStore(item);
      arrayOfCleanStreamIds.push(cleanStreamid);
      (streamQuery as Record<string, unknown>)[property] = arrayOfCleanStreamIds;
    }
  }
  if (hasAnyStar && streamQuery.all != null) {
    throw new Error("Error in 'streams' parameter[" +
            objectToString(streamQuery) +
            "] {any: '*'} cannot be mixed with 'all': " +
            objectToString(arrayOfQueries));
  }
}
/**
 * @param excludedIds - Array of streams to exclude from expand
 */
function uniqueStreamIds (arrayOfStreamiIs: StreamId[]): StreamId[] {
  return [...new Set(arrayOfStreamiIs)];
}
export const expandAndTransformStreamQueries = async function expandAndTransformStreamQueries (streamQueries: StreamQuery[], expandStream: ExpandStreamFn) {
      async function expandSet (streamIds: StreamId[], storeId: string, excludedIds: StreamId[] = []): Promise<StreamId[]> {
        const expandedSet = new Set<StreamId>(); // use a Set to avoid duplicate entries;
        for (const streamId of streamIds) {
          // skip streamId presents in exluded set
          if (!excludedIds.includes(streamId)) {
            (await expandStream(streamId, storeId, excludedIds)).forEach((item: StreamId) => expandedSet.add(item));
          }
        }
        return Array.from(expandedSet);
      }
      const res: ExpandedQuery[] = [];
      for (const streamQuery of streamQueries) {
        const expandedQuery = await expandAndTransformStreamQuery(streamQuery, expandSet);
        if (expandedQuery) { res.push(expandedQuery); }
      }
      return res;
    };
async function expandAndTransformStreamQuery (streamQuery: StreamQuery, expandSet: ExpandSetFn): Promise<ExpandedQuery | null> {
  let containsAtLeastOneInclusion = false;
  const res: ExpandedQuery = { storeId: streamQuery.storeId };
  // any
  if (streamQuery.any) {
    const expandedSet = await expandSet(streamQuery.any, streamQuery.storeId!, streamQuery.not);
    if (expandedSet.length > 0) {
      containsAtLeastOneInclusion = true;
      res.any = uniqueStreamIds(expandedSet);
    }
  }
  // all
  if (streamQuery.all) {
    for (const streamId of streamQuery.all) {
      const expandedSet = await expandSet([streamId], streamQuery.storeId!, streamQuery.not);
      if (expandedSet.length === 0) { continue; } // escape
      if (!res.and) { res.and = []; }
      containsAtLeastOneInclusion = true;
      res.and.push({ any: uniqueStreamIds(expandedSet) });
    }
  }
  // not
  if (streamQuery.not) {
    const not: StreamId[] = [];
    for (const streamId of streamQuery.not) {
      const expandedSet = await expandSet([streamId], streamQuery.storeId!, streamQuery.any);
      if (expandedSet.length === 0) { continue; } // escape
      not.push(...expandedSet);
    }
    if (not.length > 0) {
      if (!res.and) { res.and = []; }
      res.and.push({ not: uniqueStreamIds(not) });
    }
  }
  return containsAtLeastOneInclusion ? res : null;
}
// ------------------------ helpers ----------------------------------//
/**
 * for nice error message with clear query content
 */
function objectToString (object: unknown) {
  return util.inspect(object, { depth: 5 });
}
