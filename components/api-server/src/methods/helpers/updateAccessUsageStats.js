/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const errorHandling = require('errors').errorHandling;
const errors = require('errors').factory;
const string = require('./string');
const timestamp = require('unix-timestamp');
const { getLogger, getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
let singleton = null;
module.exports = async function getUpdateAccessUsageStats () {
  if (singleton != null) { return singleton; }
  const logger = getLogger('methods:trackingFunctions');
  const storageLayer = await getStorageLayer();
  const config = await getConfig();
  const userAccessesStorage = storageLayer.accesses;
  const isActive = !!config.get('accessTracking:isActive');
  singleton = updateAccessUsageStats;
  return singleton;
  function updateAccessUsageStats (context, params, result, next) {
    // don't make callers wait on this to get their reply
    next();
    if (!isActive || context.disableAccessUsageStats) { return; } // callBatch will flush all stats at the end
    // handle own errors not to mess with "concurrent" code (because of next() above)
    try {
      const access = context?.access;
      if (access) {
        const update = { lastUsed: timestamp.now(), $inc: {} };
        if (context.accessUsageStats == null) {
          // standard call
          const calledMethodKey = string.sanitizeFieldKey(context.methodId);
          update.$inc['calls.' + calledMethodKey] = 1;
        } else {
          // from batch calll
          for (const methodId of Object.keys(context.accessUsageStats)) {
            const calledMethodKey = string.sanitizeFieldKey(methodId);
            update.$inc['calls.' + calledMethodKey] =
                            context.accessUsageStats[methodId];
          }
        }
        userAccessesStorage.updateOne(context.user, { id: context.access.id }, update, function (err) {
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
};
