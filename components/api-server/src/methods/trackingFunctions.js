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
