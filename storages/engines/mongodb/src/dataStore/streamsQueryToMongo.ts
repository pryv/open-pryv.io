/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Transform stream queries for MongoDB query format.
 */
export function toMongoDBQuery (streamQueriesArray) {
  let mongoQuery = null; // no streams
  if (streamQueriesArray !== null) {
    if (streamQueriesArray.length === 1) {
      mongoQuery = streamQueryToMongoDBQuery(streamQueriesArray[0]);
    } else {
      // pack in $or
      mongoQuery = { $or: streamQueriesArray.map(streamQueryToMongoDBQuery) };
    }
  }
  if (mongoQuery === null) { mongoQuery = { streamIds: { $in: [] } }; } // no streams
  return mongoQuery;
}

/**
 * Convert a streamQuery to a query usable by MongoDB
 * @param {Array<StreamQuery>|null} streamQuery
 * @returns {{}}
 */
function streamQueryToMongoDBQuery (streamQuery) {
  if (streamQuery == null) return {};

  const ands = [];

  for (const item of streamQuery) {
    addItem(item);
  }

  if (ands.length === 0) {
    return {};
  } else if (ands.length === 1) {
    return ands[0];
  } else {
    return { $and: ands };
  }

  function addItem (item) {
    if (item.any && item.any.length > 0) {
      if (!item.any.includes('*')) {
        // ignore queries that contains '*';
        if (item.any.length === 1) {
          ands.push({ streamIds: { $eq: item.any[0] } });
        } else {
          ands.push({ streamIds: { $in: item.any } });
        }
      }
    }
    if (item.not && item.not.length > 0) {
      if (item.not.length === 1) {
        ands.push({ streamIds: { $ne: item.not[0] } });
      } else {
        ands.push({ streamIds: { $nin: item.not } });
      }
    }
  }
}
