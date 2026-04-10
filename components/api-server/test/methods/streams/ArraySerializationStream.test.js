/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

'use strict';

require('test-helpers/src/api-server-tests-config');
const ArraySerializationStream = require('../../../src/methods/streams/ArraySerializationStream');
const Writable = require('stream').Writable;
const inherits = require('util').inherits;
const assert = require('node:assert');
const Source = require('../../helpers').SourceStream;

describe('[ARSR] ArraySerializationStream', function () {
  const arraySize = new ArraySerializationStream('getSize', true).size;

  describe('[AR01] testing around the array size limit', function () {
    const testIDs = ['U21Z', 'MKNL', 'MUPF', 'CM4Q', 'F8S9', '6T4V', 'QBOS', 'BY67', 'JNVS', 'N9HG'];

    for (let i = -3; i <= 3; i++) {
      const sign = i < 0 ? '' : '+';
      it(`[${testIDs[i + 3]}] must return a valid array when receiving limit` + sign + i + ' items',
        function (done) {
          const n = arraySize + i;
          assert.ok(n > 0);
          pipeAndCheck(n, true, null, done);
        }
      );
    }
  });

  describe('[AR02] testing with small number of items', function () {
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
        assert.strictEqual(err, null);
        assert.ok(res);
        if (typeof (resultMapping) === 'function') {
          res = resultMapping(res);
        }
        res = JSON.parse(res);
        assert.ok(res[name]);
        assert.deepStrictEqual(res[name], items);
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
