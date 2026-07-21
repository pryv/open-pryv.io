/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The method chain must complete even when a function fails asynchronously.
 *
 * An async function that throws after an `await` REJECTS rather than throwing
 * synchronously. The chain runner used to call each function inside a plain
 * try/catch without observing the returned promise, so such a failure was never
 * seen: `next` was never called, the callback never fired, and the HTTP request
 * hung forever with no response. Reproduced live as
 * `GET /streams?parentId=:<unknown-store>:foo`, where the mall throws
 * `unknownResource('Store', …)` after awaits.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const API = require('../../src/API.ts').default;

/* global assert */

function callChain (api, methodId) {
  return new Promise((resolve) => {
    const context = {
      methodId,
      username: 'tester',
      tracing: { startSpan () {}, finishSpan () {}, setError () {} }
    };
    api.call(context, {}, (err, result) => resolve({ err, result }));
  });
}

describe('[APAR] API chain — asynchronous failures', function () {
  it('[APAR1] a rejecting async function fails the call instead of hanging', async function () {
    // Short on purpose: before the fix this call never came back at all, so the
    // regression must surface as a fast timeout, not a wedged runner.
    this.timeout(5000);
    const api = new API();
    api.register('events.get',
      async function rejectsAfterAwait () {
        await Promise.resolve();
        throw new Error('async boom');
      },
      function neverReached (context, params, result, next) {
        next();
      });

    const { err } = await callChain(api, 'events.get');
    assert.ok(err != null, 'the call must surface an error rather than never returning');
    assert.match(String(err.message || err), /async boom|unexpected/i);
  });

  it('[APAR2] a synchronous throw still fails the call', async function () {
    const api = new API();
    api.register('events.getOne', function throwsSync () {
      throw new Error('sync boom');
    });

    const { err } = await callChain(api, 'events.getOne');
    assert.ok(err != null);
    assert.match(String(err.message || err), /sync boom|unexpected/i);
  });

  it('[APAR3] a normal async function that calls next() still completes once', async function () {
    const api = new API();
    let secondRan = 0;
    api.register('streams.get',
      async function fine (context, params, result, next) {
        await Promise.resolve();
        next();
      },
      function second (context, params, result, next) {
        secondRan++;
        next();
      });

    const { err } = await callChain(api, 'streams.get');
    assert.strictEqual(err, null, 'expected no error, got ' + String(err));
    assert.strictEqual(secondRan, 1, 'the rest of the chain must run exactly once');
  });

  it('[APAR4] rejecting AFTER calling next() does not advance the chain twice', async function () {
    const api = new API();
    let secondRan = 0;
    api.register('accesses.get',
      async function nextThenReject (context, params, result, next) {
        next();
        await Promise.resolve();
        throw new Error('late boom');
      },
      function second (context, params, result, next) {
        secondRan++;
        next();
      });

    const { err } = await callChain(api, 'accesses.get');
    // Give the late rejection a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(err, null, 'the call had already succeeded');
    assert.strictEqual(secondRan, 1, 'the late rejection must not re-run the chain');
  });
});
