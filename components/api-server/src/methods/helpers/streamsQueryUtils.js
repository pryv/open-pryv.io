/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */

/**
 * Utilities for events.get stream queries.
 * 
 * Documentation and specifications can be found on 
 * https://github.com/pryv/docs-pryv/blob/master/pryv.io/events.get-filtering/README.md
 */
const util = require('util');

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
 * For retrocompatibility with older streams parameter ['A', 'B'] transform it to streams query [{any: ['A', 'B']}]
 * @param {Array.<StreamQuery>} arrayOfQueries 
 * @throws - Error if mixed strings and other are found in array
 */
function transformArrayOfStringsToStreamsQuery(arrayOfQueries) {

  const streamIds = arrayOfQueries.filter(item => typeof item === 'string');

  if (streamIds.length === 0) return arrayOfQueries;

  if (streamIds.length != arrayOfQueries.length) {
    throw('Error in "streams" parameter: streams queries and streamIds cannot be mixed');
  }

  return [{any: streamIds}];
}
module.exports.transformArrayOfStringsToStreamsQuery = transformArrayOfStringsToStreamsQuery;

/**
 * @param {Array.<StreamQuery>} arrayOfQueries 
 * @throws - Error if query does not respect the schema
 */
function validateStreamsQuery(arrayOfQueries) {
  arrayOfQueries.forEach((streamQuery) => { 
    validateStreamsQuerySchema(arrayOfQueries, streamQuery); 
  });
}
/**
 * throw an error if streamQuery is not of the form {any: all: not: } with at least one of any or all 
 * @param {Array.<StreamQuery>} arrayOfQueries - the full request for error message
 * @param {StreamQuery} streamQuery 
 */
function validateStreamsQuerySchema(arrayOfQueries, streamQuery) {
  
  if (! streamQuery.any && ! streamQuery.all) {
    throw ('Error in "streams" parameter "' + objectToString(arrayOfQueries) + '" streams query: "' + objectToString(streamQuery) +'" must contain at least one of "any" or "all" property');
  }
  const res = {};
  for (const [property, arrayOfStreamIds] of Object.entries(streamQuery)) {
    if (! ['all', 'any', 'not'].includes(property))
      throw ('Error in "streams" parameter "' + objectToString(arrayOfQueries) + '" unkown property: "' + property +'" in streams query "' + objectToString(streamQuery) + '"');
  
    if (! Array.isArray(arrayOfStreamIds)) {
      if (property === 'any' && arrayOfStreamIds === '*') {
        continue; // stop here and go to next property
      } else {
        throw ('Error in "streams" parameter "' + objectToString(arrayOfQueries) + '" value of : "' + property +'" must be an array. Found: "' + objectToString(arrayOfStreamIds) + '"' );
      }
    }

    for (item of arrayOfStreamIds) {
      if (typeof item !== 'string')
        throw ('Error in "streams" parameter[' + objectToString(arrayOfQueries) + '] all items of ' + objectToString(arrayOfStreamIds) +' must be streamIds. Found: ' + objectToString(item) );
    }
  }
}
exports.validateStreamsQuery = validateStreamsQuery;

/**
 * @param {Array.<StreamQuery>} - array of streamQUeries 
 * @param {Function} expand should return the streamId in argument and its children (or null if does not exist).
 * @param {Array.<StreamId>} allAuthorizedStreams - the list of authorized streams
 * @param {Array.<StreamId>} allAccessibleStreams - the list of "visible" streams (i.e not trashed when state = default)
 * @returns {StreamQuery} 
 */
function checkPermissionsAndApplyToScope(arrayOfQueries, expand, allAuthorizedStreams, allAccessibleStreams) {
  
  // registerStream will collect all nonAuthorized streams here during streamQuery inspection
  const nonAuthorizedStreams = [];

  // inspect each streamQuery and remove enventual null
  const arrayOfQueriesResult = arrayOfQueries.map(expandAndTransformStreamQuery).filter((streamQuery) => { 
    return streamQuery !== null; // some streamQuery can be translated to "null" if no inclusion are found
  });

  if (arrayOfQueriesResult.length === 0) {
    return {
      nonAuthorizedStreams: nonAuthorizedStreams,
      streamQuery: null // means no scope
    }
  }

  return {
    nonAuthorizedStreams: nonAuthorizedStreams,
    streamQuery: arrayOfQueriesResult
  }

  /**
   * { any: '*', and: [any: .. , any: ... , or: ...]
   * }
   * @param {Object} streamQuery 
   */
  function expandAndTransformStreamQuery(streamQuery) {
    let containsAtLeastOneInclusion = false; 

    const res = { };

    // any
    if (streamQuery.any) {
      if (streamQuery.any === '*' && allAccessibleStreams.length > 0) {
        res.any = allAccessibleStreams;
        containsAtLeastOneInclusion = true;
      } else {
        const expandedSet = expandSet(streamQuery.any);
        if (expandedSet.length > 0) {
          containsAtLeastOneInclusion = true;
          res.any = expandedSet;
        }
      }
    }

    // all & not share the same logic
    for (const property of ['all', 'not']) {
      if (streamQuery[property]) {
        for (let streamId of streamQuery[property]) {
          const expandedSet = expandSet([streamId]);
          if (expandedSet.length > 0) {
            if (! res.and) res.and = [];
            let key = 'not';
            if (property === 'all') {
              containsAtLeastOneInclusion = true;
              key = 'any';
            } 
            res.and.push({[key]: expandedSet});
          }
        }
      }
    }
  
    return (containsAtLeastOneInclusion) ? res : null;
  }

  /**
   * @param {Array} streamIds - an array of streamids
   */
  function expandSet(streamIds) {
    const result = [];

    for (let streamId of streamIds) {
      if (streamId.startsWith('#')) { 
        addToResult(streamId.substr(1));
      } else {
        if (registerStream(streamId)) { 
          for (let expandedStream of expand(streamId)) { // expand can send "null" values
            if (expandedStream !== null) {
              addToResult(expandedStream)
            }
          }
        } 
      }
    }
    return result;

    function addToResult(streamId) {
      const ok = registerStream(streamId);
      if (ok && ! result.includes(streamId)) {
        result.push(streamId);
      }
      return ok;
    }

    /**
     * uses allAuthorizedStreams and allAccessibleStreams to check if it can be used in query
     * @param {string} streamId 
     * @returns {boolean} - true is streamId Can be used in the query
     */
    function registerStream(streamId) {
      const isAuthorized = allAuthorizedStreams.includes(streamId);
      if (! isAuthorized) { 
        nonAuthorizedStreams.push(streamId);
        return false;
      }
      const isAccessible = allAccessibleStreams.includes(streamId);
      if (! isAccessible) return false;
      return true;
    }
  }
}
exports.checkPermissionsAndApplyToScope = checkPermissionsAndApplyToScope;

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
      mongoQuery =  {$or: streamQueriesArray.map(streamQueryToMongoDBQuery)};
    }
  }

  if (mongoQuery === null)  mongoQuery = {streamIds: {$in: []}}; // no streams

  if (forbiddenStreamsIds && forbiddenStreamsIds.length > 0) {
    mongoQuery.streamIds = mongoQuery.streamIds || {};
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
  const res = { };
  if (streamQuery.any && streamQuery.any.length > 0) { 
    if ( streamQuery.any.length === 1) {
      res.streamIds = { $eq: streamQuery.any[0]};
    } else {
      res.streamIds = { $in: streamQuery.any};
    }
  }
  // only reached from a "and" property
  if (streamQuery.not && streamQuery.not.length > 0) {
    if (res.streamIds) res.streamIds = {};
    if ( streamQuery.not.length === 1) {
      res.streamIds = { $ne: streamQuery.not[0] };
    } else {
      res.streamIds = { $nin : streamQuery.not};
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
  return util.inspect(object, {depth: 5})
}