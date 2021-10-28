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

const commonFns = require('./helpers/commonFunctions');
const errorHandling = require('errors').errorHandling;
const methodsSchema = require('../schema/generalMethods');
const _ = require('lodash');
const bluebird = require('bluebird');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');

const { getLogger, getConfig } = require('@pryv/boiler');

import type API  from '../API';
import type { MethodContext } from 'business';
import type Result  from '../Result';
import type { ApiCallback }  from '../API';

const { Permission } = require('business/src/accesses');

const updateAccessUsageStats = require('./helpers/updateAccessUsageStats');

type ApiCall = {
  method: string,
  params: mixed,
};

/**
 * Utility API methods implementations.
 *
 * @param api
 */
module.exports = async function (api: API) {

  const logger = getLogger('methods:batch');
  const config = await getConfig();

  const isOpenSource = config.get('openSource:isActive');
  const isAuditActive = (! isOpenSource) && config.get('audit:active');

  const updateAccessUsage = await updateAccessUsageStats();

  let audit;
  if (isAuditActive) {
    audit = require('audit');
  }

  api.register('getAccessInfo',
    commonFns.getParamsValidation(methodsSchema.getAccessInfo.params),
    getAccessInfoApiFn);

  function getAccessInfoApiFn(context: MethodContext, params: mixed, result: Result, next: ApiCallback) {
    const accessInfoProps: Array<string> = ['id', 'token', 'type', 'name', 'deviceName', 'permissions',
      'lastUsed', 'expires', 'deleted', 'clientData',
      'created', 'createdBy', 'modified', 'modifiedBy', 'calls'
    ];
    const userProps: Array<string> = ['username'];
    
    for (const prop of accessInfoProps) {
      const accessProp = context.access[prop];
      if (accessProp != null) result[prop] = accessProp;
    }

    if (result.permissions != null) result.permissions = filterNonePermissionsOnSystemStreams(result.permissions);

    result.user = {};
    for (const prop of userProps) {
      const userProp = context.user[prop];
      if (userProp != null) result.user[prop] = userProp;
    }
  
    next();

    /**
     * Remove permissions with level="none" from given array
     */
    function filterNonePermissionsOnSystemStreams(permissions: Array<Permission>): Array<Permission> {
      const filteredPermissions: Array<Permission> = [];
      for (const perm of permissions) {
        if (perm.level !== 'none' && (! SystemStreamsSerializer.isSystemStreamId(perm.streamId))) filteredPermissions.push(perm);
      }
      return filteredPermissions;
    }
  }

  api.register('callBatch',
    commonFns.getParamsValidation(methodsSchema.callBatch.params),
    callBatchApiFn,
    updateAccessUsage);

  async function callBatchApiFn(context: MethodContext, calls: Array<ApiCall>, result: Result, next: ApiCallback) {
    // allow non stringified stream queries in batch calls 
    context.acceptStreamsQueryNonStringified = true;
    context.disableAccessUsageStats = true;

    // to avoid updatingAccess for each api call we are collecting all counter here
    context.accessUsageStats = {};
    function countCall(methodId) {
      if (context.accessUsageStats[methodId] == null) context.accessUsageStats[methodId] = 0;
      context.accessUsageStats[methodId]++;
    }

    result.results = await bluebird.mapSeries(calls, executeCall);
    context.disableAccessUsageStats = false; // to allow tracking functions
    next();

    async function executeCall(call: ApiCall) {
      try {
        countCall(call.method);
        // update methodId to match the call todo
        context.methodId = call.method;
        // Perform API call
        const result: Result = await bluebird.fromCallback(
          (cb) => api.call(context, call.params, cb));
        
        if (isAuditActive) await audit.validApiCall(context, result);

        return await bluebird.fromCallback(
          (cb) => result.toObject(cb));
      } catch(err) {
        // Batchcalls have specific error handling hence the custom request context
        const reqContext = {
          method: call.method + ' (within batch)',
          url: 'pryv://' + context.user.username
        };
        errorHandling.logError(err, reqContext, logger);

        if (isAuditActive) await audit.errorApiCall(context, err);
        
        return {error: errorHandling.getPublicErrorData(err)};
      }
    }
  }

};
