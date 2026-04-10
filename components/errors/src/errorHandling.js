/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Helper functions for error handling.
 */
const APIError = require('./APIError');
const ErrorIds = require('./ErrorIds');
const errorHandling = (module.exports = {});
/**
 * Logs the given error.
 *
 * @param {Error} error The error object (can be an API error or not)
 * @param {Object} req The request context; expected properties: url, method, body
 * @param {Object} logger The logger object (expected methods: debug, info, warn, error)
 */
errorHandling.logError = function (error, req, logger) {
  // console.log('XXXXXX', error); // uncomment to log 500 errors on test running using InstanceManager
  const metadata = {};
  if (req) {
    metadata.context = {
      location: req.url,
      method: req.method,
      data: req.body
    };
  }
  if (error instanceof APIError) {
    const logMsg = error.id +
            ' error (' +
            (error.httpStatus || 'n/a') +
            '): ' +
            error.message;
    if (error.data) {
      metadata.errorData = error.data;
    }
    if (error.innerError) {
      metadata.innerError =
                error.id === ErrorIds.UnexpectedError
                  ? error.innerError.stack || error.innerError.message
                  : error.innerError.message;
    }
    if (error.id === ErrorIds.UnexpectedError) {
      logger.error(logMsg, metadata);
    } else {
      logger.info(logMsg, metadata);
    }
  } else {
    // Assumes that error is in fact instanceof Error...
    logger.error('Unhandled API error (' +
            error.name +
            '): ' +
            error.message +
            '\n' +
            error.stack, metadata);
  }
};
/**
 * Returns a public-safe error object from the given API error.
 */
errorHandling.getPublicErrorData = function (error) {
  if (error instanceof APIError) {
    const publicError = {
      id: error.id,
      message: error.message,
      data: undefined
    };
    if (error.data) {
      publicError.data = error.data;
    }
    return publicError;
  } else {
    return {
      id: ErrorIds.UnexpectedError,
      message: 'An unexpected error occurred. Our bad! Please accept our humble apologies and ' +
                'notify us if it happens repeatedly. Thank you.'
    };
  }
};
