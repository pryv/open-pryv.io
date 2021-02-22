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

const { getLogger } = require('@pryv/boiler');

import type API  from '../API';
import type { StorageLayer } from 'storage';
import type { MethodContext } from 'model';
import type Result  from '../Result';
import type { ApiCallback }  from '../API';

type ApiCall = {
  method: string,
  params: mixed,
};

/**
 * Utility API methods implementations.
 *
 * @param api
 */
module.exports = function (api: API, logging, storageLayer: StorageLayer) {

  const logger = getLogger('methods:batch');

  api.register('getAccessInfo',
    commonFns.getParamsValidation(methodsSchema.getAccessInfo.params),
    getAccessInfo);

  function getAccessInfo(context: MethodContext, params: mixed, result: Result, next: ApiCallback) {
    const accessInfoProps = ['id', 'token', 'type', 'name', 'deviceName', 'permissions',
      'lastUsed', 'expires', 'deleted', 'clientData',
      'created', 'createdBy', 'modified', 'modifiedBy', 'calls'
    ];
    const userProps = ['username'];
    
    for (const prop of accessInfoProps) {
      const accessProp = context.access[prop];
      if (accessProp != null) result[prop] = accessProp;
    }

    result.user = {};
    for (const prop of userProps) {
      const userProp = context.user[prop];
      if (userProp != null) result.user[prop] = userProp;
    }
  
    next();
  }

  api.register('callBatch',
    commonFns.getParamsValidation(methodsSchema.callBatch.params),
    callBatch);

  async function callBatch(context: MethodContext, calls: Array<ApiCall>, result: Result, next: ApiCallback) {

    let needRefeshForNextcall = true;
    let freshContext: MethodContext = null;
    
    result.results = await bluebird.mapSeries(calls, executeCall);
    next();


    // Reload streams tree since a previous call in this batch
    // may have modified stream structure.
    async function refreshContext() {
      // Clone context to avoid potential side effects
      freshContext = _.cloneDeep(context);
      // Accept streamQueries in JSON format for batchCalls
      freshContext.acceptStreamsQueryNonStringified = true;
      const access = freshContext.access;
      await freshContext.retrieveStreams(storageLayer);
      if (! access.isPersonal()) access.loadPermissions(freshContext.streams);
    }

    async function executeCall(call: ApiCall) {
      try {
        if (needRefeshForNextcall) {
          await refreshContext();
        }

        needRefeshForNextcall = ['streams.create', 'streams.update', 'streams.delete'].includes(call.method);

        // Perform API call
        const result: Result = await bluebird.fromCallback(
          (cb) => api.call(call.method, freshContext, call.params, cb));
        
        return await bluebird.fromCallback(
          (cb) => result.toObject(cb));
      } catch(err) {
        // Batchcalls have specific error handling hence the custom request context
        const reqContext = {
          method: call.method + ' (within batch)',
          url: 'pryv://' + context.username
        };
        errorHandling.logError(err, reqContext, logger);
        
        return {error: errorHandling.getPublicErrorData(err)};
      }
    }
  }

};
