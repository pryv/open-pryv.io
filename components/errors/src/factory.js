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

const APIError = require('./APIError');
const ErrorIds = require('./ErrorIds');
const ErrorMessages = require('./ErrorMessages');
const _ = require('lodash');

import type { APIErrorOptions } from './APIError';

/**
 * Helper "factory" methods for API errors (see error ids).
 */
const factory = module.exports = {};

factory.apiUnavailable = (message: string) => {
  return new APIError(ErrorIds.ApiUnavailable, message, {
    httpStatus: 503
  });
};

factory.corruptedData = function (message: string, innerError: Error) {
  return new APIError(ErrorIds.CorruptedData, message, {
    httpStatus: 422,
    innerError: innerError
  });
};

factory.forbidden = function (message?: string): Error {
  if (message == null) {
    message = 'The given token\'s access permissions do not allow this operation.';
  }
  return new APIError(ErrorIds.Forbidden, message, {
    httpStatus: 403,
    dontNotifyAirbrake: true
  });
};

factory.invalidAccessToken = function (message: string, status: ?number) {
  return new APIError(ErrorIds.InvalidAccessToken, message, {
    httpStatus: status || 401,
    dontNotifyAirbrake: true
  });
};

factory.invalidCredentials = function (message?: string) {
  return new APIError(ErrorIds.InvalidCredentials,
    message || 'The given username/password pair is invalid.', {
      httpStatus: 401,
      dontNotifyAirbrake: true
    });
};

factory.invalidEventType = function (type: string) {
  return new APIError(
    ErrorIds.InvalidEventType, 
    'Event type \'' + type + '\' not allowed ' +
      'for High-Frequency Series. Please use a predefined simple type',
    {type: type, httpStatus: 400});
};

factory.invalidItemId = function (message?: string) {
  return new APIError(ErrorIds.InvalidItemId, message || '', {
    httpStatus: 400,
    dontNotifyAirbrake: true
  });
};

factory.invalidMethod = function (methodId: string): APIError {
  return new APIError(
    ErrorIds.InvalidMethod, 
    'Invalid method id "' + methodId + '"',
    {httpStatus: 404}
  );
};

factory.invalidOperation = function (message: string, data?: Object, innerError?: Error): APIError {
  return new APIError(ErrorIds.InvalidOperation, message, {
    httpStatus: 400,
    data: data,
    innerError: innerError,
    dontNotifyAirbrake: true
  });
};

factory.invalidParametersFormat = function (message: string, data?: Object, innerError?: Error) {
  return new APIError(ErrorIds.InvalidParametersFormat, message, {
    httpStatus: 400,
    data: data,
    innerError: innerError,
    dontNotifyAirbrake: true
  });
};

factory.invalidRequestStructure = function (message: string, data?: Object, innerError?: Error): APIError {
  return new APIError(ErrorIds.InvalidRequestStructure, message, {
    httpStatus: 400,
    data: data,
    innerError: innerError,
    dontNotifyAirbrake: true
  });
};

factory.itemAlreadyExists = function (
  resourceType: ?string, conflictingKeys: { [string]: string }, innerError: ?Error
) {
  resourceType = resourceType || 'resource';
  var keysDescription = Object.keys(conflictingKeys).map(function (k) {
    return k + ' "' + conflictingKeys[k] + '"';
  }).join(', ');
  var message = functionGetRightArticle(resourceType) + resourceType + ' with ' + keysDescription +
    ' already exists';

  return new APIError(ErrorIds.ItemAlreadyExists, message, {
    httpStatus: 409,
    innerError: innerError || null,
    data: conflictingKeys,
    dontNotifyAirbrake: true
  });
};

factory.missingHeader = function (headerName: string, status: ?number): APIError {
  return new APIError(
    ErrorIds.MissingHeader, 
    'Missing expected header "' + headerName + '"', {
      httpStatus: status || 400,
      dontNotifyAirbrake: true
    }
  );
};

/**
 * Strange, but seems to be used only in tests
 * @param {*} message 
 * @param {*} data 
 * @param {*} innerError 
 */
factory.periodsOverlap = function (message: string, data: Object, innerError: Error) {
  return new APIError(ErrorIds.PeriodsOverlap, message, {
    httpStatus: 400,
    data: data,
    innerError: innerError,
    dontNotifyAirbrake: true
  });
};

factory.tooManyResults = function (limit: number) {
  return new APIError(
    ErrorIds.TooManyResults,
    'Your request gave too many results (the limit is ' + limit + '. Directly calling ' +
    'the API method (i.e. not batching calls), narrowing request scope or paging can help.',
    {limit: limit, httpStatus: 413});
};

factory.unexpectedError = function (sourceError: mixed, message?: string) {
  // If a message was given: display it. 
  if (message != null)
    return produceError(message);

  // Sometimes people throw strings
  if (typeof sourceError === 'string') 
    return produceError(sourceError);
    
  // Maybe this looks like an Error?
  const error = sourceError;
  if (error != null && error instanceof Error && error.message != null) {
    // NOTE Could not get this path covered with type information. It looks sound...
    return produceError(error.message, error);
  }

  // Give up: 
  return produceError('(no message given)');
  
  function produceError(msg: string, error?: Error): APIError {
    const opts: APIErrorOptions = {
      httpStatus: 500,
      innerError: error,
    };
    
    const text = `${ErrorMessages[ErrorIds.UnexpectedError]}: ${msg}`;

    return new APIError(ErrorIds.UnexpectedError, text, opts);  
  }
};

factory.unknownReferencedResource = function (
  resourceType: ?string, paramKey: string, 
  value: Array<string> | string, innerError: Error
) {
  const joinedVals = typeof value === 'string' ?
    value :
    value.join('", "');
  const resourceTypeText = resourceType || 'resource(s)';
  
  const message = `Unknown referenced ${resourceTypeText} "${joinedVals}"`;

  const data = {};
  data[paramKey] = value;

  return new APIError(ErrorIds.UnknownReferencedResource, message, {
    httpStatus: 400,
    data: data,
    innerError: innerError,
    dontNotifyAirbrake: true
  });
};

factory.unknownResource = function (resourceType: ?string, id: ?string, innerError?: Error): APIError {
  var message = 'Unknown ' + (resourceType || 'resource') + ' ' + (id ? '"' + id + '"' : '');
  return new APIError(ErrorIds.UnknownResource, message, {
    httpStatus: 404,
    innerError: innerError,
    dontNotifyAirbrake: true
  });
};

factory.unsupportedContentType = function (contentType: string) {
  return new APIError(
    ErrorIds.UnsupportedContentType, 
    `If you think we should, please help us and report an issue! (You used ${contentType})`,
    { httpStatus: 415 });
};

factory.goneResource = function (): APIError {
  return new APIError(
    ErrorIds.Gone, 'API method gone, please stop using it.',
    {
      httpStatus: 410,
      dontNotifyAirbrake: true,
    }
  );
};

factory.unavailableMethod = function (message: ?string): APIError {
  return new APIError(
    ErrorIds.unavailableMethod, 'API method unavailable in current version. This method is only available in the commercial license.',
    {
      httpStatus: 451,
      dontNotifyAirbrake: true,
    }
  );
};

/**
 * Check in service-register if email is used
 * The name is used in the service-core and service-register
 **/
factory.InvalidInvitationToken = (): APIError => {
  const opts: APIErrorOptions = {
    httpStatus: 400,
    data: {param: 'invitationToken'},
  };
  return new APIError(ErrorIds.InvalidInvitationToken,  ErrorMessages[ErrorIds.InvalidInvitationToken], opts);
};

/**
 * Get the right article for the noun
 * @param {*} noun 
 */
function functionGetRightArticle(noun){
  return _.includes(['a', 'e', 'i', 'o', 'u'], noun[0].toLowerCase()) ? 'An ' : 'A ';
}