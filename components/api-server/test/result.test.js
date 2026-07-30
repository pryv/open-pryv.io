/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global assert */

const Result = require('../src/Result.ts').default;
const Transform = require('stream').Transform;
const inherits = require('util').inherits;
const Source = require('./helpers').SourceStream;

describe('[RSLT] Result', function () {
  describe('[RS01] concatStream', function () {
    it('[36RQ] must concatenate multiple streams in a single Array', function (done) {
      const res = new Result();
      const a1 = ['a', 'b', 'c'];
      const a2 = ['d', 'e', 'f'];
      const s1 = new Source(a1);
      const s2 = new Source(a2);

      function expectation (err, content) {
        assert.ok(err == null);
        assert.deepStrictEqual(content, { events: a1.concat(a2) });
        done();
      }
      res.addToConcatArrayStream('events', s1);
      res.addToConcatArrayStream('events', s2);
      res.closeConcatArrayStream('events');
      res.toObject(expectation);
    });
  });

  describe('[RS02] toObject()', function () {
    it('[NKHF] must return the result\'s content when not storing streams', function (done) {
      const res = new Result();
      res.a = 'a';

      function expectation (err, content) {
        assert.ok(err == null);
        assert.strictEqual(content.a, 'a');
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
        assert.ok(err == null);
        assert.deepStrictEqual(content[arrayName1], array1);
        assert.deepStrictEqual(content[arrayName2], array2);
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
        assert.ok(err != null);
        assert.ok(content == null);
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
        assert.ok(err != null);
        assert.ok(content == null);
        done();
      }

      res.addStream(arrayName1, p1);
      res.toObject(expectation);
    });
  });

  describe('[RS-ABORT] writeStreams source cleanup on response close', function () {
    const { Readable, Writable } = require('stream');

    it('[RSAB1] destroys source streams when the response closes before they drain', function (done) {
      const res = new Result();
      // A source that never ends — models a long, DB-backed stream suspended at
      // a yield while holding a resource (a server-side cursor / pooled client).
      const source = new Readable({ read () {} });
      source.on('error', () => {});
      res.addStream('events', source, true);

      // Minimal HTTP-response mock: a Writable with setHeader + statusCode.
      const httpRes = new Writable({ write (chunk, enc, cb) { cb(); } });
      httpRes.on('error', () => {});
      httpRes.setHeader = function () {};
      httpRes.statusCode = 200;

      res.writeStreams(httpRes, 200);
      assert.strictEqual(source.destroyed, false, 'source is live before the response closes');

      // Simulate a client abort / premature response close.
      httpRes.emit('close');
      setImmediate(() => {
        assert.strictEqual(source.destroyed, true, 'source must be destroyed on response close');
        done();
      });
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
