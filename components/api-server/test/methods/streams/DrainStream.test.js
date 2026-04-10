/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

'use strict';

const DrainStream = require('../../../src/methods/streams/DrainStream');
const _ = require('lodash');
const assert = require('node:assert');

describe('[DRNM] DrainStream', function () {
  it('[AFWR] must be fed objects and return them in the callback', function (done) {
    const input = [{ a: 'a' }, { b: 'b' }, { c: 'c' }];

    function expectation (err, array) {
      assert.strictEqual(err, null);
      assert.strictEqual(_.isEqual(array, input), true);
      done();
    }

    const drain = new DrainStream({ limit: 4, isArray: true }, expectation);

    input.forEach(function (item) {
      drain.write(item);
    });
    drain.end();
  });

  it('[23UQ] must return an error when the provided limit is exceeded', function (done) {
    function expectation (err) {
      assert.ok(err);
      done();
    }

    const drain = new DrainStream({ limit: 1, isArray: true }, expectation);
    drain.write({ a: 'a' });
    drain.write({ b: 'b' });
  });
});
