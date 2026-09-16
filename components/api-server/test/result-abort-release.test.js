/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global assert */

const { Readable, Writable, Transform } = require('stream');
const Result = require('../src/Result.ts').default;
const { ConvertEventFromStoreStream } = require('../../mall/src/helpers/eventsUtils.ts');
const CleanDeletedEventsStream = require('../src/methods/streams/CleanDeletedEventsStream.ts').default;

// A response that goes away mid-stream must reach the stream that owns the
// scarce resource — a pooled DB client held by a server-side cursor. That
// source sits behind several Transforms, and `.pipe()` does not forward
// destroy, so the source used to be abandoned still holding its client.
//
// These tests wrap the sources exactly the way production does, through the
// REAL wrapper classes. That is the whole point: the earlier attempt at this
// fix was covered by a unit test that registered a BARE source on the Result,
// which cannot see a holder sitting behind a wrap, so it passed while the leak
// was live. Keep the real classes here.
describe('[RSAB] streamed responses release their sources when the client goes away', function () {
  let uncaught = null;
  const onUncaught = (err) => { uncaught = err; };

  beforeEach(function () {
    uncaught = null;
    process.on('uncaughtException', onUncaught);
  });

  afterEach(function () {
    process.removeListener('uncaughtException', onUncaught);
  });

  // A source shaped like a cursor-backed read: it OWNS something, and the only
  // place it can give it back is the generator's `finally`. `released` going
  // true is the proof the destroy actually arrived.
  function resourceSource (rows = 1000) {
    const state = { released: false, stream: null };
    async function * gen () {
      try {
        for (let i = 0; i < rows; i++) {
          yield { id: 'e' + i, streamIds: ['s'], type: 'note/txt', content: i };
          // Let the consumer act between rows, so a destroy can land mid-stream.
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        state.released = true; // the client release in the real implementation
      }
    }
    state.stream = Readable.from(gen(), { objectMode: true });
    return state;
  }

  // The audit record counter from eventsGetUtils, reduced to its stream shape.
  function countingStream () {
    return new Transform({
      objectMode: true,
      transform (event, encoding, cb) { cb(null, event); }
    });
  }

  // Accepts one chunk, then dies — an HTTP client hanging up mid-response.
  function responseThatDiesAfterFirstChunk () {
    const res = new Writable({
      write (chunk, encoding, cb) {
        cb();
        setImmediate(() => res.destroy());
      }
    });
    res.setHeader = () => {};
    res.statusCode = 200;
    return res;
  }

  function fullResponse () {
    const res = new Writable({ write (chunk, encoding, cb) { cb(); } });
    res.setHeader = () => {};
    res.statusCode = 200;
    return res;
  }

  async function until (predicate, deadlineMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }

  it('[RSAB2] releases the current AND the pending sources behind the real wrappers', async function () {
    const result = new Result({ isStreamResult: true });
    const a = resourceSource();
    const b = resourceSource();
    const c = resourceSource();

    // Exactly the production wrapping: store conversion, then the counter, then
    // into the concat array. `b` is registered too and is therefore PENDING
    // behind `a` — already flowing, already able to hold a client.
    result.addToConcatArrayStream('events', countingStream2(a.stream));
    result.addToConcatArrayStream('events', countingStream2(b.stream));
    result.closeConcatArrayStream('events');
    // A second registered stream, the eventDeletions path.
    result.addStream('eventDeletions', pipeThroughReal(c.stream, new CleanDeletedEventsStream()));

    const res = responseThatDiesAfterFirstChunk();
    result.writeToHttpResponse(res, 200);

    const ok = await until(() => a.released && b.released && c.released);
    assert.ok(ok,
      `every source must be released: a=${a.released} b=${b.released} c=${c.released}`);
    assert.ok(a.stream.destroyed, 'current source destroyed');
    assert.ok(b.stream.destroyed, 'PENDING source destroyed (queued behind the current one)');
    assert.ok(c.stream.destroyed, 'second registered source destroyed');
    assert.strictEqual(uncaught, null, 'a destroyed source must not crash the process');
  });

  it('[RSAB3] a response that is ALREADY gone releases the sources and still runs onEnd', async function () {
    const result = new Result({ isStreamResult: true });
    const a = resourceSource();
    result.addToConcatArrayStream('events', countingStream2(a.stream));
    result.closeConcatArrayStream('events');

    const res = fullResponse();
    res.destroy(); // client vanished before we ever got to write

    let onEndCalls = 0;
    result.onEnd(() => { onEndCalls++; });
    // Must not throw ERR_STREAM_UNABLE_TO_PIPE.
    result.writeToHttpResponse(res, 200);

    const ok = await until(() => a.released);
    assert.ok(ok, 'source released even though there was no response to pipe into');
    assert.strictEqual(onEndCalls, 1,
      'onEnd must still run — it is what AUDITS the call, and a listener attached ' +
      'to an already-closed response would never fire');
    assert.strictEqual(uncaught, null);
  });

  it('[RSAB4] the toObject path releases the source when arrayLimit is hit', async function () {
    const limit = 5;
    const result = new Result({ isStreamResult: true, arrayLimit: limit });
    const a = resourceSource(limit + 50);
    result.addToConcatArrayStream('events', countingStream2(a.stream));
    result.closeConcatArrayStream('events');

    let calls = 0;
    let sawError = null;
    await new Promise((resolve) => {
      result.toObject((err) => {
        calls++;
        sawError = err;
        resolve();
      });
    });

    assert.strictEqual(calls, 1, 'callback exactly once');
    assert.notStrictEqual(sawError, null, 'overflowing arrayLimit must report an error');
    assert.notStrictEqual(sawError, undefined, 'overflowing arrayLimit must report an error');
    const ok = await until(() => a.released);
    assert.ok(ok, 'the source must be released when the drain stops early');
    assert.strictEqual(uncaught, null);
  });

  it('[RSAB5] a fully consumed response still ends every source cleanly', async function () {
    const result = new Result({ isStreamResult: true });
    const a = resourceSource(20);
    const b = resourceSource(20);
    result.addToConcatArrayStream('events', countingStream2(a.stream));
    result.addToConcatArrayStream('events', countingStream2(b.stream));
    result.closeConcatArrayStream('events');

    const res = fullResponse();
    let onEndCalls = 0;
    result.onEnd(() => { onEndCalls++; });
    result.writeToHttpResponse(res, 200);

    const ok = await until(() => onEndCalls === 1);
    assert.ok(ok, 'onEnd runs on the happy path too');
    assert.ok(a.released && b.released, 'both generators completed');
    assert.strictEqual(uncaught, null);
  });

  // The failure paths that come BEFORE the response, where a registered source
  // is already flowing and holding its resource but nothing will ever drain it.
  // [RSAB2..5] all assume the response path runs; these two do not.

  it('[RSAB6] a later element failing releases the sources registered behind it', async function () {
    const limit = 5;
    const result = new Result({ isStreamResult: true, arrayLimit: limit });
    // Element one overflows arrayLimit and fails the walk; element two is
    // registered, flowing, and would never be looked at again.
    const first = resourceSource(limit + 50);
    // Big enough that it CANNOT run to completion on its own: a short source
    // fits in the wrappers' buffers, finishes unaided and makes this test pass
    // whether or not anything released it.
    const second = resourceSource(1000);
    result.addStream('events', countingStream2(first.stream));
    result.addStream('deletions', countingStream2(second.stream));

    let sawError = null;
    await new Promise((resolve) => {
      result.toObject((err) => { sawError = err; resolve(); });
    });

    assert.ok(sawError != null, 'overflowing arrayLimit must report an error');
    const ok = await until(() => first.released && second.released);
    assert.ok(ok, 'BOTH sources must be released, not just the one that failed');
    assert.strictEqual(uncaught, null);
  });

  it('[RSAB7] release() frees a registered source for a caller that abandons the Result', async function () {
    const result = new Result({ isStreamResult: true });
    const a = resourceSource(1000);
    result.addStream('events', countingStream2(a.stream));

    // What API.finalize does when the method rejects after registering.
    result.release();

    const ok = await until(() => a.released);
    assert.ok(ok, 'an abandoned Result must not leave its source holding a resource');
    assert.strictEqual(uncaught, null);
    // Idempotent: a second release must not throw.
    result.release();
    assert.strictEqual(uncaught, null);
  });

  it('[RSAB8] release() reaches concat sources that were added but never closed', async function () {
    const result = new Result({ isStreamResult: true });
    // This is the shape events.get builds while walking the stores: one stream
    // added per store, the group closed only after the last one. A store that
    // fails part-way leaves these added-but-not-closed, and they are NOT in
    // streamsArray, so a release that only walks that array misses them.
    const a = resourceSource(1000);
    const b = resourceSource(1000);
    result.addToConcatArrayStream('events', countingStream2(a.stream));
    result.addToConcatArrayStream('events', countingStream2(b.stream));
    // deliberately NO closeConcatArrayStream

    result.release();

    const ok = await until(() => a.released && b.released);
    assert.ok(ok, 'an unclosed concat group must still be released');
    assert.strictEqual(uncaught, null);
  });

  // Production wraps a store stream in ConvertEventFromStoreStream and then the
  // audit counter; reproduce both hops through the real class.
  function countingStream2 (source) {
    const converted = pipeThroughReal(source, new ConvertEventFromStoreStream('local'));
    return pipeThroughReal(converted, countingStream());
  }

  function pipeThroughReal (source, transform) {
    const { pipeThrough } = require('utils');
    return pipeThrough(source, transform);
  }
});
