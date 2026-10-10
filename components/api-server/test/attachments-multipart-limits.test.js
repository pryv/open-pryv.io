/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const async = require('async');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./test-helpers');
const helpers = require('./helpers');
const { pollUntil } = require('test-helpers/src/pollUntil.ts');
const server = helpers.dependencies.instanceManager;
const testData = helpers.dynData({ prefix: 'mplm' });

// Multipart (attachment) requests may carry one non-file part (the JSON body)
// and at most `uploads.maxFiles` files; the files the parser writes to the
// temp directory are deleted once the request is over, whatever its outcome.
// The spawned server runs with small limits so they can be exercised cheaply;
// teardown restores the stock settings so following suites are unaffected.
const MAX_FILES = 3;
const LIMIT_MB = 1;

const UPLOAD_NAME = /^[0-9a-f]{32}$/;

function send (req) {
  return new Promise((resolve) => req.end(resolve));
}

/** A file body starting with a marker unique to the test, to find its temp copy. */
function markedFile () {
  const marker = 'upload-cleanup-' + crypto.randomBytes(8).toString('hex');
  return { marker, content: Buffer.concat([Buffer.from(marker), Buffer.alloc(1024, 0x61)]) };
}

/**
 * Temp-directory files with an upload name, recently modified, whose content
 * starts with `marker`. Other processes may use the same directory: the marker
 * keeps their files out of the count.
 */
function tempFilesWithMarker (marker, sinceMs) {
  const dir = os.tmpdir();
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    if (!UPLOAD_NAME.test(name)) continue;
    const filePath = path.join(dir, name);
    let fd = null;
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile() || stats.mtimeMs < sinceMs) continue;
      fd = fs.openSync(filePath, 'r');
      const head = Buffer.alloc(marker.length);
      const read = fs.readSync(fd, head, 0, marker.length, 0);
      if (read === marker.length && head.toString() === marker) found.push(filePath);
    } catch {
      // removed while scanning
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }
  return found;
}

async function assertNoTempFileLeft (marker, sinceMs) {
  const left = await pollUntil(async () => tempFilesWithMarker(marker, sinceMs), (files) => files.length === 0, { timeoutMs: 3000 });
  assert.deepStrictEqual(left, [], 'upload temp files must be removed once the request is over');
}

describe('[MPLM] multipart request limits and upload temp files', function () {
  this.timeout(30000);
  const user = structuredClone(testData.users[0]);
  const basePath = '/' + user.username + '/events';
  let request = null;
  let streamId = null;

  before(async function () {
    const settings = structuredClone(helpers.dependencies.settings);
    settings.uploads = settings.uploads || {};
    settings.uploads.maxSizeMb = LIMIT_MB;
    settings.uploads.maxFiles = MAX_FILES;
    await new Promise((resolve, reject) => async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetStreams
    ], (err) => err ? reject(err) : resolve()));
    await server.ensureStartedAsync(settings);
    request = helpers.request(server.url);
    await new Promise((resolve, reject) => request.login(user, (err) => err ? reject(err) : resolve()));
    streamId = testData.streams[0].id;
  });

  after(async function () {
    await server.ensureStartedAsync(helpers.dependencies.settings);
    await testData.cleanup();
  });

  function eventPart () {
    return JSON.stringify({ type: 'test/test', streamIds: [streamId] });
  }

  it('[MPLM1] must refuse two non-file parts with 400', async function () {
    const res = await send(request.post(basePath)
      .field('event', eventPart())
      .field('other', '{}'));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error.id, 'invalid-request-structure');
  });

  it('[MPLM2] must refuse a second non-file part before buffering it (400, not 413)', async function () {
    const res = await send(request.post(basePath)
      .field('event', eventPart())
      .field('padding', 'x'.repeat(2 * LIMIT_MB * 1024 * 1024)));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error.id, 'invalid-request-structure');
  });

  it('[MPLM3] must refuse more than uploads.maxFiles files with 400', async function () {
    let req = request.post(basePath).field('event', eventPart());
    for (let i = 0; i <= MAX_FILES; i++) req = req.attach('file' + i, Buffer.from('content ' + i), 'f' + i + '.txt');
    const res = await send(req);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error.id, 'invalid-request-structure');
  });

  it('[MPLM4] must accept exactly uploads.maxFiles files with 201', async function () {
    let req = request.post(basePath).field('event', eventPart());
    for (let i = 0; i < MAX_FILES; i++) req = req.attach('file' + i, Buffer.from('content ' + i), 'f' + i + '.txt');
    const res = await send(req);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.event.attachments.length, MAX_FILES);
  });

  it('[MPLM5] must remove the upload temp files after a successful events.create', async function () {
    const since = Date.now() - 2000;
    const { marker, content } = markedFile();
    const res = await send(request.post(basePath)
      .field('event', eventPart())
      .attach('file', content, 'marked.txt'));
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.event.attachments.length, 1);
    await assertNoTempFileLeft(marker, since);
  });

  it('[MPLM6] must remove the upload temp files after a successful events.update', async function () {
    const createRes = await send(request.post(basePath).field('event', eventPart()));
    assert.strictEqual(createRes.statusCode, 201);
    const since = Date.now() - 2000;
    const { marker, content } = markedFile();
    const res = await send(request.post(basePath + '/' + createRes.body.event.id)
      .attach('file', content, 'marked.txt'));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.event.attachments.length, 1);
    await assertNoTempFileLeft(marker, since);
  });

  it('[MPLM7] must remove the upload temp files when the method refuses the request (403)', async function () {
    const since = Date.now() - 2000;
    const { marker, content } = markedFile();
    const readOnlyToken = testData.accesses[2].token;
    const res = await send(request.post(basePath, readOnlyToken)
      .field('event', eventPart())
      .attach('file', content, 'marked.txt'));
    assert.strictEqual(res.statusCode, 403);
    await assertNoTempFileLeft(marker, since);
  });

  it('[MPLM8] must remove the upload temp files when a limit refuses the request', async function () {
    const since = Date.now() - 2000;
    const { marker, content } = markedFile();
    let req = request.post(basePath).field('event', eventPart());
    for (let i = 0; i <= MAX_FILES; i++) req = req.attach('file' + i, content, 'f' + i + '.txt');
    const res = await send(req);
    assert.strictEqual(res.statusCode, 400);
    await assertNoTempFileLeft(marker, since);
  });

  describe('[MPLD] without uploads.maxSizeMb configured', function () {
    const DEFAULT_MB = 50;

    before(async function () {
      const settings = structuredClone(helpers.dependencies.settings);
      settings.uploads = settings.uploads || {};
      settings.uploads.maxSizeMb = null;
      await server.ensureStartedAsync(settings);
      request = helpers.request(server.url);
      await new Promise((resolve, reject) => request.login(user, (err) => err ? reject(err) : resolve()));
    });

    it('[MPLD1] must still refuse an attachment over the default size with 413', async function () {
      const res = await send(request.post(basePath)
        .field('event', eventPart())
        .attach('file', Buffer.alloc(DEFAULT_MB * 1024 * 1024 + 1024, 0x61), 'big.bin'));
      assert.strictEqual(res.statusCode, 413);
      assert.strictEqual(res.body.error.id, 'payload-too-large');
      assert.strictEqual(res.body.error.data.limitMb, DEFAULT_MB);
    });
  });
});
