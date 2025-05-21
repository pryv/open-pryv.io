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
