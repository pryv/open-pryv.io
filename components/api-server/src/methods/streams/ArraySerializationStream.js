/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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
const Transform = require('stream').Transform;

// serialize every n objects
const OBJECT_BUFFER_SIZE = 100;
// event if OBJECT_BUFFER_SIZE is not reach, serialize if MAX_WAIT_MS is reached
const MAX_WAIT_MS = 100;

/**
 * Stream that encapsulates the items it receives in a stringified array.
 *
 * @param arrayName {String} array name that will prefix the array
 * @constructor
 */
module.exports = class ArraySerializationStream extends Transform {
  constructor (arrayName) {
    super({ writableObjectMode: true });
    this.isStart = true;
    this.prefix = '"' + arrayName + '":';
    this.size = OBJECT_BUFFER_SIZE;
    this.stack = [];
    this.lastSerialization = Date.now();
  }

  _transform (item, encoding, callback) {
    this.stack.push(item);

    if (this.stack.length >= this.size || (Date.now() - this.lastSerialization) > MAX_WAIT_MS) {
      if (this.isStart) {
        this.isStart = false;
        this.push((this.prefix + JSON.stringify(this.stack)).slice(0, -1));
      } else {
        this.push(',' + (JSON.stringify(this.stack)).slice(1, -1));
      }
      this.lastSerialization = Date.now();
      this.stack = [];
    }
    callback();
  }

  _flush = function (callback) {
    if (this.isStart) {
      this.push(this.prefix + JSON.stringify(this.stack));
    } else {
      const joiningComma = this.stack.length > 0 ? ',' : '';
      this.push(joiningComma + (JSON.stringify(this.stack)).slice(1));
    }
    this.push(',');
    callback();
  };
};
