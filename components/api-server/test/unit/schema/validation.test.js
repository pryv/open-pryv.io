/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

require('../test-helper');
const assert = require('node:assert');
const { tryCoerceStringValues } = require('../../../src/schema/validation');

describe('[CSVL] tryCoerceStringValues', () => {
  it('[DTZ1] should behave as documented in the method', () => {
    const object = { a: 'true', b: '2343', c: 'foobar' };
    const types = { a: 'boolean', b: 'number' };
    tryCoerceStringValues(object, types);
    const expect = { a: true, b: 2343, c: 'foobar' };
    assert.deepStrictEqual(object, expect);
  });
  it("[X26S] doesn't create keys in object", () => {
    const o = {};
    const t = { a: 'number' };
    tryCoerceStringValues(o, t);
    assert.strictEqual(Object.keys(o).length, 0, 'Keys have been created in target.');
  });
  it('[4MHH] should convert to array', () => {
    const obj = { a: '1', b: 'test' };
    tryCoerceStringValues(obj, { a: 'array', b: 'array' });
    assert.deepStrictEqual(obj, { a: ['1'], b: ['test'] });
  });
  it('[X8PY] number conversion works', () => {
    ok('123', 123);
    ok('123.45', 123.45);
    notOk('123abc');
    notOk('123.45aksfhjal');
    function ok (n, e) {
      const o = { a: n };
      const s = { a: 'number' };
      tryCoerceStringValues(o, s);
      assert.equal(o.a, e);
    }
    function notOk (n) {
      const o = { a: n };
      const s = { a: 'number' };
      tryCoerceStringValues(o, s);
      assert.equal(o.a, n);
    }
  });
});
