/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const errorHandling = require('errors').errorHandling;
const APIError = require('errors').APIError;
const errors = require('errors').factory;
const { getLogger } = require('@pryv/boiler');

/**
 * Error route handling.
 * TODO: (re)move that once something's been done about api-server's own errors middleware
 */
module.exports = function (logging) {
  const logger = getLogger('routes');

  return function handleError (error, req, res, next) {
    if (!(error instanceof APIError)) {
      error = errors.unexpectedError(error);
    }

    errorHandling.logError(error, req, logger);
    res
      .status(error.httpStatus || 500)
      .json({
        error: errorHandling.getPublicErrorData(error)
      });
  };
};
