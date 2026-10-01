/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

require('./test-helpers');
const helpers = require('./helpers');
const { DynamicInstanceManager } = require('test-helpers');
const testData = helpers.dynData({ prefix: 'hsbt' });

/**
 * Hosted sites through the real api-server (bin/server, the same Server class
 * the cores run): the site answers on its Host, the API keeps answering on the
 * others, and a site that cannot be served stops the boot.
 */

const DOMAIN = 'hsbt.test';

function get (baseUrl, reqPath, host) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: url.hostname, port: url.port, path: reqPath, headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('[HSBT] hosted sites served by the real api-server', function () {
  this.timeout(60000);
  let tmp, siteRoot, manager;

  function settingsWith (hostedSites) {
    const settings = structuredClone(helpers.dependencies.settings);
    settings.dnsLess = Object.assign({}, settings.dnsLess, { isActive: false });
    settings.dns = Object.assign({}, settings.dns, { domain: DOMAIN });
    settings.hostedSites = hostedSites;
    return settings;
  }

  before(async function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsbt-'));
    siteRoot = path.join(tmp, 'site');
    fs.mkdirSync(siteRoot);
    fs.writeFileSync(path.join(siteRoot, 'index.html'), '<p>hosted home</p>');
    await testData.resetUsers();
    manager = new DynamicInstanceManager({ serverFilePath: path.join(__dirname, '../bin/server') });
  });

  after(async function () {
    if (manager != null) await manager.stopAsync();
    fs.rmSync(tmp, { recursive: true, force: true });
    await testData.cleanup();
  });

  it('[HSB1] serves the site on its Host and leaves the API untouched on the others', async function () {
    await manager.ensureStartedAsync(settingsWith({ sitehome: { static: siteRoot } }));
    const site = await get(manager.url, '/', 'sitehome.' + DOMAIN);
    assert.equal(site.status, 200);
    assert.equal(site.body, '<p>hosted home</p>');
    assert.equal(site.headers['x-content-type-options'], 'nosniff');
    assert.equal(site.headers['api-version'], undefined);
    const api = await get(manager.url, '/service/info', 'reg.' + DOMAIN);
    assert.equal(api.status, 200);
    assert.ok(api.headers['api-version'], 'the API still answers');
    assert.ok(JSON.parse(api.body).api != null);
    // Documented limitation: Socket.IO takes /socket.io/ before any other
    // handler, on every Host (its engine re-orders the server's listeners)
    const sio = await get(manager.url, '/socket.io/?EIO=4&transport=polling', 'sitehome.' + DOMAIN);
    assert.match(sio.body, /^0\{"sid":/, 'answered by Socket.IO (an Engine.IO handshake), not by the site');
    assert.equal(sio.headers['referrer-policy'], undefined, 'no site header on the Socket.IO answer');
    assert.equal(sio.headers['x-content-type-options'], 'nosniff', 'Socket.IO answers carry nosniff too');
    await manager.stopAsync();
  });

  it('[HSB2] refuses to start when a user already holds a site name', async function () {
    const username = testData.users[0].username;
    assert.match(username, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    await assert.rejects(
      () => manager.ensureStartedAsync(settingsWith({ [username]: { static: siteRoot } })),
      /Server failed/
    );
  });

  it('[HSB3] refuses to start when a static folder is missing or has no index.html', async function () {
    await assert.rejects(
      () => manager.ensureStartedAsync(settingsWith({ sitehome: { static: path.join(tmp, 'missing') } })),
      /Server failed/
    );
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    await assert.rejects(
      () => manager.ensureStartedAsync(settingsWith({ sitehome: { static: empty } })),
      /Server failed/
    );
  });
});
