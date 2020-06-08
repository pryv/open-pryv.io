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

/**
 * Provides tools to construct messages for clients.
 */

const logger = require('winston'),
      mstrings = require('../public/messages-en');

// Add ids to all messages
Object.keys(mstrings).forEach(function (key) {
  mstrings[key].id = key;
});

/**
 * Add also the id into the message
 */
function cloneMessage(id) {
  var t = mstrings[id];
  if (t == null) {
    throw (new Error('Missing message code :' + id));
  }
  return {
    id: t.id, 
    message: t.message, 
    detail: t.detail, 
    errors: [],           // One error may have several children (causes)
  };
}

/**
 * Construct a message to display according to message id
 * @param id: string key of the message (public/messages-<lang code>.js)
 * @param addons : optional key/value json object to be dumped with the message
 * @return {*}: the generated message
 */
function say(id: string, addons: ?Object) {
  var content = cloneMessage(id);
  // merge addons
  if (addons != null) {
    for (const i in addons) {
      if (addons.hasOwnProperty(i)) { 
        content[i] = addons[i]; }
    }
  }
  return content;
}
exports.say = say;

/**
// Create a JSON ready error for this code
function error_data(id, extra) {
  var content = mstrings['en'][id];
  if (content == undefined) {
      throw(new Error('Missing message code :' + id));
  }
  content.id = id;
  content.more = extra;
  return content;
}
 **/

/**
 * Sugar for internal error
 * @param error: object representing the error
 * @returns: the error to be thrown
 */
exports.ei = function (error: mixed) {
  if (! error) {
    error = new Error();
  }
  if (! (error instanceof Error)) {
    error = new Error(error);
  }
  logger.error('internal error : ' + error.message + '\n' +  error.stack);
  return new REGError(500, say('INTERNAL_ERROR'));
};

/**
 * Sugar for single error
 * @param httpCode: http code for this error
 * @param id: id of the error message
 * @param addons: optional key/value json object to be dumped with the message
 * @returns: the error to be thrown
 */
exports.e = function (httpCode: number, id: string, addons: ?Object): Error {
  return new REGError(httpCode, say(id, addons));
};

/**
 * Sugar for error with sub errors
 * @param httpCode: http code for this error
 * @param id: id of the error message
 * @param suberrors: array of suberrors
 * @returns: the error to be thrown
 */
exports.ex = function (httpCode: number, id: string, suberrors: Array<string>) {
  var data = cloneMessage(id);
  data.errors = [];
  for (var i = 0; i < suberrors.length ; i++) {
    data.errors[i] = say(suberrors[i]);
  }
  return new REGError(httpCode, data);
};

/// Error class for all register errors. 
/// 
class REGError extends Error {
  httpCode: *; 
  data: *; 

  constructor(httpCode: number, data: Object) {
    super(); 
    this.httpCode = httpCode;
    this.data = data;
  }
}
exports.REGError = REGError;