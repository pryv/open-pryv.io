/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { hostWrongCoreGuard } = require('../src/routes/oauth2/hostWrongCore.ts');
const { configureTrustedProxies, currentTrustedProxies } = require('middleware/src/clientIp.ts');

/**
 * The /oauth2/token and /oauth2/authorize guard on an account's own host,
 * against an injected platform slice (the two-core suite covers it on real
 * cores).
 */
describe('[OTKW4] OAuth endpoints on an account\'s host: every placement outcome', function () {
  let server, port, platform, warnings;

  function stubPlatform (map, fail = false) {
    const calls = [];
    return {
      calls,
      isSingleCore: false,
      coreId: 'core-a',
      async getUserCore (username) {
        calls.push(username);
        if (fail) throw new Error('platform store down');
        return map[username] ?? null;
      },
      coreIdToUrl: (coreId) => coreId === 'core-nourl' ? 'null/' : 'https://' + coreId + '.example.com/'
    };
  }

  async function start (p) {
    platform = p;
    warnings = [];
    const addressing = { isPlatformRoutedLabel: (l) => l === 'reg', domain: 'example.com', retryAfterSeconds: 77, platform };
    const logger = { warn: (m) => warnings.push(m) };
    const app = express();
    app.post('/oauth2/token', hostWrongCoreGuard({ addressing, endpoint: 'token', logger }));
    app.get('/oauth2/authorize', hostWrongCoreGuard({ addressing, endpoint: 'authorize', logger }));
    app.all(/.*/, (req, res) => { res.status(299).end('handler'); });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }

  function call (method, path, host, extra = {}) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...extra } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      r.on('error', reject);
      r.end();
    });
  }

  afterEach(async function () {
    if (server != null) await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  it('[OTKW4] remote: 421 with coreUrl and Retry-After; no usable URL: 421 without coreUrl; lookup failure and this core: served; other domains and platform names: no lookup', async function () {
    await start(stubPlatform({ alice: 'core-a', bobby: 'core-b', carol: 'core-nourl' }));
    const remote = await call('POST', '/oauth2/token', 'bobby.example.com');
    assert.equal(remote.status, 421);
    assert.equal(remote.headers['retry-after'], '77');
    assert.deepEqual(JSON.parse(remote.body).coreUrl, 'https://core-b.example.com/');
    assert.equal(JSON.parse(remote.body).error, 'wrong_core');
    const page = await call('GET', '/oauth2/authorize', 'bobby.example.com');
    assert.equal(page.status, 421);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.equal(page.headers.location, undefined);
    const noUrl = await call('POST', '/oauth2/token', 'carol.example.com');
    assert.equal(noUrl.status, 421);
    assert.ok(!('coreUrl' in JSON.parse(noUrl.body)));
    assert.equal((await call('POST', '/oauth2/token', 'alice.example.com')).status, 299, 'this core');
    assert.equal((await call('POST', '/oauth2/token', 'nobody-known.example.com')).status, 299, 'unmapped');
    const before = platform.calls.length;
    for (const host of ['bobby.attacker.tld', 'bob.bobby.example.com', 'adapter.example.com', 'reg.example.com', 'example.com', '127.0.0.1']) {
      assert.equal((await call('POST', '/oauth2/token', host)).status, 299, host);
    }
    assert.equal(platform.calls.length, before, 'no lookup for a platform address');
    await new Promise((resolve) => server.close(resolve));
    await start(stubPlatform({}, true));
    assert.equal((await call('POST', '/oauth2/token', 'bobby.example.com')).status, 299, 'served on a lookup failure');
    assert.match(warnings.at(-1), /placement lookup failed/);
  });

  it('[OTKW5] the client-facing host decides: X-Forwarded-Host from a trusted proxy (the host the issuer reads), never from another peer', async function () {
    await start(stubPlatform({ alice: 'core-a', bobby: 'core-b' }));
    // A trusted proxy (loopback, the default list) that rewrote Host to the core's internal name.
    const internal = '127.0.0.1:' + port;
    const misrouted = await call('POST', '/oauth2/token', internal, { 'x-forwarded-host': 'bobby.example.com' });
    assert.equal(misrouted.status, 421);
    assert.equal(JSON.parse(misrouted.body).coreUrl, 'https://core-b.example.com/');
    assert.equal((await call('GET', '/oauth2/authorize', internal, { 'x-forwarded-host': 'bobby.example.com' })).status, 421);
    assert.equal((await call('POST', '/oauth2/token', internal, { 'x-forwarded-host': 'alice.example.com' })).status, 299, 'this core');
    // The forwarded host wins over Host when the peer is trusted.
    assert.equal((await call('POST', '/oauth2/token', 'alice.example.com', { 'x-forwarded-host': 'bobby.example.com' })).status, 421);
    const saved = currentTrustedProxies();
    configureTrustedProxies(['10.9.8.7']);
    try {
      assert.equal((await call('POST', '/oauth2/token', internal, { 'x-forwarded-host': 'bobby.example.com' })).status, 299, 'untrusted peer');
      assert.equal((await call('POST', '/oauth2/token', 'bobby.example.com', { 'x-forwarded-host': 'alice.example.com' })).status, 421, 'Host read');
    } finally {
      configureTrustedProxies(saved);
    }
  });
});
