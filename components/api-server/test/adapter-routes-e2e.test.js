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
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const cuid = require('cuid');

require('./test-helpers');
const helpers = require('./helpers');
const { DynamicInstanceManager } = require('test-helpers');
const testData = helpers.dynData({ prefix: 'adre' });

/**
 * Adapter routes through the real api-server (bin/server, the same Server
 * class the cores run): the route's prefixes go to the sidecar on every host,
 * in both topologies, untouched by the API middleware; everything else is
 * still the API.
 */

const DOMAIN = 'adre.test';
const UPSTREAM_CORS = {
  'access-control-allow-origin': 'https://app.example',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600'
};

function call (baseUrl, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const allHeaders = Object.assign({}, headers);
    if (body != null) allHeaders['content-length'] = Buffer.byteLength(body);
    const r = http.request({ host: url.hostname, port: url.port, method, path: reqPath, headers: allHeaders }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

function accessControlOf (headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('access-control-')));
}

describe('[ADRE] adapter routes served by the real api-server', function () {
  this.timeout(60000);
  let upstream, seen, manager, tmp, siteRoot;

  function settingsWith ({ dnsLess }) {
    const settings = structuredClone(helpers.dependencies.settings);
    if (dnsLess) {
      settings.dnsLess = Object.assign({}, settings.dnsLess, { isActive: true, publicUrl: 'http://' + DOMAIN + '/' });
    } else {
      settings.dnsLess = Object.assign({}, settings.dnsLess, { isActive: false });
      settings.dns = Object.assign({}, settings.dns, { domain: DOMAIN });
      settings.hostedSites = { sitehome: { static: siteRoot } };
    }
    settings.adapterRoutes = {
      calendar: {
        upstream: 'http://127.0.0.1:' + upstream.address().port,
        paths: ['/.well-known/oauth-protected-resource/adapter/calendar/']
      }
    };
    return settings;
  }

  before(async function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adre-'));
    siteRoot = path.join(tmp, 'site');
    fs.mkdirSync(siteRoot);
    fs.writeFileSync(path.join(siteRoot, 'index.html'), '<p>hosted home</p>');
    seen = [];
    upstream = http.createServer((req, res) => {
      const record = { method: req.method, url: req.url, headers: req.headers };
      seen.push(record);
      req.resume();
      req.on('end', () => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, Object.assign({ vary: 'Origin' }, UPSTREAM_CORS));
          res.end();
          return;
        }
        if (req.url.endsWith('/protected')) {
          res.writeHead(401, { 'www-authenticate': 'Bearer realm="x", error="invalid_token"', 'content-type': 'application/json' });
          res.end('{"error":"invalid_token"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ upstream: true, url: req.url }));
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    await testData.resetUsers();
    manager = new DynamicInstanceManager({ serverFilePath: path.join(__dirname, '../bin/server') });
  });

  after(async function () {
    if (manager != null) await manager.stopAsync();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
    await testData.cleanup();
  });

  describe('[ADRE1] dnsLess', function () {
    before(async function () {
      await manager.ensureStartedAsync(settingsWith({ dnsLess: true }));
    });
    after(async function () {
      await manager.stopAsync();
    });

    it('[ADRE01] the route prefixes go to the upstream; the core\'s own .well-known and a user\'s API stay the core\'s', async function () {
      for (const p of ['/adapter/calendar/api/v1?x=1', '/adapter/calendar', '/.well-known/oauth-protected-resource/adapter/calendar/api']) {
        const res = await call(manager.url, { path: p });
        assert.equal(res.status, 200, p);
        assert.deepEqual(JSON.parse(res.body), { upstream: true, url: p }, p);
      }
      const count = seen.length;
      const asMetadata = await call(manager.url, { path: '/.well-known/oauth-authorization-server' });
      assert.ok(!asMetadata.body.includes('"upstream"'), 'answered by the core');
      const user = testData.users[0].username;
      const api = await call(manager.url, { path: '/' + user + '/events' });
      assert.ok(api.headers['api-version'], 'the API answers the user path');
      assert.ok([401, 403].includes(api.status), String(api.status));
      assert.equal(seen.length, count, 'neither reached the upstream');
    });

    it('[ADRE05a] "adapter" cannot be registered; another name can', async function () {
      // insurancenumber and phoneNumber: the custom account fields of the test configuration
      const body = (username) => JSON.stringify({ username, password: 'adre-pass-123', email: username + '@adre.test', appId: 'adre-test', insurancenumber: '123', phoneNumber: '456' });
      const ok = 'adre' + cuid.slug().toLowerCase();
      const created = await call(manager.url, { method: 'POST', path: '/users', headers: { 'content-type': 'application/json' }, body: body(ok) });
      assert.equal(created.status, 201, created.body);
      const refused = await call(manager.url, { method: 'POST', path: '/users', headers: { 'content-type': 'application/json' }, body: body('adapter') });
      assert.equal(refused.status, 409, refused.body);
      assert.equal(JSON.parse(refused.body).error.id, 'item-already-exists');
      const { getUsersRepository } = require('business/src/users/index.ts');
      const repo = await getUsersRepository();
      const userId = await repo.getUserIdForUsername(ok);
      if (userId != null) await repo.deleteOne(userId, ok);
    });
  });

  describe('[ADRE2] DNS topology', function () {
    before(async function () {
      await manager.ensureStartedAsync(settingsWith({ dnsLess: false }));
    });
    after(async function () {
      await manager.stopAsync();
    });

    it('[ADRE02] the route answers on every host, a hosted site\'s included; the site keeps its own paths', async function () {
      for (const host of ['alice.' + DOMAIN, 'core.' + DOMAIN, 'reg.' + DOMAIN, 'sitehome.' + DOMAIN, DOMAIN]) {
        const res = await call(manager.url, { path: '/adapter/calendar/x', headers: { host } });
        assert.equal(res.status, 200, host);
        assert.deepEqual(JSON.parse(res.body), { upstream: true, url: '/adapter/calendar/x' }, host);
        assert.equal(seen.at(-1).headers.host, host, 'the Host is forwarded');
        assert.equal(seen.at(-1).headers['x-forwarded-host'], host);
      }
      const site = await call(manager.url, { path: '/', headers: { host: 'sitehome.' + DOMAIN } });
      assert.equal(site.status, 200);
      assert.equal(site.body, '<p>hosted home</p>');
    });

    it('[ADRE03] the core adds no CORS nor API headers on adapter answers; it still does on its own', async function () {
      const res = await call(manager.url, { path: '/adapter/calendar/x', headers: { origin: 'https://app.example', host: 'alice.' + DOMAIN } });
      assert.equal(res.status, 200);
      assert.deepEqual(accessControlOf(res.headers), {});
      assert.equal(res.headers['api-version'], undefined);
      assert.equal(res.headers['x-content-type-options'], undefined);
      const info = await call(manager.url, { path: '/service/info', headers: { origin: 'https://app.example', host: 'reg.' + DOMAIN } });
      assert.equal(info.status, 200);
      assert.ok(info.headers['api-version']);
      assert.equal(info.headers['access-control-allow-origin'], 'https://app.example');
    });

    it('[ADRE04] no Authorization needed: the upstream\'s 401 challenge and its answer to a preflight come back untouched', async function () {
      const challenge = await call(manager.url, { path: '/adapter/calendar/protected', headers: { host: 'alice.' + DOMAIN } });
      assert.equal(challenge.status, 401);
      assert.equal(challenge.headers['www-authenticate'], 'Bearer realm="x", error="invalid_token"');
      assert.equal(challenge.body, '{"error":"invalid_token"}');
      assert.equal(seen.at(-1).headers.authorization, undefined);

      const preflight = await call(manager.url, {
        method: 'OPTIONS',
        path: '/adapter/calendar/api',
        headers: {
          host: 'alice.' + DOMAIN,
          origin: 'https://app.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type'
        }
      });
      assert.equal(preflight.status, 204);
      assert.deepEqual(accessControlOf(preflight.headers), UPSTREAM_CORS);
      assert.equal(preflight.headers.vary, 'Origin');
      assert.equal(preflight.headers['api-version'], undefined);
      const forwarded = seen.at(-1);
      assert.equal(forwarded.method, 'OPTIONS');
      assert.equal(forwarded.url, '/adapter/calendar/api');
      assert.equal(forwarded.headers.origin, 'https://app.example');
      assert.equal(forwarded.headers['access-control-request-method'], 'POST');
      assert.equal(forwarded.headers['access-control-request-headers'], 'authorization, content-type');
    });

    it('[ADRE06] /socket.io/ stays Socket.IO\'s; a WebSocket upgrade on a route is not forwarded and its socket is closed', async function () {
      const sio = await call(manager.url, { path: '/socket.io/?EIO=4&transport=polling', headers: { host: 'alice.' + DOMAIN } });
      assert.match(sio.body, /^0\{"sid":/, 'an Engine.IO handshake');
      const count = seen.length;
      const url = new URL(manager.url);
      const closed = await new Promise((resolve) => {
        const socket = net.connect(Number(url.port), url.hostname, () => {
          socket.write('GET /adapter/calendar/ws HTTP/1.1\r\nHost: alice.' + DOMAIN + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        });
        let answer = '';
        socket.on('data', (c) => { answer += c; });
        socket.on('error', () => {});
        socket.on('close', () => resolve({ answer }));
        setTimeout(() => { socket.destroy(); resolve(null); }, 5000);
      });
      assert.ok(closed != null, 'the socket was closed by the server');
      assert.ok(!closed.answer.startsWith('HTTP/1.1 101'), 'no upgrade');
      assert.equal(seen.length, count, 'the upgrade did not reach the upstream');
    });
  });

  // Last, after the suites above have started the same settings without the account.
  describe('[ADRE3] boot refusal', function () {
    it('[ADRE05b] a core with adapter routes refuses to start while a user is named "adapter"', async function () {
      const { getUsersRepository, User } = require('business/src/users/index.ts');
      const repo = await getUsersRepository();
      const template = testData.users[0];
      const id = cuid();
      // The child writes warn+ lines synchronously here (logs:fileSync).
      const syncLog = path.join(__dirname, '../var-pryv/logs/test-sync.log');
      const logSize = fs.existsSync(syncLog) ? fs.statSync(syncLog).size : 0;
      await repo.insertOne(new User({ id, username: 'adapter', password: template.password, email: 'adapter-' + id + '@adre.test' }), false, true);
      try {
        await assert.rejects(() => manager.ensureStartedAsync(settingsWith({ dnsLess: true })), /Server failed/);
        const written = fs.readFileSync(syncLog).subarray(logSize).toString();
        assert.match(written, /Adapter routes cannot be served: adapterRoutes: a user named \\"adapter\\" exists; rename that user/);
      } finally {
        await repo.deleteOne(id, 'adapter');
      }
      // The same settings start once the account is gone.
      await manager.ensureStartedAsync(settingsWith({ dnsLess: true }));
      await manager.stopAsync();
    });
  });
});
