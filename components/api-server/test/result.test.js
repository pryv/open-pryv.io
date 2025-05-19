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

require('./test-helpers');
const Result = require('../src/Result');
const Transform = require('stream').Transform;
const inherits = require('util').inherits;
const should = require('should');
const Source = require('./helpers').SourceStream;

describe('Result', function () {
  describe('concatStream', function () {
    it('[36RQ] must concatenate multiple streams in a single Array', function (done) {
      const res = new Result();
      const a1 = ['a', 'b', 'c'];
      const a2 = ['d', 'e', 'f'];
      const s1 = new Source(a1);
      const s2 = new Source(a2);

      function expectation (err, content) {
        should.not.exist(err);
        content.should.eql({ events: a1.concat(a2) });
        done();
      }
      res.addToConcatArrayStream('events', s1);
      res.addToConcatArrayStream('events', s2);
      res.closeConcatArrayStream('events');
      res.toObject(expectation);
    });
  });

  describe('toObject()', function () {
    it('[NKHF] must return the result\'s content when not storing streams', function (done) {
      const res = new Result();
      res.a = 'a';

      function expectation (err, content) {
        should.not.exist(err);
        content.a.should.eql('a');
        done();
      }

      res.toObject(expectation);
    });

    it('[MHAS] must return the result content when storing streams', function (done) {
      const res = new Result();
      const arrayName1 = 'items';
      const array1 = [{ a: 'a' }, { b: 'b' }, { c: 'c' }];
      const s1 = new Source(array1);
      const arrayName2 = 'items2';
      const array2 = [{ d: 'd' }, { e: 'e' }, { f: 'f' }];
      const s2 = new Source(array2);

      function expectation (err, content) {
        should.not.exist(err);
        (content[arrayName1]).should.eql(array1);
        (content[arrayName2]).should.eql(array2);
        done();
      }

      res.addStream(arrayName1, s1);
      res.addStream(arrayName2, s2);
      res.toObject(expectation);
    });

    it('[6P4Z] must return an error object when attempting to serialize streams containing an amount' +
      'of objects exceeding the limit', function (done) {
      const res = new Result({ arrayLimit: 2 });
      const arrayName1 = 'items';
      const array1 = [{ a: 'a' }, { b: 'b' }, { c: 'c' }];
      const s1 = new Source(array1);
      const arrayName2 = 'items2';
      const array2 = [{ d: 'd' }, { e: 'e' }, { f: 'f' }];
      const s2 = new Source(array2);

      function expectation (err, content) {
        should.exist(err);
        should.not.exist(content);
        done();
      }

      res.addStream(arrayName1, s1);
      res.addStream(arrayName2, s2);
      res.toObject(expectation);
    });

    it('[TTEL] must return an error when storing piped streams', function (done) {
      const res = new Result({ arrayLimit: 2 });
      const arrayName1 = 'items';
      const array1 = [{ a: 'a' }, { b: 'b' }, { c: 'c' }];
      const s1 = new Source(array1);
      const p1 = s1.pipe(new SimpleTransformStream());

      function expectation (err, content) {
        should.exist(err);
        should.not.exist(content);
        done();
      }

      res.addStream(arrayName1, p1);
      res.toObject(expectation);
    });

    it.skip('[H2GC] must return an error when the core pipeline crashes because of size', function () {
    });
  });
});

/**
 * Stream simply forwards what he receives. Used for pipe case.
 */
function SimpleTransformStream () {
  Transform.call(this, { objectMode: true });
}

inherits(SimpleTransformStream, Transform);

SimpleTransformStream.prototype._transform = function (item, encoding, callback) {
  this.push(item);
  callback();
};

SimpleTransformStream.prototype._flush = function (callback) {
  callback();
};
