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
const http = require('node:http');
const sharp = require('sharp');
const assert = require('node:assert');
const testData = helpers.data;
const { buildPreviewsIngress } = require('api-server/src/previewsIngress.ts');

// The public preview URL, through the API port's previews dispatcher, reaches
// the real previews worker and returns the image. The dispatcher sits in front
// of a bare server here (not an api-server test instance, whose previews port
// points at itself).
describe('[PVE2] previews through the public-port dispatcher', function () {
  this.timeout(20_000);
  const user = structuredClone(testData.users[0]);
  const token = testData.accesses[2].token;
  const event = testData.events[2]; // picture/attached
  let front;

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetEvents,
      server.ensureStarted.bind(server, helpers.dependencies.settings)
    ], done);
  });

  before(async function () {
    const workerPort = Number(new URL(server.url).port);
    const dispatch = buildPreviewsIngress({
      previewsHost: '127.0.0.1',
      previewsPort: workerPort,
      usernameInHost: false,
      logger: { warn: () => {}, debug: () => {} }
    });
    front = http.createServer((req, res) => dispatch(req, res, (req2, res2) => {
      res2.writeHead(404);
      res2.end();
    }));
    await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  });

  after(async function () {
    if (front == null) return;
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
  });

  function get (path) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: front.address().port, method: 'GET', path, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  for (const suffix of ['', '.jpg']) {
    it(`[PVE${suffix === '' ? '3' : '4'}] /{user}/previews/events/{id}${suffix} returns the JPEG preview`, async function () {
      const res = await get(`/${user.username}/previews/events/${event.id}${suffix}?w=64&auth=${token}`);
      assert.strictEqual(res.status, 200, res.body.toString().slice(0, 200));
      assert.strictEqual(res.type, 'image/jpeg');
      const meta = await sharp(res.body).metadata();
      // w=64 is served at the smallest standard width, aspect ratio kept.
      assert.strictEqual(meta.width, 256, `${meta.width}x${meta.height}`);
    });
  }

  it('[PVE5] the worker\'s own answer comes back for a refused access', async function () {
    const res = await get(`/${user.username}/previews/events/${event.id}?auth=not-a-token`);
    assert.ok(res.status === 401 || res.status === 403, String(res.status));
    assert.match(res.body.toString(), /invalid-access-token/);
  });
});
