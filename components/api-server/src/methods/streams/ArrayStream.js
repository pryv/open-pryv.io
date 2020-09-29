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
const Transform = require('stream').Transform;
const inherits = require('util').inherits;

module.exports = ArrayStream;

const SERIALIZATION_STACK_SIZE = 1000;

/**
 * Stream that encapsulates the items it receives in a stringified array.
 *
 * @param result    {Object} Result object for the API request
 * @param arrayName {String} array name that will prefix the array
 * @constructor
 */
function ArrayStream(arrayName, isFirst) {
  Transform.call(this, {objectMode: true});
  this.isStart = true;
  this.prefix = formatPrefix(arrayName, isFirst);
  this.size = SERIALIZATION_STACK_SIZE;
  this.stack = [];
}

inherits(ArrayStream, Transform);

ArrayStream.prototype._transform = function (item, encoding, callback) {
  this.stack.push(item);

  if (this.stack.length >= this.size) {
    if (this.isStart) {
      this.isStart = false;
      this.push((this.prefix + JSON.stringify(this.stack)).slice(0,-1));
    } else {
      this.push(',' + (JSON.stringify(this.stack)).slice(1,-1));
    }
    this.stack = [];
  }
  callback();
};

ArrayStream.prototype._flush = function (callback) {
  if (this.isStart) {
    this.push(this.prefix + JSON.stringify(this.stack));
  } else {
    const joiningComma = this.stack.length > 0 ? ',' : '';
    this.push(joiningComma + (JSON.stringify(this.stack)).slice(1));
  }
  callback();
};


/**
 * Formats the prefix in the right way depending on whether it is the first data
 * pushed on the result stream or not.
 *
 * @param prefix
 * @param isFirst
 * @returns {string}
 */
function formatPrefix (prefix, isFirst) {
  if (isFirst) {
    return '"' + prefix + '":';
  }
  return ',"' + prefix + '":';
}