/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const http = require('node:http');
const { Readable } = require('node:stream');

// Failures on the attachment download path once the file stream exists.
//
// - A source error BEFORE any byte was sent must still answer with an error
//   status and write an error audit record.
// - A source error AFTER bytes were sent cannot change the status any more: the
//   headers are on the wire. The response must be cut (so the client sees a
//   broken transfer instead of hanging on a Content-Length that never arrives),
//   the error audited once, and nothing may reject unhandled.
// - A failure writing the success audit record after the file was served must
//   not reject unhandled either.
//
// The in-process core serves the requests, so the spies on the mall and on the
// audit singleton are the objects the middleware calls. Unhandled rejections are
// observed with a process listener: the test runner installs a warn-only
// handler, which would otherwise hide a rejection that crashes a real worker.
describe('[ATER] attachment download error paths', function () {
  this.timeout(60_000);

  let fixtures, mall, audit;
  let username, token, eventId, fileId;
  let sourceFactory = null;
  let originalGetAttachment, originalValidApiCall;
  let rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'ater-' + cuid().slice(-8);
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: 'ater-files', name: 'ater-files' });

    const created = await coreRequest
      .post('/' + username + '/events')
      .set('Authorization', token)
      .field('event', JSON.stringify({ streamIds: ['ater-files'], type: 'file/attached' }))
      .attach('file', Buffer.alloc(64 * 1024, 0x61), 'file.bin');
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    eventId = created.body.event.id;
    fileId = created.body.event.attachments[0].id;

    mall = await require('mall').getMall();
    originalGetAttachment = mall.events.getAttachment;
    mall.events.getAttachment = async function (...args) {
      if (sourceFactory != null) {
        // Keep the real file stream from leaking while a fake one is served.
        (await originalGetAttachment.apply(this, args)).destroy();
        return sourceFactory();
      }
      return originalGetAttachment.apply(this, args);
    };
    audit = require('audit').default;
    originalValidApiCall = audit.validApiCall;
  });

  after(async function () {
    if (mall != null) delete mall.events.getAttachment;
    if (audit != null) audit.validApiCall = originalValidApiCall;
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  beforeEach(function () {
    sourceFactory = null;
    rejections = [];
    process.on('unhandledRejection', onRejection);
  });

  afterEach(function () {
    process.removeListener('unhandledRejection', onRejection);
    audit.validApiCall = originalValidApiCall;
  });

  async function until (predicate, deadlineMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  async function auditCounts () {
    const auditStorage = require('storages').auditStorage;
    const userDb = await auditStorage.forUser(username);
    const events = await userDb.getEvents({ query: [] });
    const mine = events.filter((e) => e.content?.action === 'events.getAttachment');
    return {
      valid: mine.filter((e) => e.type === 'audit-log/pryv-api').length,
      error: mine.filter((e) => e.type === 'audit-log/pryv-api-error').length
    };
  }

  // Resolves with how the transfer ended from the client's side. `hung` means
  // neither 'end' nor an error arrived within the deadline.
  function download (deadlineMs = 3000) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome) => { if (!settled) { settled = true; clearTimeout(timer); req.destroy(); resolve(outcome); } };
      const timer = setTimeout(() => settle({ ending: 'hung' }), deadlineMs);
      const req = http.get({
        host: '127.0.0.1',
        port: global.coreServer.address().port,
        path: '/' + username + '/events/' + eventId + '/' + fileId,
        headers: { Authorization: token }
      });
      req.on('error', (err) => settle({ ending: 'error', code: err.code }));
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => settle({ ending: 'end', status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on('aborted', () => settle({ ending: 'aborted', status: res.statusCode }));
        res.on('error', (err) => settle({ ending: 'error', status: res.statusCode, code: err.code }));
      });
    });
  }

  it('[ATER1] a source error after bytes were sent cuts the transfer, audits the error, rejects nothing', async function () {
    sourceFactory = () => {
      let pushed = false;
      return new Readable({
        read () {
          if (pushed) return;
          pushed = true;
          this.push(Buffer.alloc(1024, 0x62));
          setTimeout(() => this.destroy(new Error('simulated read failure after the first chunk')), 20);
        }
      });
    };
    const before = await auditCounts();
    const outcome = await download();
    assert.notStrictEqual(outcome.ending, 'hung', 'the client must not be left waiting for bytes that will never come');
    assert.notStrictEqual(outcome.ending, 'end', 'a truncated transfer must not look complete: ' + JSON.stringify(outcome));
    assert.ok(await until(async () => (await auditCounts()).error === before.error + 1),
      'the failed download must be audited as an error exactly once');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterCounts = await auditCounts();
    assert.strictEqual(afterCounts.error, before.error + 1, 'no second error record');
    assert.strictEqual(afterCounts.valid, before.valid, 'no success record');
    assert.deepStrictEqual(rejections.map(String), [], 'no unhandled rejection');
  });

  it('[ATER2] a source error before any byte was sent answers with an error status and audits it', async function () {
    sourceFactory = () => new Readable({
      read () {
        process.nextTick(() => this.destroy(new Error('simulated open failure')));
      }
    });
    const before = await auditCounts();
    const outcome = await download();
    assert.strictEqual(outcome.ending, 'end', JSON.stringify(outcome));
    assert.strictEqual(outcome.status, 500);
    assert.ok(JSON.parse(outcome.body).error != null, 'the body must carry the API error');
    assert.ok(await until(async () => (await auditCounts()).error === before.error + 1),
      'the failed download must be audited as an error');
    assert.strictEqual((await auditCounts()).valid, before.valid, 'no success record');
    assert.deepStrictEqual(rejections.map(String), [], 'no unhandled rejection');
  });

  it('[ATER3] a failing success audit after the file was served rejects nothing', async function () {
    audit.validApiCall = async function () { throw new Error('simulated audit write failure'); };
    const outcome = await download();
    assert.strictEqual(outcome.ending, 'end', JSON.stringify(outcome));
    assert.strictEqual(outcome.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepStrictEqual(rejections.map(String), [], 'no unhandled rejection');
  });
});
