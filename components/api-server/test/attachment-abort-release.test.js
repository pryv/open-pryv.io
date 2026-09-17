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
const fs = require('node:fs');

// An attachment download whose client goes away must give the attachment's
// file descriptor back. The download pipes a file read stream into the HTTP
// response, and `.pipe()` does not forward destroy upstream: before the fix an
// abort left the read stream paused, unpiped and holding its fd for the life of
// the process, so enough aborted downloads exhaust the process fd limit.
//
// What is observed, and why:
// - `stream.closed` on the read stream the mall handed to the middleware. On a
//   file read stream 'close' is emitted only after the fd was closed, so this is
//   an assertion at the resource, not at the response.
// - the process fd count, as a cross-check that nothing else is left behind.
// - the attachment is 16 MiB. A file that fits in the loopback and socket
//   buffers is fully read before the abort lands and closes its fd unaided,
//   which makes the test pass against the leak. Keep it large.
// - the in-process core (not a spawned server), so the spy on the mall sees the
//   very stream the middleware pipes.
describe('[ATAB] attachment downloads release the file when the client goes away', function () {
  this.timeout(60_000);

  const SIZE = 16 * 1024 * 1024;

  let fixtures, mall, originalGetAttachment;
  let username, token, eventId, fileId;
  let captured = [];
  let gate = null;
  let onEntered = null;
  let uncaught = null;
  const onUncaught = (err) => { uncaught = err; };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'atab-' + cuid().slice(-8);
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: 'atab-files', name: 'atab-files' });

    const created = await coreRequest
      .post('/' + username + '/events')
      .set('Authorization', token)
      .field('event', JSON.stringify({ streamIds: ['atab-files'], type: 'file/attached' }))
      .attach('file', Buffer.alloc(SIZE, 0x61), 'big.bin');
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    eventId = created.body.event.id;
    fileId = created.body.event.attachments[0].id;

    mall = await require('mall').getMall();
    originalGetAttachment = mall.events.getAttachment;
    mall.events.getAttachment = async function (...args) {
      const stream = await originalGetAttachment.apply(this, args);
      captured.push(stream);
      if (onEntered != null) onEntered();
      if (gate != null) await gate;
      return stream;
    };
  });

  after(async function () {
    if (mall != null && originalGetAttachment != null) {
      mall.events.getAttachment = originalGetAttachment;
    }
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  beforeEach(function () {
    captured = [];
    gate = null;
    onEntered = null;
    uncaught = null;
    process.on('uncaughtException', onUncaught);
  });

  afterEach(function () {
    process.removeListener('uncaughtException', onUncaught);
  });

  async function until (predicate, deadlineMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  function deferred () {
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    return { promise, resolve: settle };
  }

  function rawGet () {
    return http.get({
      host: '127.0.0.1',
      port: global.coreServer.address().port,
      path: '/' + username + '/events/' + eventId + '/' + fileId,
      headers: { Authorization: token }
    });
  }

  // Resolves once the client has received the first body chunk and hung up.
  function abortOnFirstChunk () {
    return new Promise((resolve, reject) => {
      const req = rawGet();
      req.on('error', () => { /* the abort we caused */ });
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('expected 200, got ' + res.statusCode));
          return;
        }
        res.on('error', () => { /* the abort we caused */ });
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
    });
  }

  function fdCount () {
    return fs.readdirSync('/dev/fd').length;
  }

  it('[ATAB1] aborting mid-transfer closes the attachment file', async function () {
    await abortOnFirstChunk();
    assert.strictEqual(captured.length, 1);
    assert.ok(await until(() => captured[0].closed),
      'source fd must be released after the client aborted');
    assert.strictEqual(captured[0].destroyed, true);

    // Cross-check at the process level: repeated aborts leave no fd behind.
    await coreRequest.get('/' + username + '/events/' + eventId + '/' + fileId)
      .set('Authorization', token);
    await until(() => captured.every((s) => s.closed));
    const baseline = fdCount();
    for (let i = 0; i < 8; i++) {
      await abortOnFirstChunk();
    }
    assert.ok(await until(() => fdCount() <= baseline + 2),
      'fd count must return to baseline after 8 aborted downloads (baseline ' +
      baseline + ', now ' + fdCount() + ')');
    assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
  });

  it('[ATAB2] a client already gone when the file is opened gets nothing piped and the file is closed', async function () {
    const release = deferred();
    const entered = deferred();
    gate = release.promise;
    onEntered = entered.resolve;

    const req = rawGet();
    req.on('error', () => { /* the abort we caused */ });
    await entered.promise;
    req.destroy();
    // No server-side signal is observable from here, so give the server socket
    // time to see the close and mark the response destroyed before the stream
    // is released to the middleware. Loopback close delivery is sub-millisecond.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release.resolve();

    assert.strictEqual(captured.length, 1);
    assert.ok(await until(() => captured[0].closed),
      'source fd must be released when the client was gone before piping');
    assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
  });

  it('[ATAB3] an aborted download writes no audit record, a completed one writes one', async function () {
    const auditStorage = require('storages').auditStorage;
    if (auditStorage == null) { this.skip(); return; }
    const userDb = await auditStorage.forUser(username);
    async function counts () {
      const events = await userDb.getEvents({ query: [] });
      const mine = events.filter((e) => e.content?.action === 'events.getAttachment');
      return {
        valid: mine.filter((e) => e.type === 'audit-log/pryv-api').length,
        error: mine.filter((e) => e.type === 'audit-log/pryv-api-error').length
      };
    }

    const start = await counts();
    const full = await coreRequest.get('/' + username + '/events/' + eventId + '/' + fileId)
      .set('Authorization', token);
    assert.strictEqual(full.status, 200);
    // Proves the audit path is live, so the unchanged count below means something.
    assert.ok(await until(async () => (await counts()).valid === start.valid + 1),
      'a completed download must write exactly one valid audit record');

    const afterFull = await counts();
    await abortOnFirstChunk();
    assert.ok(await until(() => captured[captured.length - 1].closed),
      'source fd must be released after the client aborted');
    // Leave room for a late (wrong) audit write to land before counting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterAbort = await counts();
    assert.strictEqual(afterAbort.valid, afterFull.valid, 'an abort must not be audited as a success');
    assert.strictEqual(afterAbort.error, afterFull.error, 'an abort must not be audited as an error');
  });

  it('[ATAB4] a full download serves every byte and closes the file', async function () {
    const { status, length, header } = await new Promise((resolve, reject) => {
      const req = rawGet();
      req.on('error', reject);
      req.on('response', (res) => {
        let received = 0;
        res.on('data', (chunk) => { received += chunk.length; });
        res.on('end', () => resolve({
          status: res.statusCode,
          length: received,
          header: res.headers['content-length']
        }));
      });
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(length, SIZE);
    assert.strictEqual(header, String(SIZE));
    assert.ok(await until(() => captured[0].closed), 'source must be closed after a full download');
    assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
  });
});
