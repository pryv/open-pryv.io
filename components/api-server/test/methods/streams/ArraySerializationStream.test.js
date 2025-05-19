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

'use strict';

const ArraySerializationStream = require('../../../src/methods/streams/ArraySerializationStream');
const Writable = require('stream').Writable;
const inherits = require('util').inherits;
const should = require('should');
const Source = require('../../helpers').SourceStream;

describe('ArraySerializationStream', function () {
  const arraySize = new ArraySerializationStream('getSize', true).size;

  describe('testing around the array size limit', function () {
    const testIDs = ['U21Z', 'MKNL', 'MUPF', 'CM4Q', 'F8S9', '6T4V', 'QBOS', 'BY67', 'JNVS', 'N9HG'];

    for (let i = -3; i <= 3; i++) {
      const sign = i < 0 ? '' : '+';
      it(`[${testIDs[i + 3]}] must return a valid array when receiving limit` + sign + i + ' items',
        function (done) {
          const n = arraySize + i;
          n.should.be.above(0);
          pipeAndCheck(n, true, null, done);
        }
      );
    }
  });

  describe('testing with small number of items', function () {
    const testIDs = ['69F6', 'BJRT', 'YJI0', 'EKQQ', '5SUK', 'FPL8', 'ZMO9', 'WFSL', '1YQS', '25IQ'];

    for (let i = 0; i <= 3; i++) {
      it(`[${testIDs[i]}] must return a valid array when receiving ` + i + ' item(s)',
        function (done) {
          pipeAndCheck(i, true, null, done);
        }
      );
    }
  });

  function pipeAndCheck (itemNumber, isFirst, resultMapping, done) {
    const name = 'name';

    const items = [];
    for (let i = 0; i < itemNumber; i++) {
      items.push({
        a: 'a',
        n: i
      });
    }

    new Source(items)
      .pipe(new ArraySerializationStream(name, isFirst))
      .pipe(new DestinationStream(isFirst, (err, res) => {
        should.not.exist(err);
        should.exist(res);
        if (typeof (resultMapping) === 'function') {
          res = resultMapping(res);
        }
        res = JSON.parse(res);
        should.exist(res[name]);
        res[name].should.eql(items);
        done();
      }));
  }
});

/**
 * Writable stream that concatenates the strings it receives in a buffer.
 * When finished, it flushes its buffer in a JS object '{}' or as is depending
 * on the asObject parameter
 *
 * @param asObject  if true, flushes the buffer in a JS object,
 *                  otherwise, flushes it as is.
 * @param callback
 * @constructor
 */
function DestinationStream (asObject, callback) {
  Writable.call(this);

  this.result = '';
  this.asObject = asObject;

  if (callback) {
    this.on('finish', function () {
      if (this.asObject) {
        callback(null, '{' + this.result + '"meta":{}}');
      } else {
        callback(null, this.result);
      }
    });
  }

  this.on('error', callback);
}

inherits(DestinationStream, Writable);

DestinationStream.prototype._write = function (object, enc, next) {
  this.result += (object);
  next();
};
