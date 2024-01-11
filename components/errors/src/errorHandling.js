/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
