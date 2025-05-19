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
const errors = require('errors').factory;
const commonFns = require('api-server/src/methods/helpers/commonFunctions');
const methodsSchema = require('../schema/auditMethods');
const eventsGetUtils = require('api-server/src/methods/helpers/eventsGetUtils');
const { getStoreQueryFromParams, getStoreOptionsFromParams } = require('mall/src/helpers/eventsQueryUtils');
const { localStorePrepareOptions, localStorePrepareQuery } = require('storage/src/localStoreEventQueries');

const audit = require('audit');
const auditStorage = audit.storage;
const { ConvertEventFromStoreStream } = require('mall/src/helpers/eventsUtils');
/**
 * @param api
 */
module.exports = function (api) {
  api.register('audit.getLogs',
    eventsGetUtils.coerceStreamsParam,
    commonFns.getParamsValidation(methodsSchema.get.params),
    eventsGetUtils.applyDefaultsForRetrieval,
    eventsGetUtils.transformArrayOfStringsToStreamsQuery,
    anyStarStreamQueryIsNullQUery,
    removeStoreIdFromStreamQuery,
    limitStreamQueryToAccessToken,
    getAuditLogs);
};
/**
 * @returns {void}
 */
function anyStarStreamQueryIsNullQUery (context, params, result, next) {
  if (isStar(params.arrayOfStreamQueries)) {
    params.arrayOfStreamQueries = null;
  }
  next();
  /**
   * arrayOfStreamQueries === [{ any: ['*']}]
   * @param {*} arrayOfStreamQueries
   */
  function isStar (arrayOfStreamQueries) {
    return (params.arrayOfStreamQueries.length === 1 &&
            params.arrayOfStreamQueries[0]?.any?.length === 1 &&
            params.arrayOfStreamQueries[0]?.any[0] === '*');
  }
}
/**
 * Remove ':audit:' from stream query;
 * @returns {any}
 */
function removeStoreIdFromStreamQuery (context, params, result, next) {
  if (params.arrayOfStreamQueries == null) { return next(); }
  for (const query of params.arrayOfStreamQueries) {
    for (const item of ['all', 'any', 'not']) {
      if (query[item] != null) {
        const streamIds = query[item];
        for (let i = 0; i < streamIds.length; i++) {
          const streamId = streamIds[i];
          if (!streamId.startsWith(audit.CONSTANTS.STORE_PREFIX)) {
            return next(errors.invalidRequestStructure('Invalid "streams" parameter. It should be an array of streamIds starting with Audit store prefix: "' +
                            audit.CONSTANTS.STORE_PREFIX +
                            '"', params.arrayOfStreamQueries));
          }
          streamIds[i] = streamId.substring(audit.CONSTANTS.STORE_PREFIX.length);
        }
      }
    }
  }
  next();
}
/**
 * @returns {any}
 */
function limitStreamQueryToAccessToken (context, params, result, next) {
  if (context.access.isPersonal()) { return next(); }
  if (params.arrayOfStreamQueries == null) {
    params.arrayOfStreamQueries = [{}];
  }
  // stream corresponding to acces.id exemple: "access-{acces.id}"
  const streamId = audit.CONSTANTS.ACCESS_STREAM_ID_PREFIX + context.access.id;
  for (const query of params.arrayOfStreamQueries) {
    if (query.any == null) {
      query.any = [streamId];
    } else {
      if (query.and == null) {
        query.and = [];
      }
      query.and.push({ any: [streamId] });
    }
  }
  next();
}
// From storage
/**
 * @returns {Promise<any>}
 */
async function getAuditLogs (context, params, result, next) {
  try {
    const userDB = await auditStorage.forUser(context.user.id);
    params.streams = params.arrayOfStreamQueries;
    const storeQuery = getStoreQueryFromParams(params);
    const storeOptions = getStoreOptionsFromParams(params);
    const query = localStorePrepareQuery(storeQuery);
    const options = localStorePrepareOptions(storeOptions);
    result.addStream('auditLogs', userDB
      .getEventsStreamed({ query, options })
      .pipe(new ConvertEventFromStoreStream('_audit')));
  } catch (err) {
    return next(err);
  }
  next();
}
