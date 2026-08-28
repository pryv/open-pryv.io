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

require('./test-helpers');
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const testData = helpers.dynData({ prefix: 'upsz' });

// `uploads.maxSizeMb` must bound uploaded attachments (and the multipart JSON
// part), not just plain JSON bodies. The spawned server is started with a 1 MB
// limit so oversized parts can be exercised cheaply; teardown restores the
// stock settings so following suites are unaffected.
const LIMIT_MB = 1;
const OVER_LIMIT = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2 MB > 1 MB limit
const UNDER_LIMIT = Buffer.alloc(100 * 1024, 0x61); // 100 KB

describe('[UPSZ] attachment upload size limit (uploads.maxSizeMb)', function () {
  const user = structuredClone(testData.users[0]);
  const basePath = '/' + user.username + '/events';
  let request = null;
  let streamId = null;

  before(function (done) {
    const settings = structuredClone(helpers.dependencies.settings);
    settings.uploads = settings.uploads || {};
    settings.uploads.maxSizeMb = LIMIT_MB;
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetStreams,
      server.ensureStarted.bind(server, settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      },
      function (stepDone) {
        streamId = testData.streams[0].id;
        stepDone();
      }
    ], done);
  });

  after(function (done) {
    // restore the stock server for subsequent suites
    async.series([
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) { testData.cleanup().then(() => stepDone()).catch(stepDone); }
    ], done);
  });

  it('[UPSZ1] must reject an oversized attachment on events.create with 413', function (finalDone) {
    request.post(basePath)
      .field('event', JSON.stringify({ type: 'test/test', streamIds: [streamId] }))
      .attach('file', OVER_LIMIT, 'big.bin')
      .end(function (res) {
        try {
          assert.strictEqual(res.statusCode, 413);
          assert.strictEqual(res.body.error.id, 'payload-too-large');
          assert.strictEqual(res.body.error.data.limitMb, LIMIT_MB);
          assert.ok(res.body.meta != null, 'response must carry the common meta');
          finalDone();
        } catch (e) { finalDone(e); }
      });
  });

  it('[UPSZ2] must accept an under-limit attachment on events.create with 201', function (finalDone) {
    request.post(basePath)
      .field('event', JSON.stringify({ type: 'test/test', streamIds: [streamId] }))
      .attach('file', UNDER_LIMIT, 'small.bin')
      .end(function (res) {
        try {
          assert.strictEqual(res.statusCode, 201);
          assert.strictEqual(res.body.event.attachments.length, 1);
          assert.strictEqual(res.body.event.attachments[0].size, UNDER_LIMIT.length);
          finalDone();
        } catch (e) { finalDone(e); }
      });
  });

  it('[UPSZ3] must reject an oversized attachment on events.update with 413', function (finalDone) {
    request.post(basePath)
      .field('event', JSON.stringify({ type: 'test/test', streamIds: [streamId] }))
      .attach('file', UNDER_LIMIT, 'small.bin')
      .end(function (createRes) {
        try {
          assert.strictEqual(createRes.statusCode, 201);
          const eventId = createRes.body.event.id;
          request.post(basePath + '/' + eventId)
            .attach('file', OVER_LIMIT, 'big.bin')
            .end(function (res) {
              try {
                assert.strictEqual(res.statusCode, 413);
                assert.strictEqual(res.body.error.id, 'payload-too-large');
                finalDone();
              } catch (e) { finalDone(e); }
            });
        } catch (e) { finalDone(e); }
      });
  });

  it('[UPSZ4] must reject an oversized multipart JSON part with 413', function (finalDone) {
    request.post(basePath)
      .field('event', JSON.stringify({ type: 'test/test', streamIds: [streamId] }))
      .field('padding', 'x'.repeat(2 * 1024 * 1024)) // > 1 MB field value
      .end(function (res) {
        try {
          assert.strictEqual(res.statusCode, 413);
          assert.strictEqual(res.body.error.id, 'payload-too-large');
          finalDone();
        } catch (e) { finalDone(e); }
      });
  });

  it('[UPSZ5] must keep an oversized plain JSON body at 400 invalid-request-structure', function (finalDone) {
    request.post(basePath)
      .send({ type: 'test/test', streamIds: [streamId], description: 'x'.repeat(2 * 1024 * 1024) })
      .end(function (res) {
        try {
          assert.strictEqual(res.statusCode, 400);
          assert.strictEqual(res.body.error.id, 'invalid-request-structure');
          finalDone();
        } catch (e) { finalDone(e); }
      });
  });
});
