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
// @flow

const errorHandling = require('components/errors').errorHandling;
const errors = require('components/errors').factory;
const string = require('./helpers/string');
const timestamp = require('unix-timestamp');

import type API from '../API';
import type { Logger } from 'components/utils';
import type { StorageLayer } from 'components/storage';
import type { MethodContext } from 'components/model';
import type Result from '../Result';
import type { ApiCallback } from '../API';

/**
 * Call tracking functions, to be registered after all methods have been registered.
 *
 * @param api
 * @param logger
 * @param storageLayer
 */
module.exports = function (
  api: API,
  logger: Logger, 
  storageLayer: StorageLayer
) {

  const userAccessesStorage = storageLayer.accesses;

  api.register('*',
    updateAccessUsageStats);

  function updateAccessUsageStats(context: MethodContext, params: mixed, result: Result, next: ApiCallback) {
    // don't make callers wait on this to get their reply
    next();

    // handle own errors not to mess with "concurrent" code (because of next() above)
    try {
      const access = context.access;
      if (access) {
        const calledMethodKey = string.toMongoKey(context.calledMethodId);
        const prevCallCount = (access.calls && access.calls[calledMethodKey]) ?
          access.calls[calledMethodKey] : 
          0;

        const update = { lastUsed: timestamp.now() };
        update['calls.' + calledMethodKey] = prevCallCount + 1;

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
        url: context.user.username,
        method: 'updateAccessLastUsed',
        body: params
      }, logger);
    }
  }

};
