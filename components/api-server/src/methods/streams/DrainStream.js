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
var Writable = require('stream').Writable,
    inherits = require('util').inherits,
    errors = require('errors').factory;

module.exports = DrainStream;

/**
 * Writable stream used to drain items fed to it into an array and returns the said
 * array in the callback or an error if the limit of items is exceeded.
 *
 * @param params {Object}
 *        params.limit {Number} limit of objects to return, default is 100'000 (defined in API.js)
 * @param callback {Function} called when all items have been drained in the internal array
 *                            or the limit was reached, generating an error
 * @constructor
 */
function DrainStream(params, callback) {
  Writable.call(this, { objectMode: true });

  this.limit = 100000;

  if (params && (params.limit > 0)) {
    this.limit = params.limit;
  }

  this.array = [];
  this.size = 0;

  if (callback) {
    this.on('finish', function () {
      callback(null, this.array);
    });
  }

  this.on('error', callback);
}

inherits(DrainStream, Writable);

DrainStream.prototype._write = function(object, enc, next) {
  this.size++;

  if (this.size > this.limit) {
    return next(errors.tooManyResults(this.limit));
  }
  this.array.push(object);
  next();
};
