/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * A streamed call is counted by how it ENDED, not by how its method returned.
 *
 * The method of a streamed call (events.get) returns once its sources are
 * registered, before a single row is read. The call used to be counted a
 * success right then, so a store failing on its first row, or a client leaving
 * half-way, still showed up as a 2xx in the telemetry.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Readable, Writable } = require('stream');
const API = require('../../src/API.ts').default;
const { DummyTracing } = require('tracing');
const emitter = require('business/src/observability/emitter.ts');
const observability = require('business/src/observability/index.ts');

/* global assert */

const METHOD_ID = 'events.get';

function initTelemetry () {
  observability.init({
    endpoint: 'https://otlp.example.test',
    headers: {},
    serviceName: 'open-pryv.io (test)',
    serviceVersion: '2.0.0',
    instanceId: 'core-test.example.com',
    worker: '1',
    methodIds: [METHOD_ID],
    flushIntervalMs: 3600000, // never fires during a test
    send: async function () {}
  });
}

// status classes counted for the method, e.g. ['2xx']
function countedClasses () {
  const points = emitter._buffered().counters['api.method.calls'] || [];
  return points
    .filter((p) => p.attributes['method.id'] === METHOD_ID)
    .flatMap((p) => Array(p.value).fill(p.attributes['status.class']));
}

function countedErrorCodes () {
  const points = emitter._buffered().counters['api.method.errors'] || [];
  return points.map((p) => p.attributes['error.code']);
}

function rows (count) {
  async function * gen () {
    for (let i = 0; i < count; i++) {
      yield { id: 'e' + i, content: i };
      // lets a destroy land between rows
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return Readable.from(gen(), { objectMode: true });
}

function failingSource () {
  return new Readable({ objectMode: true, read () { this.destroy(new Error('read failure')); } });
}

function streamingApi (makeSource) {
  const api = new API();
  api.register(METHOD_ID, function (context, params, result, next) {
    result.addStream('events', makeSource());
    next();
  });
  return api;
}

function call (api) {
  return new Promise((resolve, reject) => {
    const context = {
      methodId: METHOD_ID,
      username: 'tester',
      tracing: new DummyTracing()
    };
    api.call(context, {}, (err, result) => err != null ? reject(err) : resolve(result));
  });
}

function response ({ dieAfterFirstChunk = false } = {}) {
  const res = new Writable({
    write (chunk, encoding, cb) {
      cb();
      if (dieAfterFirstChunk) setImmediate(() => res.destroy());
    }
  });
  res.setHeader = () => {};
  res.removeHeader = () => {};
  res.headersSent = false;
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

describe('[APOC] API call telemetry follows the outcome of a streamed result', function () {
  beforeEach(initTelemetry);
  afterEach(function () { observability._reset(); });

  it('[APOC1] a streamed call is counted once fully written, not when its method returns', async function () {
    const result = await call(streamingApi(() => rows(5)));
    assert.deepStrictEqual(countedClasses(), [], 'nothing is read yet: nothing may be counted');

    const res = response();
    result.writeToHttpResponse(res, 200, () => {});
    assert.ok(await until(() => countedClasses().length === 1), 'counted at the end of the response');
    assert.deepStrictEqual(countedClasses(), ['2xx']);
    assert.ok(res.writableFinished);
  });

  it('[APOC2] a store failing while read is counted as a failure, not a success', async function () {
    const result = await call(streamingApi(failingSource));
    const handled = [];
    const res = response();
    result.writeToHttpResponse(res, 200, (err) => { handled.push(err); res.end(); });

    assert.ok(await until(() => countedClasses().length === 1), 'the call must be counted');
    assert.deepStrictEqual(countedClasses(), ['5xx']);
    assert.deepStrictEqual(countedErrorCodes(), ['unexpected-error']);
    assert.strictEqual(handled.length, 1, 'the error handler still answers it');
  });

  it('[APOC3] a client leaving mid-stream is counted as client-closed-request', async function () {
    const result = await call(streamingApi(() => rows(20000)));
    result.writeToHttpResponse(response({ dieAfterFirstChunk: true }), 200, () => {});

    assert.ok(await until(() => countedClasses().length === 1), 'the call must be counted');
    assert.deepStrictEqual(countedClasses(), ['4xx']);
    assert.deepStrictEqual(countedErrorCodes(), ['client-closed-request']);
  });

  it('[APOC4] the toObject path (socket, batch) counts a read failure as a failure', async function () {
    const result = await call(streamingApi(failingSource));
    const err = await new Promise((resolve) => result.toObject((e) => resolve(e)));
    assert.ok(err != null, 'toObject reports the read failure');
    assert.deepStrictEqual(countedClasses(), ['5xx']);
  });

  it('[APOC5] the toObject path counts a drained result as a success, once', async function () {
    const result = await call(streamingApi(() => rows(3)));
    const obj = await new Promise((resolve, reject) => result.toObject((e, o) => e ? reject(e) : resolve(o)));
    assert.strictEqual(obj.events.length, 3);
    assert.deepStrictEqual(countedClasses(), ['2xx']);
  });

  it('[APOC6] a call without streams is still counted when its method returns', async function () {
    const api = new API();
    api.register(METHOD_ID, function (context, params, result, next) {
      result.events = [];
      next();
    });
    await call(api);
    assert.deepStrictEqual(countedClasses(), ['2xx']);
  });
});
