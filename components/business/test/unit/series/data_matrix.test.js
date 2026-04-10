/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Tests pertaining to storing data in a hf series.

const assert = require('node:assert');
const DataMatrix = require('../../../src/series/data_matrix');
const { ParseFailure } = require('../../../src/series/errors');
const Row = require('../../../src/series/row');
const { TypeRepository } = require('../../../src/types');

describe('[DMTX] DataMatrix', function () {
  describe('[DM01] .parse(obj)', () => {
    const typeRepo = new TypeRepository();
    const type = typeRepo.lookup('series:position/wgs84');
    it('[576J] should accept the happy path', () => {
      good({
        format: 'flatJSON',
        fields: ['deltaTime', 'latitude', 'longitude', 'altitude'],
        points: [[0, 10.2, 11.2, 500]]
      });
    });
    it('[IQTE] refuses if not an object', () => {
      bad(null);
      bad('a string');
    });
    it('[WQGB] refuses if format is not flatJSON', () => {
      bad({
        format: 'somethingElse'
      });
    });
    it('[34RS] refuses if fields are not strings', () => {
      bad({
        format: 'flatJSON',
        fields: null
      });
      bad({
        format: 'flatJSON',
        fields: 42
      });
      bad({
        format: 'flatJSON',
        fields: [13, 14]
      });
    });
    it('[M5BI] refuses if points is not an array', () => {
      bad({
        format: 'flatJSON',
        fields: ['ts', 'foo'],
        points: 42
      });
    });
    it('[V0SH] refuses if field names are not correct', () => {
      bad({
        format: 'flatJSON',
        fields: ['ts', 'foo'],
        points: []
      });
    });
    it('[SBU1] refuses if data cannot be coerced', () => {
      bad({
        format: 'flatJSON',
        fields: ['deltaTime', 'latitude'],
        points: [[0, null]]
      });
    });
    function good (obj) {
      assert.doesNotThrow(() => {
        DataMatrix.parse(obj, type);
      });
    }
    function bad (obj) {
      assert.throws(() => {
        DataMatrix.parse(obj, type);
      }, ParseFailure);
    }
  });
  describe('[DM02] #eachRow', function () {
    it('[QUQ3] should iterate over all matrix rows', function () {
      const headers = ['a', 'b', 'c'];
      const matrix = new DataMatrix(headers, [
        [1, 2, 3],
        [4, 5, 6]
      ]);
      let times = 0;
      matrix.eachRow((row, idx) => {
        if (idx === 0) { assert.deepStrictEqual(row.values, [1, 2, 3]); }
        if (idx === 1) { assert.deepStrictEqual(row.values, [4, 5, 6]); }
        assert.strictEqual(row.columnNames, headers);
        times += 1;
      });
      assert.strictEqual(times, 2);
    });
  });
  describe('[DM03] #transform', function () {
    it('[L03R] should call fn for each cell', function () {
      const headers = ['a', 'b', 'c'];
      const matrix = new DataMatrix(headers, [
        [1, 2, 3],
        [4, 5, 6]
      ]);
      let n = 0;
      matrix.transform((name, value) => {
        assert.strictEqual(name, headers[n % 3]);
        assert.strictEqual(value, n + 1);
        n += 1;
        return value; // satisfy the checker
      });
      assert.strictEqual(n, 6);
    });
    it('[7BRV] should store the return value in the matrix', function () {
      const headers = ['a', 'b', 'c'];
      const matrix = new DataMatrix(headers, [
        [1, 2, 3],
        [4, 5, 6]
      ]);
      matrix.transform(() => {
        return 42; // don't ask
      });
      assert.deepStrictEqual(matrix.at(0), [42, 42, 42]);
    });
  });
  describe('[DM04] #minmax()', () => {
    it('[QGY6] returns the minimum and maximum deltaTime used', () => {
      const headers = ['a', 'b', 'deltaTime'];
      const matrix = new DataMatrix(headers, [
        [1, 2, 3],
        [4, 5, 6]
      ]);
      const { from, to } = matrix.minmax();
      assert.strictEqual(from, 3);
      assert.strictEqual(to, 6);
    });
    it('[ROK8] throws an error if the matrix is empty', () => {
      const headers = ['a', 'b', 'deltaTime'];
      const matrix = new DataMatrix(headers, []);
      assert.throws(() => matrix.minmax());
    });
    it('[79DA] throws an error if the deltaTime is missing', () => {
      const headers = ['a', 'b', 'c'];
      const matrix = new DataMatrix(headers, [
        [1, 2, 3],
        [4, 5, 6]
      ]);
      assert.throws(() => matrix.minmax());
    });
  });
});
describe('[SROW] business.series.Row', function () {
  describe('[SR01] toStruct', function () {
    it('[NJ4G] should return a js object for the row', function () {
      const row = new Row([1, 2], ['a', 'b']);
      const obj = row.toStruct();
      // FLOW
      assert.strictEqual(obj.a, 1);
      // FLOW
      assert.strictEqual(obj.b, 2);
      assert.strictEqual(Object.keys(obj).length, 2);
    });
  });
});
