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
const APIError = require('components/errors/src/APIError');

var errors = require('components/errors').factory,
    validation = require('../../schema/validation');

exports.requirePersonalAccess = function requirePersonalAccess(context, params, result, next) {
  if (! context.access.isPersonal()) {
    return next(errors.forbidden('You cannot access this resource using the given access ' +
        'token.'));
  }
  next();
};

/**
 * Returns a check whether the given app ID / origin pair match a trusted app defined in settings.
 * (Lazy-loads and caches the `trustedApps` setting.)
 * The returned function expects the call's `params` to have `appId` and `origin` properties.
 *
 * @param {Object} authSettings
 * @return {Function}
 */
exports.getTrustedAppCheck = function getTrustedAppCheck(authSettings) {
  var trustedApps;
  return function requireTrustedApp(context, params, result, next) {
    if (! isTrustedApp(params.appId, params.origin)) {
      return next(errors.invalidCredentials('The app id ("appId") is either missing or ' +
          'not trusted.'));
    }
    next();
  };

  function isTrustedApp(appId, origin) {
    if (! trustedApps) {
      trustedApps = [];
      authSettings.trustedApps.split(',').forEach(function (pair) {
        var parts = /^\s*(\S+)\s*@\s*(\S+)\s*$/.exec(pair);
        if (parts.length !== 3) { return; }
        trustedApps.push({
          appId: parts[1], // index 0 is the original string
          originRegExp: getRegExp(parts[2])
        });
      });
    }

    if (! appId) { return false; }

    var trustedApp;
    for (var i = 0, n = trustedApps.length; i < n; i++) {
      trustedApp = trustedApps[i];
      // accept wildcards for app ids (for use in tests/dev/staging only)
      if (trustedApp.appId !== appId && trustedApp.appId !== '*') {
        continue;
      }
      if (trustedApp.originRegExp.test(origin)) {
        return true;
      }
    }

    return false;
  }

  function getRegExp(origin) {
    // BUG The blacklist approach taken here is probably wrong; we're assuming
    //  that we can escape all the active parts of a string using a list of 
    //  special chars; we're almost sure to miss something while doing that. A
    //  better approach would be to whitelist all characters that are allowed 
    //  in the input language. 
    
    // first escape the origin string
    var rxString = origin.replace(/([.*+?^=!:${}()|[\]\/\\])/g, '\\$1');
    // then replace wildcards
    rxString = rxString.replace(/\\\*/g, '\\S*');
    return new RegExp('^' + rxString + '$');
  }
};


/** Produces a middleware function to verify parameters against the schema
 * given in `paramsSchema`.
 *  
 * @param  {Object} paramsSchema JSON Schema for the parameters
 * @return {void}
 */ 
exports.getParamsValidation = function getParamsValidation (paramsSchema) {
  return function validateParams (context, params, result, next) {
    validation.validate(params, paramsSchema, function (err) {
      if (err) {
        const errorsList = err.map(error => _addCustomMessage(error, paramsSchema));
        return next(errors.invalidParametersFormat(
          "The parameters' format is invalid.", errorsList
        ));
      }
      next();
    });
  };
};

/**
 * Replaces z-schema message and code with a custom message given in the schema
 * !!! Important - it also removes error params and schemaId and
 * adds "param" that is equal to failing param id
 * 
 * Before this function validation errors could look like this:
 * "error": {
        "id": "invalid-parameters-format",
        "message": "The parameters' format is invalid.",
        "data": [
            {
                "code": "PATTERN",
                "params": [
                    "^[a-z0-9][a-z0-9\\-]{3,21}[a-z0-9]$",
                    "ga"
                ],
                "message": "String does not match pattern ^[a-z0-9][a-z0-9\\-]{3,21}[a-z0-9]$: ga",
                "path": "#/username"
            }
        ]
    },
    
    And if custom error messages are provided, it could be changed to something like this:
 * 
 * "error": {
        "id": "invalid-parameters-format",
        "message": "The parameters' format is invalid.",
        "data": [
            {
                "code": "username-invalid",
                "message": "Username should have from 5 to 23 characters and contain letters or numbers or dashes",
                "path": "#/username",
                "param": "username"
            }
        ]
    },
 * 
 * @param object error 
 * @param object schema 
 */
function _addCustomMessage(error, schema){
  const pathElements = error.path.split("/");
  let paramId = pathElements[pathElements.length -1];

  // when field is missing paramId will be empty
  if(paramId === '' && error.params.length >= 1){
    paramId = error.params[0]
  }

  // if there are custom messages set, replace default z-schema message
  if (schema?.messages?.[paramId] != null) {
    // if there is a message, set it
    if(schema.messages[paramId][error.code]?.message){
      error.message = schema.messages[paramId][error.code].message;
    }
    // if there is a custom error code, set it
    if(schema.messages[paramId][error.code]?.code){
      error.code = schema.messages[paramId][error.code].code;
    }

    // delete missleading error parameters
    if ('params' in error){
      delete error.params;
    }

    // delete schemaId
    if ('schemaId' in error){
      delete error.schemaId;
    }

    // make frontenders happier and instead of having 'path' with
    // modified param name, pass not modified param too
    error.param = paramId;
  }
  // if there are no custom messages, just return default z-schema message
  return error;  
}

exports.catchForbiddenUpdate = function catchForbiddenUpdate(paramsSchema, ignoreProtectedFieldUpdates, logger) {
  return function validateParams (context, params, result, next) {
    const allowed = paramsSchema.alterableProperties;

    const forbidden = Object.keys(params.update)
      .filter(key => !allowed.includes(key));
    if(forbidden.length > 0) {
      const errorMsg = 'Forbidden update was attempted on the following protected field(s): [' + forbidden + '].';
      // Strict mode: throw a forbidden error
      if(!ignoreProtectedFieldUpdates) {
        return next(errors.forbidden(errorMsg));
      }
      // Non-strict mode:
      // Ignore protected fields in update
      forbidden.forEach((key) => {
        delete params.update[key];
      });
      // Log a warning
      logger.warn(errorMsg + '\n' +
        'Server has "ignoreProtectedFieldUpdates" turned on: Fields are not updated, but no error is thrown.');
    }
    next();
  };
};