/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const fs = require('node:fs');
const path = require('node:path');

// An audit record is written after the call it describes has taken effect.
// When that write fails, the call's answer must not change: inside a batch, a
// stored event must still be answered as created (a retry would duplicate it),
// and a failure while recording a FAILED call must not end the whole batch.
// The failure is logged at error level instead, which is what operators alert
// on. The single-call HTTP path already behaves this way; [BAUF5] pins it.
//
// The in-process core serves the requests, so replacing methods on the audit
// singleton changes what the batch method calls. The stubs fail only for the
// inner calls: the batch envelope's own record is still written.
describe('[BAUF] audit-write failures inside a batch', function () {
  this.timeout(60_000);

  const SYNC_LOG = path.join(__dirname, '../var-pryv/logs/test-sync.log');

  let fixtures, audit;
  let username, token, streamId;
  let originalValidApiCall, originalErrorApiCall;
  let rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'bauf-' + cuid().slice(-8);
    token = cuid();
    streamId = 'bauf-stream';
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: streamId, name: streamId });
    audit = require('audit').default;
    originalValidApiCall = audit.validApiCall;
    originalErrorApiCall = audit.errorApiCall;
  });

  after(async function () {
    if (audit != null) {
      audit.validApiCall = originalValidApiCall;
      audit.errorApiCall = originalErrorApiCall;
    }
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  beforeEach(function () {
    rejections = [];
    process.on('unhandledRejection', onRejection);
  });

  afterEach(function () {
    process.removeListener('unhandledRejection', onRejection);
    audit.validApiCall = originalValidApiCall;
    audit.errorApiCall = originalErrorApiCall;
  });

  function batch (calls) {
    return coreRequest.post('/' + username).set('Authorization', token).send(calls);
  }

  /** Replaces `name` on the audit singleton: throws for the inner calls, keeps
   * the real write for the batch envelope. Returns the methods it refused. */
  function failInnerCalls (name, message, onCall) {
    const original = name === 'validApiCall' ? originalValidApiCall : originalErrorApiCall;
    const refused = [];
    audit[name] = async function (context, arg) {
      if (context.methodId === 'callBatch') return original.call(audit, context, arg);
      if (onCall != null) onCall(context);
      refused.push(context.methodId);
      throw new Error(message);
    };
    return refused;
  }

  async function auditRows (action) {
    const auditStorage = require('storages').auditStorage;
    const userDb = await auditStorage.forUser(username);
    const events = await userDb.getEvents({ query: [] });
    const mine = events.filter((e) => e.content?.action === action);
    return {
      valid: mine.filter((e) => e.type === 'audit-log/pryv-api').length,
      error: mine.filter((e) => e.type === 'audit-log/pryv-api-error').length
    };
  }

  function syncLogSize () {
    try { return fs.statSync(SYNC_LOG).size; } catch (_e) { return 0; }
  }

  function syncLogSince (offset) {
    try { return fs.readFileSync(SYNC_LOG).subarray(offset).toString(); } catch (_e) { return ''; }
  }

  async function eventsWithContent (content) {
    const res = await coreRequest.get('/' + username + '/events')
      .set('Authorization', token)
      .query({ streams: JSON.stringify([streamId]), limit: 1000 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.events.filter((e) => e.content === content);
  }

  it('[BAUF1] a failing success-audit write keeps each batched call\'s result and is logged', async function () {
    const tag = 'bauf1-' + cuid.slug();
    const refused = failInnerCalls('validApiCall', 'simulated audit write failure');
    let errorAudits = 0;
    audit.errorApiCall = async function (context, err) {
      if (context.methodId === 'events.create') errorAudits++;
      return originalErrorApiCall.call(audit, context, err);
    };
    const beforeCreate = await auditRows('events.create');
    const beforeBatch = await auditRows('callBatch');
    const logOffset = syncLogSize();

    const res = await batch([
      { method: 'events.create', params: { streamIds: [streamId], type: 'note/txt', content: tag + '-a' } },
      { method: 'events.create', params: { streamIds: [streamId], type: 'note/txt', content: tag + '-b' } }
    ]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.results.length, 2);
    for (const r of res.body.results) {
      assert.strictEqual(r.error, undefined, 'a stored event must not be answered as failed: ' + JSON.stringify(r));
      assert.ok(r.event?.id, 'the created event is returned');
    }
    assert.deepStrictEqual(refused, ['events.create', 'events.create']);
    // The reads below are audited for real.
    audit.validApiCall = originalValidApiCall;

    assert.strictEqual((await eventsWithContent(tag + '-a')).length, 1, 'first event stored once');
    assert.strictEqual((await eventsWithContent(tag + '-b')).length, 1, 'second event stored once');
    assert.strictEqual(errorAudits, 0, 'a succeeded call is not audited as an error');

    const afterCreate = await auditRows('events.create');
    assert.strictEqual(afterCreate.error, beforeCreate.error, 'no error record for a succeeded call');
    assert.strictEqual(afterCreate.valid, beforeCreate.valid, 'the failed writes left no record');
    const afterBatch = await auditRows('callBatch');
    assert.strictEqual(afterBatch.valid, beforeBatch.valid + 1, 'the batch envelope is audited');

    const logged = syncLogSince(logOffset);
    assert.match(logged, /Failed to audit a batched call \(success\): events\.create/);
    assert.match(logged, /simulated audit write failure/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(rejections.map(String), [], 'no unhandled rejection');
  });

  it('[BAUF2] a failing error-audit write answers that call\'s error and the batch goes on', async function () {
    const tag = 'bauf2-' + cuid.slug();
    const refused = failInnerCalls('errorApiCall', 'simulated error-audit write failure');
    const logOffset = syncLogSize();

    const res = await batch([
      { method: 'events.create', params: { streamIds: ['bauf-unknown-stream'], type: 'note/txt', content: tag + '-a' } },
      { method: 'events.create', params: { streamIds: [streamId], type: 'note/txt', content: tag + '-b' } }
    ]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.results.length, 2);
    assert.strictEqual(res.body.results[0].error?.id, 'unknown-referenced-resource', JSON.stringify(res.body.results[0]));
    assert.ok(res.body.results[1].event?.id, 'the next call ran: ' + JSON.stringify(res.body.results[1]));
    assert.deepStrictEqual(refused, ['events.create']);
    assert.strictEqual((await eventsWithContent(tag + '-b')).length, 1, 'second event stored once');

    const logged = syncLogSince(logOffset);
    assert.match(logged, /Failed to audit a batched call \(error\): events\.create/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(rejections.map(String), [], 'no unhandled rejection');
  });

  it('[BAUF3] a batched read is drained before it is audited', async function () {
    const tag = 'bauf3-' + cuid.slug();
    const readStream = 'bauf3-' + cuid.slug();
    const N = 7;
    const seeded = await batch([{ method: 'streams.create', params: { id: readStream, name: readStream } }]
      .concat(Array.from({ length: N }, (_v, i) => ({
        method: 'events.create', params: { streamIds: [readStream], type: 'note/txt', content: tag + '-' + i }
      }))));
    assert.strictEqual(seeded.status, 200, JSON.stringify(seeded.body));
    for (const r of seeded.body.results) assert.strictEqual(r.error, undefined, JSON.stringify(r));

    const recorded = [];
    failInnerCalls('validApiCall', 'simulated audit write failure', (context) => {
      recorded.push(context.auditRecordCount);
    });
    const res = await batch([{ method: 'events.get', params: { streams: [readStream], limit: 100 } }]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.results[0].error, undefined, JSON.stringify(res.body.results[0]));
    assert.strictEqual(res.body.results[0].events.length, N);
    assert.deepStrictEqual(recorded, [N], 'the audit saw the drained record count');
  });

  it('[BAUF4] without a failure each batched call is audited once, as valid', async function () {
    const beforeCreate = await auditRows('events.create');
    const beforeBatch = await auditRows('callBatch');
    const res = await batch([
      { method: 'events.create', params: { streamIds: [streamId], type: 'note/txt', content: 'bauf4-' + cuid.slug() } }
    ]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.results[0].event?.id, JSON.stringify(res.body.results[0]));
    const afterCreate = await auditRows('events.create');
    // The record of the envelope is written after the answer.
    let afterBatch = await auditRows('callBatch');
    for (let i = 0; i < 100 && afterBatch.valid === beforeBatch.valid; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      afterBatch = await auditRows('callBatch');
    }
    assert.strictEqual(afterCreate.valid, beforeCreate.valid + 1, 'one valid record for the call');
    assert.strictEqual(afterCreate.error, beforeCreate.error, 'no error record');
    assert.strictEqual(afterBatch.valid, beforeBatch.valid + 1, 'one valid record for the envelope');
    assert.strictEqual(afterBatch.error, beforeBatch.error, 'no error record for the envelope');
  });

  it('[BAUF5] a single HTTP call keeps its answer when its audit write fails', async function () {
    const content = 'bauf5-' + cuid.slug();
    audit.validApiCall = async function () { throw new Error('simulated audit write failure'); };
    const res = await coreRequest.post('/' + username + '/events')
      .set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.event?.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    audit.validApiCall = originalValidApiCall;
    assert.strictEqual((await eventsWithContent(content)).length, 1, 'event stored once');
    assert.deepStrictEqual(rejections.map(String), [], 'no unhandled rejection');
  });
});
