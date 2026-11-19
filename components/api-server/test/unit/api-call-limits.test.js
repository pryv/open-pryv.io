/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-call ceilings checked where every API call passes: calls of one account
 * in progress at once (429 too-many-requests) and the shape of the parameters
 * (400 invalid-parameters-format). A batch's inner calls are not counted again.
 */

import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const API = require('../../src/API.ts').default;
const { jsonShapeProblem, acquireCallSlot, inflightCount } = require('../../src/callLimits.ts');
const { withInjectedConfig } = require('test-helpers');

/* global assert */

const tracing = { startSpan () {}, finishSpan () {}, setError () {} };

/** `accessId: null` = a call without an access (token-less route). */
function call (api, methodId, params, { userId, accessId, genericDispatch } = {}) {
  return new Promise((resolve) => {
    const access = accessId === null || userId == null ? null : { id: accessId ?? ('acc-' + userId) };
    const context = { methodId, tracing, genericDispatch, access, user: userId == null ? undefined : { id: userId, username: userId } };
    api.call(context, params, (err, result) => resolve({ err, result }));
  });
}

function nested (depth) {
  let value = { leaf: true };
  for (let i = 1; i < depth; i++) value = { child: value };
  return value;
}

/** A method that stays in progress until `open()` is called. */
function gatedApi () {
  const api = new API();
  const gates = [];
  api.register('events.get', function waits (context, params, result, next) {
    gates.push(() => next());
  });
  api.register('events.getOne', function fails (context, params, result, next) {
    next(new Error('boom'));
  });
  api.register('streams.get', function streams (context, params, result, next) {
    result.addStream('events', Readable.from([{ id: 'a' }]));
    next();
  });
  return { api, openAll: () => { while (gates.length > 0) gates.shift()(); }, pending: () => gates.length };
}

async function settle () { await new Promise((resolve) => setImmediate(resolve)); }

describe('[APLM] API per-call limits', function () {
  it('[APLM1] parameters nested deeper than limits.json.maxDepth are refused before the method runs', async function () {
    await withInjectedConfig({ limits: { json: { maxDepth: 5 } } }, async () => {
      const { api, pending } = gatedApi();
      const refused = await call(api, 'events.get', { content: nested(5) });
      assert.strictEqual(refused.err?.id, 'invalid-parameters-format', String(refused.err));
      assert.strictEqual(refused.err.httpStatus, 400);
      assert.strictEqual(pending(), 0, 'the method must not run');
      call(api, 'events.get', { content: nested(4) });
      await settle();
      assert.strictEqual(pending(), 1, 'depth 5 including the parameters object itself is accepted');
    });
  });

  it('[APLM2] an object with more keys than limits.json.maxObjectKeys is refused; 0 disables the check', async function () {
    const wide = {};
    for (let i = 0; i < 11; i++) wide['k' + i] = i;
    await withInjectedConfig({ limits: { json: { maxObjectKeys: 10 } } }, async () => {
      const { api } = gatedApi();
      const refused = await call(api, 'events.getOne', { content: wide });
      assert.strictEqual(refused.err?.id, 'invalid-parameters-format', String(refused.err));
    });
    await withInjectedConfig({ limits: { json: { maxObjectKeys: 0, maxDepth: 0 } } }, async () => {
      const { api } = gatedApi();
      const passed = await call(api, 'events.getOne', { content: wide, deep: nested(200) });
      assert.notStrictEqual(passed.err?.id, 'invalid-parameters-format', 'the method ran (and failed on its own)');
    });
  });

  it('[APLM3] past limits.requests.maxInflightPerUser calls of one account answer 429; other accounts are not affected; a finished call frees its slot', async function () {
    await withInjectedConfig({ limits: { requests: { maxInflightPerUser: 2 } } }, async () => {
      const { api, openAll, pending } = gatedApi();
      const first = call(api, 'events.get', {}, { userId: 'aplm3-a' });
      const second = call(api, 'events.get', {}, { userId: 'aplm3-a' });
      const refused = await call(api, 'events.get', {}, { userId: 'aplm3-a' });
      assert.strictEqual(refused.err?.id, 'too-many-requests', String(refused.err));
      assert.strictEqual(refused.err.httpStatus, 429);
      assert.strictEqual(refused.err.httpHeaders?.['Retry-After'], '1');
      call(api, 'events.get', {}, { userId: 'aplm3-b' });
      await settle();
      assert.strictEqual(pending(), 3, 'two calls of the first account and one of the other run');
      openAll();
      await Promise.all([first, second]);
      assert.strictEqual(inflightCount('user:aplm3-a'), 0);
      call(api, 'events.get', {}, { userId: 'aplm3-a' });
      await settle();
      assert.strictEqual(pending(), 1, 'a new call runs once the slots are free');
      openAll();
    });
  });

  it('[APLM4] a failed call and a streamed result consumed give their slot back', async function () {
    await withInjectedConfig({ limits: { requests: { maxInflightPerUser: 1 } } }, async () => {
      const { api } = gatedApi();
      const failed = await call(api, 'events.getOne', {}, { userId: 'aplm4' });
      assert.ok(failed.err != null);
      assert.strictEqual(inflightCount('user:aplm4'), 0, 'released on failure');
      const streamed = await call(api, 'streams.get', {}, { userId: 'aplm4' });
      assert.strictEqual(streamed.err, null);
      assert.strictEqual(inflightCount('user:aplm4'), 1, 'held while the stream is unread');
      await new Promise((resolve, reject) => streamed.result.toObject((err) => err ? reject(err) : resolve()));
      assert.strictEqual(inflightCount('user:aplm4'), 0, 'released once read');
    });
  });

  it('[APLM5] the calls inside a batch are neither counted nor checked again', async function () {
    await withInjectedConfig({ limits: { requests: { maxInflightPerUser: 1 }, json: { maxDepth: 3 } } }, async () => {
      const { api, openAll, pending } = gatedApi();
      const outer = call(api, 'events.get', {}, { userId: 'aplm5' });
      call(api, 'events.get', { a: nested(5) }, { userId: 'aplm5', genericDispatch: 'batch' });
      await settle();
      assert.strictEqual(pending(), 2);
      openAll();
      await outer;
    });
  });

  it('[APLM6] shape check: arrays and objects are walked, buffers are not; the walk is not recursive', function () {
    assert.strictEqual(jsonShapeProblem({ a: [[[1]]] }, { maxDepth: 3, maxObjectKeys: 0 }) != null, true);
    assert.strictEqual(jsonShapeProblem({ a: [[1]] }, { maxDepth: 3, maxObjectKeys: 0 }), null);
    assert.strictEqual(jsonShapeProblem({ b: Buffer.alloc(100) }, { maxDepth: 2, maxObjectKeys: 10 }), null);
    assert.match(jsonShapeProblem(nested(100000), { maxDepth: 64, maxObjectKeys: 0 }), /64 levels/);
  });

  it('[APLM7] a slot is given back once only, and max 0 never refuses', function () {
    const release = acquireCallSlot('user:aplm7', 1);
    assert.strictEqual(acquireCallSlot('user:aplm7', 1), null);
    release();
    release();
    assert.strictEqual(inflightCount('user:aplm7'), 0);
    for (let i = 0; i < 5; i++) assert.ok(acquireCallSlot('user:aplm7', 0) != null);
    assert.strictEqual(inflightCount('user:aplm7'), 0);
  });

  it('[APLM8] a call without an access is not counted against the account named in its URL', async function () {
    await withInjectedConfig({ limits: { requests: { maxInflightPerUser: 1 } } }, async () => {
      const { api, openAll, pending } = gatedApi();
      for (let i = 0; i < 3; i++) call(api, 'events.get', {}, { userId: 'aplm8', accessId: null });
      await settle();
      assert.strictEqual(pending(), 3, 'token-less calls all run');
      assert.strictEqual(inflightCount('user:aplm8'), 0);
      const own = call(api, 'events.get', {}, { userId: 'aplm8' });
      await settle();
      assert.strictEqual(pending(), 4, "the account's own authenticated call still runs");
      openAll();
      await own;
    });
  });

  it('[APLM9] one access is held to limits.requests.maxInflightPerAccess, below its account budget', async function () {
    await withInjectedConfig({ limits: { requests: { maxInflightPerUser: 3, maxInflightPerAccess: 2 } } }, async () => {
      const { api, openAll, pending } = gatedApi();
      call(api, 'events.get', {}, { userId: 'aplm9', accessId: 'shared' });
      call(api, 'events.get', {}, { userId: 'aplm9', accessId: 'shared' });
      const refused = await call(api, 'events.get', {}, { userId: 'aplm9', accessId: 'shared' });
      assert.strictEqual(refused.err?.id, 'too-many-requests', String(refused.err));
      assert.strictEqual(inflightCount('user:aplm9'), 2, 'a refused call holds no account slot');
      call(api, 'events.get', {}, { userId: 'aplm9', accessId: 'personal' });
      await settle();
      assert.strictEqual(pending(), 3, 'the owner keeps the rest of the account budget');
      openAll();
      await settle();
      assert.strictEqual(inflightCount('access:shared'), 0);
    });
  });
});
