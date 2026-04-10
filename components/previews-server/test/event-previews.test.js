/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const async = require('async');
const errors = require('errors');
const fs = require('fs');
const sharp = require('sharp');
const assert = require('node:assert');
const testData = helpers.data;
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const superagent = require('superagent');
const { getMall } = require('mall');
const attachmentManagement = require('../src/attachmentManagement');

describe('[EP01] event previews', function () {
  const user = structuredClone(testData.users[0]);
  const token = testData.accesses[2].token;
  const basePath = '/' + user.username + '/events';
  let request = null;
  let mall = null;

  before(async function () {
    mall = await getMall();
  });

  function path (id) {
    return basePath + '/' + id;
  }

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetEvents,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        stepDone();
      }
    ], done);
  });

  describe('[EP02] GET /<event id>/preview', function () {
    beforeEach(function () {
      attachmentManagement.removeAllPreviews();
    });

    it('[NRT9] must return JPEG previews for "picture/attached" events and cache the result',
      async function () {
        const request = helpers.request(server.url);
        const event = testData.events[2];

        const res = await request.get(path(event.id), token);
        await checkSizeFits(res.body, {}, { width: 256, height: 256 });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.header['content-type'], 'image/jpeg');

        const cachedPath = attachmentManagement.getPreviewPath(user, event.id, 256);

        const modified = await xattr.get(cachedPath, 'user.pryv.eventModified');

        assert.strictEqual(modified.toString(), event.modified.toString());
      });

    it('[FEWU] must accept ".jpg" extension in the path (backwards-compatibility)', function (done) {
      const event = testData.events[2];
      request
        .get(path(event.id) + '.jpg', token)
        .end(function (res) {
          assert.strictEqual(res.statusCode, 200);
          done();
        });
    });

    it('[PBC1] must adjust the desired size to the bigger standard size (if exists)', async function () {
      const request = helpers.request(server.url);
      const event = testData.events[2];

      const res = await request.get(path(event.id), token).query({ h: 280 });

      await checkSizeFits(res.body, { height: 280 }, { width: 512, height: 512 });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.header['content-type'], 'image/jpeg');
    });

    it('[415L] must limit the desired size to the biggest standard size if too big', async function () {
      const request = helpers.request(server.url);
      const event = testData.events[2];

      // due to the test image's aspect ratio, the height will exceed the biggest dimension (1024)
      const res = await request
        .get(path(event.id), token)
        .query({ width: 280 });

      await checkSizeFits(res.body, { width: 280 }, { width: 1024, height: 1024 });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.header['content-type'], 'image/jpeg');
    });

    /**
     * @param res Must be raw HTTP request (not superagent's wrapper)
     * @param {Object} minTargetSize Can be empty or partially defined
     * @param {Object} maxTargetSize
     * @param done
     */
    async function checkSizeFits (imageBuffer, minTargetSize, maxTargetSize) {
      const size = await sharp(imageBuffer).metadata();

      assert.ok(size.width >= (minTargetSize.width || 0));
      assert.ok(size.width <= maxTargetSize.width);

      assert.ok(size.height >= (minTargetSize.height || 0));
      assert.ok(size.height <= maxTargetSize.height);

      assert.strictEqual(
        size.width === maxTargetSize.width || size.height === maxTargetSize.height,
        true,
        'Either dimension needs to be maxed out.'
      );
    }

    it('[CWTQ] must serve the cached file if available', function (done) {
      const event = testData.events[2];
      let cachedPath, cachedStats;
      async.series([
        function retrieveInitialPreview (stepDone) {
          request.get(path(event.id), token).end(function (res) {
            assert.strictEqual(res.statusCode, 200);
            cachedPath = attachmentManagement.getPreviewPath(user, event.id, 256);
            cachedStats = fs.statSync(cachedPath);
            stepDone();
          });
        },
        function retrieveAgain (stepDone) {
          request.get(path(event.id), token).end(function (res) {
            assert.strictEqual(res.statusCode, 200);

            const newStats = fs.statSync(cachedPath);

            // The file should not have been recreated. By comparing ino and
            // birthtimeMs, we assume that the file is the same.
            assert.strictEqual(newStats.ino, cachedStats.ino);
            assert.strictEqual(newStats.birthtimeMs, cachedStats.birthtimeMs);

            stepDone();
          });
        }
      ], done);
    });

    it('[2MME] must regenerate the cached file if obsolete', function (done) {
      const eventId = testData.events[2].id;
      let event;
      let cachedPath, cachedFileModified, updatedEvent;
      async.series([
        async function retrieveEvent () {
          event = await mall.events.getOne(user.id, eventId);
        },
        async function retrieveInitialPreview () {
          const res = await new Promise((resolve) => request.get(path(eventId), token).end((res) => resolve(res)));
          assert.strictEqual(res.statusCode, 200);
          cachedPath = attachmentManagement.getPreviewPath(user, event.id, 256);
          const modified = await xattr.get(cachedPath, 'user.pryv.eventModified');
          cachedFileModified = modified.toString();
        },
        async function updateEvent () {
          Object.assign(event, {
            description: 'Updated',
            modified: timestamp.now(),
            modifiedBy: testData.accesses[2].id
          });
          updatedEvent = await mall.events.update(user.id, event);
        },
        async function retrieveAgain () {
          const res = await new Promise((resolve) => request.get(path(event.id), token).end((res) => resolve(res)));
          assert.strictEqual(res.statusCode, 200);
          let modified = await xattr.get(cachedPath, 'user.pryv.eventModified');
          modified = modified.toString();
          assert.notStrictEqual(modified, cachedFileModified);
          assert.strictEqual(modified, updatedEvent.modified.toString());
        }
      ], done);
    });

    it('[7Y91] must respond with "no content" if the event type is not supported', function (done) {
      request.get(path(testData.events[1].id), token).end(function (res) {
        assert.strictEqual(res.statusCode, 204);
        done();
      });
    });

    it('[61N8] must return a proper error if the event does not exist', function (done) {
      request.get(path('unknown-event'), token).end(function (res) {
        assert.strictEqual(res.statusCode, 404);
        done();
      });
    });

    it('[VIJO] must forbid requests missing an access token', function (done) {
      const url = new URL(path(testData.events[2].id), server.url).toString();
      superagent.get(url).end((res) => {
        assert.strictEqual(res.status, 401);
        done();
      });
    });

    it('[FAK4] must forbid requests with unauthorized accesses', function (done) {
      const unauthToken = testData.accesses[3].token;
      request.get(path(testData.events[2].id), unauthToken).end(function (res) {
        assert.strictEqual(res.statusCode, 403);
        done();
      });
    });

    it('[QUM3] must return a proper error if event data is corrupted (no attachment object)', (done) => {
      const data = { streamIds: [testData.streams[2].id], type: 'picture/attached' };
      let createdEvent;
      async.series([
        function addCorruptEvent (stepDone) {
          mall.events.create(user.id, data).then((event) => {
            createdEvent = event;
            stepDone();
          }, stepDone);
        },
        function getPreview (stepDone) {
          request.get(path(createdEvent.id), token).end(function (res) {
            assert.strictEqual(res.statusCode, 422);
            assert.strictEqual(res.body.error.id, errors.ErrorIds.CorruptedData);
            stepDone();
          });
        }
      ], done);
    });

    it('[GSDF] must work with animated GIFs too', function (done) {
      const event = testData.events[12];
      request.get(path(event.id), token).end(function (res) {
        assert.strictEqual(res.statusCode, 200);
        done();
      });
    });
  });

  describe('[EP03] POST /clean-up-cache', function () {
    const basePath = '/' + user.username + '/clean-up-cache';

    it('[FUYE] must clean up cached previews not accessed for one week by default', function (done) {
      const event = testData.events[2];
      let aCachedPath, anotherCachedPath;
      async.series([
        async function retrieveAPreview () {
          const res = await new Promise((resolve) => request.get(path(event.id), token).end((res) => resolve(res)));
          assert.strictEqual(res.statusCode, 200);
          aCachedPath = attachmentManagement.getPreviewPath(user, event.id, 256);
          // add delay as the attribute is written after the response is sent
          setTimeout(
            async function () {
              const lastAccessed = await xattr.get(aCachedPath, 'user.pryv.lastAccessed');
              assert.ok(lastAccessed);
            }, 50);
        },
        async function retrieveAnotherPreview () {
          const res = await new Promise((resolve) => request.get(path(event.id), token).query({ h: 511 }).end((res) => resolve(res)));
          assert.strictEqual(res.statusCode, 200);
          anotherCachedPath = attachmentManagement.getPreviewPath(user, event.id, 512);
          await xattr.get(anotherCachedPath, 'user.pryv.lastAccessed');
        },
        async function hackLastAccessTime () {
          const twoWeeksAgo = timestamp.now('-2w');
          await xattr.set(aCachedPath, 'user.pryv.lastAccessed', twoWeeksAgo.toString());
        },
        async function cleanupCache () {
          const res = await new Promise((resolve) => request.post(basePath, token).end((res) => resolve(res)));
          assert.strictEqual(res.statusCode, 200);
          // Old preview (2 weeks ago) should have been deleted
          assert.ok(!fs.existsSync(aCachedPath), 'Old preview should be deleted');
          // Recent preview should still exist
          const lastAccessed = await xattr.get(anotherCachedPath, 'user.pryv.lastAccessed');
          assert.ok(lastAccessed);
        }
      ], done);
    });

    it('[G5JR] must ignore files with no readable extended attribute', async function () {
      const event = testData.events[2];
      const resGet = await new Promise((resolve) => request.get(path(event.id), token).end((res) => resolve(res)));

      assert.strictEqual(resGet.statusCode, 200);
      const cachedPath = attachmentManagement.getPreviewPath(user, event.id, 256);

      const lastAccessed = await xattr.get(cachedPath, 'user.pryv.lastAccessed');
      assert.ok(lastAccessed);
      await xattr.remove(cachedPath, 'user.pryv.lastAccessed');

      const resPost = await new Promise((resolve) => request.post(basePath, token).end((res) => resolve(res)));

      assert.strictEqual(resPost.statusCode, 200);
      const stat = fs.statSync(cachedPath);
      assert.ok(stat);
    });
  });
});
