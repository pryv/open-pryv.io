/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const should = require('chai').should(); /* eslint-disable-line */

const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const async = require('async');
const errors = require('errors');
const fs = require('fs');
const bluebird = require('bluebird');
const gm = require('gm');
const { assert } = require('chai');
const storage = helpers.dependencies.storage;
const testData = helpers.data;
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const superagent = require('superagent');
const { getMall } = require('mall');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');

describe('event previews', function () {
  const user = structuredClone(testData.users[0]);
  const token = testData.accesses[2].token;
  const basePath = '/' + user.username + '/events';
  let request = null;
  let mall = null;

  before(async function () {
    await SystemStreamsSerializer.init();
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
      testData.resetAttachments,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        stepDone();
      }
    ], done);
  });

  describe('GET /<event id>/preview', function () {
    beforeEach(function () {
      storage.user.eventFiles.removeAllPreviews();
    });

    it('[NRT9] must return JPEG previews for "picture/attached" events and cache the result',
      async function () {
        const request = helpers.request(server.url);
        const event = testData.events[2];

        const res = await request.get(path(event.id), token);
        await checkSizeFits(res.body, {}, { width: 256, height: 256 });

        res.statusCode.should.eql(200);
        res.header['content-type'].should.eql('image/jpeg');

        const eventFiles = storage.user.eventFiles;
        const cachedPath = eventFiles.getPreviewPath(user, event.id, 256);

        const modified = await xattr.get(cachedPath, 'user.pryv.eventModified');

        modified.toString().should.eql(event.modified.toString());
      });

    it('[FEWU] must accept ".jpg" extension in the path (backwards-compatibility)', function (done) {
      const event = testData.events[2];
      request
        .get(path(event.id) + '.jpg', token)
        .end(function (res) {
          res.statusCode.should.eql(200);
          done();
        });
    });

    it('[PBC1] must adjust the desired size to the bigger standard size (if exists)', async function () {
      const request = helpers.request(server.url);
      const event = testData.events[2];

      const res = await request.get(path(event.id), token).query({ h: 280 });

      await checkSizeFits(res.body, { height: 280 }, { width: 512, height: 512 });

      res.statusCode.should.eql(200);
      res.header['content-type'].should.eql('image/jpeg');
    });

    it('[415L] must limit the desired size to the biggest standard size if too big', async function () {
      const request = helpers.request(server.url);
      const event = testData.events[2];

      // due to the test image's aspect ratio, the height will exceed the biggest dimension (1024)
      const res = await request
        .get(path(event.id), token)
        .query({ width: 280 });

      await checkSizeFits(res.body, { width: 280 }, { width: 1024, height: 1024 });

      res.statusCode.should.eql(200);
      res.header['content-type'].should.eql('image/jpeg');
    });

    /**
     * @param res Must be raw HTTP request (not superagent's wrapper)
     * @param {Object} minTargetSize Can be empty or partially defined
     * @param {Object} maxTargetSize
     * @param done
     */
    async function checkSizeFits (imageBuffer, minTargetSize, maxTargetSize) {
      const size = await bluebird.fromCallback(
        (cb) => gm(imageBuffer).size({ bufferStream: true }, cb));

      assert.isAtLeast(size.width, minTargetSize.width || 0);
      assert.isAtMost(size.width, maxTargetSize.width);

      assert.isAtLeast(size.height, minTargetSize.height || 0);
      assert.isAtMost(size.height, maxTargetSize.height);

      assert.isTrue(
        size.width === maxTargetSize.width || size.height === maxTargetSize.height,
        'Either dimension needs to be maxed out.'
      );
    }

    it('[CWTQ] must serve the cached file if available', function (done) {
      const event = testData.events[2];
      let cachedPath, cachedStats;
      async.series([
        function retrieveInitialPreview (stepDone) {
          request.get(path(event.id), token).end(function (res) {
            res.statusCode.should.eql(200);
            cachedPath = storage.user.eventFiles.getPreviewPath(user, event.id, 256);
            cachedStats = fs.statSync(cachedPath);
            stepDone();
          });
        },
        function retrieveAgain (stepDone) {
          request.get(path(event.id), token).end(function (res) {
            res.statusCode.should.eql(200);

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
          const res = await bluebird.fromCallback(cb => request.get(path(eventId), token).end((res) => {
            cb(null, res);
          }));
          res.statusCode.should.eql(200);
          cachedPath = storage.user.eventFiles.getPreviewPath(user, event.id, 256);
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
          const res = await bluebird.fromCallback(cb => request.get(path(event.id), token).end((res) => {
            cb(null, res);
          }));
          res.statusCode.should.eql(200);
          let modified = await xattr.get(cachedPath, 'user.pryv.eventModified');
          modified = modified.toString();
          modified.should.not.eql(cachedFileModified);
          modified.should.eql(updatedEvent.modified.toString());
        }
      ], done);
    });

    it('[7Y91] must respond with "no content" if the event type is not supported', function (done) {
      request.get(path(testData.events[1].id), token).end(function (res) {
        res.statusCode.should.eql(204);
        done();
      });
    });

    it('[61N8] must return a proper error if the event does not exist', function (done) {
      request.get(path('unknown-event'), token).end(function (res) {
        res.statusCode.should.eql(404);
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
        res.statusCode.should.eql(403);
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
            res.statusCode.should.eql(422);
            res.body.error.id.should.eql(errors.ErrorIds.CorruptedData);
            stepDone();
          });
        }
      ], done);
    });

    it('[DQF6] must return a proper error if event data is corrupted (no attached file)', function (done) {
      const event = testData.events[2];
      const filePath = storage.user.eventFiles.getAttachmentPath(user.id, event.id, event.attachments[0].id);
      const tempPath = filePath + '_bak';
      async.series([
        function removeFile (stepDone) {
          fs.rename(filePath, tempPath, stepDone);
        },
        function getPreview (stepDone) {
          request.get(path(event.id), token).end(function (res) {
            res.statusCode.should.eql(422);
            res.body.error.id.should.eql(errors.ErrorIds.CorruptedData);
            stepDone();
          });
        },
        function restoreFile (stepDone) {
          fs.rename(tempPath, filePath, stepDone);
        }
      ], done);
    });

    it('[GSDF] must work with animated GIFs too', function (done) {
      const event = testData.events[12];
      request.get(path(event.id), token).end(function (res) {
        res.statusCode.should.eql(200);
        done();
      });
    });
  });

  describe('POST /clean-up-cache', function () {
    const basePath = '/' + user.username + '/clean-up-cache';

    it('[FUYE] must clean up cached previews not accessed for one week by default', function (done) {
      const event = testData.events[2];
      let aCachedPath, anotherCachedPath;
      async.series([
        async function retrieveAPreview () {
          const res = await bluebird.fromCallback(cb => request.get(path(event.id), token).end((res) => {
            cb(null, res);
          }));
          res.statusCode.should.eql(200);
          aCachedPath = storage.user.eventFiles.getPreviewPath(user, event.id, 256);
          // add delay as the attribute is written after the response is sent
          setTimeout(
            async function () {
              const lastAccessed = await xattr.get(aCachedPath, 'user.pryv.lastAccessed');
              assert.isNotNull(lastAccessed);
            }, 50);
        },
        async function retrieveAnotherPreview () {
          const res = await bluebird.fromCallback(cb => request.get(path(event.id), token).query({ h: 511 }).end((res) => {
            cb(null, res);
          }));
          assert.strictEqual(res.statusCode, 200);
          anotherCachedPath = storage.user.eventFiles.getPreviewPath(user, event.id, 512);
          await xattr.get(anotherCachedPath, 'user.pryv.lastAccessed');
        },
        async function hackLastAccessTime () {
          const twoWeeksAgo = timestamp.now('-2w');
          await xattr.set(aCachedPath, 'user.pryv.lastAccessed', twoWeeksAgo.toString());
        },
        async function cleanupCache () {
          const res = await bluebird.fromCallback(cb => request.post(basePath, token).end((res) => {
            cb(null, res);
          }));
          assert.strictEqual(res.statusCode, 200);
          await xattr.get(aCachedPath, 'user.pryv.lastAccessed');
          const lastAccessed = await xattr.get(anotherCachedPath, 'user.pryv.lastAccessed');
          assert.isNotNull(lastAccessed);
        }
      ], done);
    });

    it('[G5JR] must ignore files with no readable extended attribute', async function () {
      const event = testData.events[2];
      const resGet = await bluebird.fromCallback(cb => request.get(path(event.id), token).end((res) => {
        cb(null, res);
      }));

      resGet.statusCode.should.eql(200);
      const cachedPath = storage.user.eventFiles.getPreviewPath(user, event.id, 256);

      const lastAccessed = await xattr.get(cachedPath, 'user.pryv.lastAccessed');
      assert.isNotNull(lastAccessed);
      await xattr.remove(cachedPath, 'user.pryv.lastAccessed');

      const resPost = await bluebird.fromCallback(cb => request.post(basePath, token).end((res) => {
        cb(null, res);
      }));

      resPost.statusCode.should.eql(200);
      const stat = fs.statSync(cachedPath);
      assert.isNotNull(stat);
    });
  });
});
