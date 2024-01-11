/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

require('../test-helper');
const assert = require('chai').assert;
const { tryCoerceStringValues } = require('../../../src/schema/validation');

describe('tryCoerceStringValues', () => {
  it('[DTZ1] should behave as documented in the method', () => {
    const object = { a: 'true', b: '2343', c: 'foobar' };
    const types = { a: 'boolean', b: 'number' };
    tryCoerceStringValues(object, types);
    const expect = { a: true, b: 2343, c: 'foobar' };
    assert.deepEqual(object, expect);
  });
  it("[X26S] doesn't create keys in object", () => {
    const o = {};
    const t = { a: 'number' };
    tryCoerceStringValues(o, t);
    assert.lengthOf(Object.keys(o), 0, 'Keys have been created in target.');
  });
  it('[4MHH] should convert to array', () => {
    const obj = { a: '1', b: 'test' };
    tryCoerceStringValues(obj, { a: 'array', b: 'array' });
    assert.deepEqual(obj, { a: ['1'], b: ['test'] });
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
