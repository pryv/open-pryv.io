/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { deepMerge } = require('../src/deepMerge.ts');

// JSON.parse turns a `__proto__` key into an own property, as express.json and
// socket.io payloads do: merging one must never reach a prototype.
describe('[DMRG] deepMerge prototype safety', function () {
  afterEach(() => {
    delete Object.prototype.dmrgPolluted;
  });

  it('[DMRG1] an own __proto__ key at the top level does not reach Object.prototype', () => {
    const target = {};
    deepMerge(target, JSON.parse('{"__proto__":{"dmrgPolluted":true},"a":1}'));
    assert.equal(({}).dmrgPolluted, undefined);
    assert.equal(Object.getPrototypeOf(target), Object.prototype);
    assert.equal(target.a, 1);
  });

  it('[DMRG2] an own __proto__ key one level down does not reach Object.prototype', () => {
    const target = { nested: { kept: 1 } };
    deepMerge(target, JSON.parse('{"nested":{"__proto__":{"dmrgPolluted":true},"added":2}}'));
    assert.equal(({}).dmrgPolluted, undefined);
    assert.deepEqual(target.nested, { kept: 1, added: 2 });
  });

  it('[DMRG3] a class instance target keeps its prototype untouched', () => {
    class Holder { constructor () { this.own = 1; } }
    const target = new Holder();
    deepMerge(target, JSON.parse('{"__proto__":{"dmrgPolluted":true}}'));
    assert.equal(Holder.prototype.dmrgPolluted, undefined);
    assert.equal(target.dmrgPolluted, undefined);
    assert.equal(Object.getPrototypeOf(target), Holder.prototype);
  });

  it('[DMRG4] constructor / prototype keys are merged as data, never into the inherited constructor', () => {
    const target = {};
    deepMerge(target, JSON.parse('{"constructor":{"prototype":{"dmrgPolluted":true}}}'));
    assert.equal(({}).dmrgPolluted, undefined);
    assert.equal(Object.prototype.constructor, Object);
    assert.deepEqual(target.constructor, { prototype: { dmrgPolluted: true } });
  });

  it('[DMRG5] plain objects still merge recursively', () => {
    const target = { a: { b: 1, c: { d: 1 } }, keep: 'x' };
    deepMerge(target, { a: { c: { e: 2 } }, keep: undefined }, { f: [1] });
    assert.deepEqual(target, { a: { b: 1, c: { d: 1, e: 2 } }, keep: 'x', f: [1] });
  });
});
