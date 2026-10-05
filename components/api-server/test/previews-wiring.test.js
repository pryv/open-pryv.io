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
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const superagent = require('superagent');
const helpers = require('./helpers');

const { DynamicInstanceManager } = helpers;
const server = helpers.dependencies.instanceManager;

/**
 * The previews dispatcher is wired into the api-server's request chain: a
 * preview URL sent to the api-server reaches the previews worker (here a
 * stub) at the worker's own path.
 */
describe('[PVW1] previews dispatcher wired into the api-server', function () {
  this.timeout(30_000);
  let upstream, manager, last;

  before(async function () {
    upstream = http.createServer((req, res) => {
      last = { url: req.url };
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end('jpeg-bytes');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    manager = new DynamicInstanceManager({
      serverFilePath: path.join(__dirname, '../bin/server'),
      workerPorts: { previewsPort: upstream.address().port }
    });
    await manager.ensureStartedAsync(helpers.dependencies.settings);
  });

  after(async function () {
    if (manager != null) await manager.stopAsync();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });

  it('[PVW2] /{user}/previews/events/{id} reaches the previews worker as /{user}/events/{id}', async function () {
    last = null;
    const res = await superagent.get(`${manager.url}/pvwuser/previews/events/ev1.jpg`)
      .query({ w: 64 })
      .ok(() => true);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'image/jpeg');
    assert.deepStrictEqual(last, { url: '/pvwuser/events/ev1.jpg?w=64' });
  });
});

/**
 * A test instance's worker ports never point at the instance itself: a
 * preview URL would otherwise be dispatched back to the same api-server and
 * answered by it. (An HF series URL looped the same way, but that loop also
 * ends in a 502, so it is not observable here.)
 */
describe('[PVW3] test instances do not dispatch worker paths to themselves', function () {
  this.timeout(30_000);

  before(async function () {
    await server.ensureStartedAsync(helpers.dependencies.settings);
  });

  it('[PVW4] a preview URL gets 502 (no previews worker), not the instance\'s own answer', async function () {
    const res = await superagent.get(`${server.url}/pvwuser/previews/events/ev1`).ok(() => true);
    assert.strictEqual(res.status, 502);
  });
});
