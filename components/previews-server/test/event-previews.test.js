/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const async = require('async');
const errors = require('errors');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const sharp = require('sharp');
const assert = require('node:assert');
const testData = helpers.data;
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const superagent = require('superagent');
const { getMall } = require('mall');
const attachmentManagement = require('../src/attachmentManagement.ts');

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

    it('[SVGB] must not decode an SVG attachment (answered as unsupported data, never rasterized)', async function () {
      // SVG goes through librsvg; the worker blocks those loaders, so a valid
      // SVG gets the same answer as any other format it cannot preview.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">' +
        '<rect width="40" height="20" fill="red"/></svg>';
      const file = nodePath.join(os.tmpdir(), 'previews-svgb-' + process.pid + '.svg');
      fs.writeFileSync(file, svg);
      try {
        const event = await mall.events.createWithAttachments(user.id,
          { streamIds: [testData.streams[2].id], type: 'picture/attached' },
          [{ fileName: 'drawing.svg', type: 'image/svg+xml', size: Buffer.byteLength(svg), attachmentData: fs.createReadStream(file) }]);
        const res = await request.get(path(event.id), token);
        assert.strictEqual(res.statusCode, 422);
        assert.strictEqual(res.body.error.id, errors.ErrorIds.CorruptedData);
        assert.notStrictEqual(res.header['content-type'], 'image/jpeg');
      } finally {
        fs.unlinkSync(file);
      }
    });

    it('[PVPT] preview paths never leave the user\'s previews directory', async function () {
      for (const eventId of ['../escape', 'a/b', '..']) {
        assert.throws(() => attachmentManagement.getPreviewPath(user, eventId, 256), /Invalid previews path segment/, eventId);
        await assert.rejects(() => attachmentManagement.ensurePreviewPath(user, eventId, 256), /Invalid previews path segment/, eventId);
      }
      assert.ok(attachmentManagement.getPreviewPath(user, 'an-event-id', 256).endsWith('256.jpg'));
    });

    it('[GSDF] must work with animated GIFs too', function (done) {
      const event = testData.events[12];
      request.get(path(event.id), token).end(function (res) {
        assert.strictEqual(res.statusCode, 200);
        done();
      });
    });
  });

  describe('[PVX0] previews apply the events.get exclusions', function () {
    const starReadToken = testData.accesses[2].token; // shared, `*` read
    const starNoneToken = 'pvx-' + Date.now() + '-token';
    const starNoneAccessId = 'pvx-' + Date.now();
    const created = [];
    let storageLayer = null;

    async function createPicture (event) {
      const image = testData.attachments.image;
      const now = timestamp.now();
      const tracking = { time: now, created: now, createdBy: 'test', modified: now, modifiedBy: 'test' };
      const ev = await mall.events.createWithAttachments(user.id, { ...tracking, ...event },
        [{ fileName: 'picture.png', type: image.type, size: image.size, attachmentData: fs.createReadStream(image.path) }]);
      created.push(ev);
      return ev;
    }
    function getPreview (id, authToken) {
      return superagent.get(server.url + path(id)).set('Authorization', authToken).ok(() => true);
    }

    before(async function () {
      storageLayer = await require('storage').getStorageLayer();
      await new Promise((resolve, reject) => storageLayer.accesses.insertOne(user, {
        id: starNoneAccessId,
        token: starNoneToken,
        name: 'pvx star read, child none',
        type: 'app',
        permissions: [{ streamId: '*', level: 'read' }, { streamId: testData.streams[0].children[0].id, level: 'none' }],
        created: timestamp.now(),
        createdBy: 'test',
        modified: timestamp.now(),
        modifiedBy: 'test'
      }, (err) => err ? reject(err) : resolve()));
    });

    after(async function () {
      for (const ev of created) {
        try { await mall.events.delete(user.id, ev); } catch (_e) { /* best-effort */ }
      }
      await new Promise((resolve) => storageLayer.accesses.removeOne(user, { id: starNoneAccessId }, () => resolve()));
    });

    it('[PVX1] refuses the preview of an emails container item to a star read token', async function () {
      // carries the account's own address, so the platform cross-check stays consistent
      const ev = await createPicture({ streamIds: [':_emails:'], type: 'picture/attached', content: { value: user.email } });
      const denied = await getPreview(ev.id, starReadToken);
      assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
      const plain = await createPicture({ streamIds: [testData.streams[0].id], type: 'picture/attached' });
      const allowed = await getPreview(plain.id, starReadToken);
      assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    });

    it('[PVX2] refuses the preview of an event that has a stream the token is denied', async function () {
      const ev = await createPicture({ streamIds: [testData.streams[0].id, testData.streams[0].children[0].id], type: 'picture/attached' });
      const denied = await getPreview(ev.id, starNoneToken);
      assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
      const plain = await createPicture({ streamIds: [testData.streams[0].id], type: 'picture/attached' });
      const allowed = await getPreview(plain.id, starNoneToken);
      assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    });
  });

  describe('[EP03] POST /clean-up-cache', function () {
    const basePath = '/' + user.username + '/clean-up-cache';
    const adminKey = helpers.dependencies.settings.auth.adminAccessKey;

    it('[EPCK] is refused (unknown resource) without the admin key, user token or none', async function () {
      const sameLengthWrongKey = adminKey.slice(0, -1) + (adminKey.endsWith('x') ? 'y' : 'x');
      for (const auth of [token, undefined, adminKey + 'x', sameLengthWrongKey, 'Bearer ' + adminKey]) {
        const req = superagent.post(server.url + basePath).ok(() => true);
        if (auth != null) req.set('Authorization', auth);
        const res = await req;
        assert.strictEqual(res.status, 404, 'auth ' + auth);
        assert.strictEqual(res.body.error?.id, errors.ErrorIds.UnknownResource);
      }
      // the key in the query string (accepted by the API's auth reader) is not enough here
      const viaQuery = await superagent.post(server.url + basePath).query({ auth: adminKey }).ok(() => true);
      assert.strictEqual(viaQuery.status, 404);
      const res = await superagent.post(server.url + '/clean-up-cache').ok(() => true);
      assert.strictEqual(res.status, 404);
    });

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
          const res = await new Promise((resolve) => request.post(basePath, adminKey).end((res) => resolve(res)));
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

      const resPost = await new Promise((resolve) => request.post(basePath, adminKey).end((res) => resolve(res)));

      assert.strictEqual(resPost.statusCode, 200);
      const stat = fs.statSync(cachedPath);
      assert.ok(stat);
    });
  });
});

describe('[EP04] previews cache clean-up', function () {
  const os = require('node:os');
  const nodePath = require('node:path');
  const Cache = require('../src/cache.ts').default;

  function recordingLogger () {
    const calls = [];
    const record = (level) => (msg) => calls.push({ level, msg });
    return { calls, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  }

  let tmpDir;
  before(function () {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'previews-cache-'));
  });
  after(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[K7NQ] must treat a missing previews folder as nothing to clean', async function () {
    const logger = recordingLogger();
    const cache = new Cache({ rootPath: nodePath.join(tmpDir, 'never-created'), maxAge: 1, logger });
    await cache.cleanUp();
    assert.strictEqual(cache.cleanUpInProgress, false);
    assert.deepStrictEqual(logger.calls.filter((c) => c.level !== 'debug'), []);
  });

  it('[W3ZD] must still fail on other errors reading the previews folder', async function () {
    const notADir = nodePath.join(tmpDir, 'a-file');
    fs.writeFileSync(notADir, 'x');
    const cache = new Cache({ rootPath: notADir, maxAge: 1, logger: recordingLogger() });
    await assert.rejects(() => cache.cleanUp(), { code: 'ENOTDIR' });
    assert.strictEqual(cache.cleanUpInProgress, false);
  });
});
