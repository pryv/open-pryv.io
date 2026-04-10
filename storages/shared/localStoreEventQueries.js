/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Converters to common query logic for localStores
 * Might by moved tp @pryv/datastore repo
 */

const timestamp = require('unix-timestamp');
const DELTA_TO_CONSIDER_IS_NOW = 5; // 5 seconds

module.exports = {
  localStorePrepareOptions,
  localStorePrepareQuery
};

/**
 * Convert store API options params to local store options
 * @param {object} options
 * @returns {object}
 */
function localStorePrepareOptions (options) {
  const localOptions = {
    sort: { time: options.sortAscending ? 1 : -1 },
    skip: options.skip,
    limit: options.limit
  };
  return localOptions;
}

/**
 * Convert store API query params to an array of queries
 * @param {object} query
 * @returns {object}
 */
function localStorePrepareQuery (query) {
  const localQuery = [];
  // trashed
  switch (query.state) {
    case 'trashed':
      localQuery.push({ type: 'equal', content: { field: 'trashed', value: true } });
      break;
    case 'all':
      break;
    default:
      localQuery.push({ type: 'equal', content: { field: 'trashed', value: false } });
  }

  // modified since
  if (query.modifiedSince != null) {
    localQuery.push({ type: 'greater', content: { field: 'modified', value: query.modifiedSince } });
  }

  // types
  if (query.types && query.types.length > 0) {
    localQuery.push({ type: 'typesList', content: query.types });
  }

  // if streams are defined
  if (query.streams && query.streams.length !== 0) {
    localQuery.push({ type: 'streamsQuery', content: query.streams });
  }

  // -------------- time selection -------------- //
  if (query.toTime != null) {
    localQuery.push({ type: 'lowerOrEqual', content: { field: 'time', value: query.toTime } });
  }

  // running
  if (query.running) {
    localQuery.push({ type: 'equal', content: { field: 'endTime', value: null } });
  } else if (query.fromTime != null) {
    const now = timestamp.now() - DELTA_TO_CONSIDER_IS_NOW;
    if (query.fromTime <= now && (query.toTime == null || query.toTime >= now)) { // timeFrame includes now
      localQuery.push({ type: 'greaterOrEqualOrNull', content: { field: 'endTime', value: query.fromTime } });
    } else {
      localQuery.push({ type: 'greaterOrEqual', content: { field: 'endTime', value: query.fromTime } });
    }
  }
  return localQuery;
}
