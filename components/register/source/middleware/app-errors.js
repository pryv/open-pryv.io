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
//@flow

var logger = require('winston');
var messages = require('./../utils/messages');

/**
 * Error middleware, may be used for user management
 */
function app_errors(app: express$Application) {

  app.use(function (error, req: express$Request, res, next) { // eslint-disable-line no-unused-vars
   
    if (error instanceof messages.REGError) {
      //logger.debug('app_errors : '+ JSON.stringify(error.data));
      return res.status(error.httpCode).json(error.data);
    }

    // do not log and handle malformed input JSON errors
    if (error instanceof SyntaxError) {
        // custom error format that matches the one used in the core but not in
        // the service-registry
        return res.status(error.status, messages.say('INVALID_JSON_REQUEST')).json(
                {
                    "error": {
                        "id": 'invalid-parameters-format',
                        "message": error.toString()
                    }
                });
    }

    // API error from core - used in Open Pryv.io for /reg routes
    // same as done by components/errors/src/errorHandling.js#getPublicErrorData()
    if (error.id && error.httpStatus) {
      return res.status(error.httpStatus).json({
        error: {
          id: error.id,
          message: error.message,
          data: error.data,
        }
      });
    }

    if (! (error instanceof Error)) {
      logger.error('app_errors unknown object : ' + error);
      logger.error((new Error()).stack);
    } else {
      logger.error('app_errors : ' + error.toString());
      logger.error(error.stack);
    }
    const err = new messages.REGError(500, messages.say('INTERNAL_ERROR'));
    res.status(err.httpCode).json(err.data);
  });
}

module.exports = app_errors;

