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

const errorHandling = require('errors').errorHandling;
const errors = require('errors').factory;
const string = require('./string');
const timestamp = require('unix-timestamp');
const { getLogger, getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');

import type { StorageLayer } from 'storage';
import type { MethodContext } from 'business';
import type Result  from '../../Result';

import type { ApiCallback }  from '../../API';

let singleton = null;

module.exports = async function getUpdateAccessUsageStats() {
  if (singleton != null) return singleton;

  const logger = getLogger('methods:trackingFunctions');
  const storageLayer = await getStorageLayer();
  const config = await getConfig();
  const userAccessesStorage = storageLayer.accesses;

  const isActive = config.get('accessTracking:isActive') ? true : false;

  singleton = updateAccessUsageStats;
  return singleton;

  function updateAccessUsageStats(context: MethodContext, params: mixed, result: Result, next: ApiCallback) {
    // don't make callers wait on this to get their reply
    next();
    if (! isActive || context.disableAccessUsageStats) return; //callBatch will flush all stats at the end

    // handle own errors not to mess with "concurrent" code (because of next() above)
    try {
      const access = context?.access;
      if (access) {
        const update = { lastUsed: timestamp.now() , $inc: {}};

        if (context.accessUsageStats == null) { // standard call
          const calledMethodKey = string.toMongoKey(context.methodId);
          update.$inc['calls.' + calledMethodKey] = 1;
        } else { // from batch calll 
          for (const methodId of Object.keys(context.accessUsageStats)) {
            const calledMethodKey = string.toMongoKey(methodId);
            update.$inc['calls.' + calledMethodKey] = context.accessUsageStats[methodId];
          }
        }

        userAccessesStorage.updateOne(context.user, {id: context.access.id}, update, function (err) {
          if (err) {
            errorHandling.logError(errors.unexpectedError(err), {
              url: context.user.username,
              method: 'updateAccessLastUsed',
              body: params
            }, logger);
          }
        });
      }
    } catch (err) {
      errorHandling.logError(errors.unexpectedError(err), {
        url: context?.user?.username,
        method: 'updateAccessLastUsed',
        body: params
      }, logger);
    }
  }

}