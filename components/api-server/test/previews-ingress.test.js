/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const http = require('node:http');
const { buildPreviewsIngress, previewsTarget } = require('../src/previewsIngress.ts');
const { redactUrl } = require('../src/workerIngress.ts');

// Image previews are served by an internal worker; the public port must route
// the preview URL to it (as it routes HF series to the HFS worker), or a core
// that terminates TLS itself answers 404 to every preview.
describe('[PVI] previews in-process dispatcher', function () {
  describe('[PVI1] previewsTarget', function () {
    const dnsLess = { usernameInHost: false };
    const inHost = { usernameInHost: true };

    it('[PVIA] dnsLess: /{user}/previews/events/{id} -> /{user}/events/{id}, extension and query kept', function () {
      assert.strictEqual(previewsTarget('/alice/previews/events/ev1', dnsLess), '/alice/events/ev1');
      assert.strictEqual(previewsTarget('/alice/previews/events/ev1.jpg?w=256&auth=t', dnsLess), '/alice/events/ev1.jpg?w=256&auth=t');
      assert.strictEqual(previewsTarget('/alice/previews/events/ev1.jpeg', dnsLess), '/alice/events/ev1.jpeg');
    });

    it('[PVIB] dnsLess: the user segment is required (a user named `previews` keeps its own API)', function () {
      assert.strictEqual(previewsTarget('/previews/events/ev1', dnsLess), null);
    });

    it('[PVIC] username in host: the unprefixed form too, worker path without user', function () {
      assert.strictEqual(previewsTarget('/previews/events/ev1?w=64', inHost), '/events/ev1?w=64');
      assert.strictEqual(previewsTarget('/alice/previews/events/ev1', inHost), '/alice/events/ev1');
    });

    it('[PVID] everything else is not a preview URL', function () {
      for (const url of ['/alice/events/ev1', '/alice/events/ev1.jpg', '/alice/previews/events/',
        '/alice/previews/events/ev1/x', '/alice/previews/clean-up-cache', '/previews/clean-up-cache',
        '/previews/', '/alice/previews', '/alice/events/ev1/series']) {
        assert.strictEqual(previewsTarget(url, inHost), null, url);
        assert.strictEqual(previewsTarget(url, dnsLess), null, url);
      }
    });

    it('[PVIE] logged URLs never carry the access token', function () {
      assert.strictEqual(redactUrl('/alice/previews/events/ev1?w=64&auth=secret-token'), '/alice/previews/events/ev1?w=64&auth=***');
      assert.strictEqual(redactUrl('/a?auth=x&w=1'), '/a?auth=***&w=1');
      assert.strictEqual(redactUrl('/a?w=1'), '/a?w=1');
    });
  });

  describe('[PVI2] dispatch', function () {
    let upstream, front, last, warns;
    const upstreamHandler = (req, res) => {
      last = { method: req.method, url: req.url, headers: req.headers };
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end('jpeg-bytes');
    };

    async function setup (opts = {}, handler = upstreamHandler) {
      warns = [];
      last = null;
      upstream = http.createServer(handler);
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const dispatch = buildPreviewsIngress({
        previewsHost: '127.0.0.1',
        previewsPort: opts.port ?? upstream.address().port,
        usernameInHost: opts.usernameInHost ?? false,
        logger: { warn: (m) => warns.push(m), debug: () => {} },
        upstreamIdleTimeoutMs: opts.upstreamIdleTimeoutMs
      });
      front = http.createServer((req, res) => dispatch(req, res, (req2, res2) => {
        res2.writeHead(299, { 'content-type': 'text/plain' });
        res2.end('fallback');
      }));
      await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
    }

    afterEach(async function () {
      for (const server of [front, upstream]) {
        if (server == null) continue;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      front = upstream = null;
    });

    function get (path, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: front.address().port, method: 'GET', path, headers, agent: false }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    it('[PVIF] a preview URL reaches the worker at its own path, with the client Host', async function () {
      await setup();
      const res = await get('/alice/previews/events/ev1.jpg?w=64&auth=tok', { host: 'core.example.com' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.type, 'image/jpeg');
      assert.strictEqual(last.url, '/alice/events/ev1.jpg?w=64&auth=tok');
      assert.strictEqual(last.headers.host, 'core.example.com');
    });

    it('[PVIG] the worker gets the resolved client address, not the client\'s own header', async function () {
      await setup();
      await get('/alice/previews/events/ev1', { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });
      assert.strictEqual(last.headers['x-forwarded-for'], '203.0.113.7');
    });

    it('[PVIH] username in host: the unprefixed URL reaches the worker without user segment', async function () {
      await setup({ usernameInHost: true });
      await get('/previews/events/ev1?w=64', { host: 'alice.pryv.test' });
      assert.strictEqual(last.url, '/events/ev1?w=64');
      assert.strictEqual(last.headers.host, 'alice.pryv.test');
    });

    it('[PVII] anything else falls through, the worker untouched', async function () {
      await setup();
      const res = await get('/alice/events/ev1');
      assert.strictEqual(res.status, 299);
      assert.strictEqual(last, null);
    });

    it('[PVIJ] an unreachable worker: 502, and the logged URL hides the token', async function () {
      // A port that was just released: nothing listens there.
      const probe = http.createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const deadPort = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      await setup({ port: deadPort });
      const res = await get('/alice/previews/events/ev1?auth=secret-token');
      assert.strictEqual(res.status, 502);
      assert.match(res.body, /Previews upstream unreachable/);
      assert.ok(warns.length > 0 && warns.every((w) => !w.includes('secret-token')), JSON.stringify(warns));
      assert.ok(warns.some((w) => w.includes('auth=***')), JSON.stringify(warns));
    });

    it('[PVIK] a silent worker: 504 after the idle window', async function () {
      await setup({ upstreamIdleTimeoutMs: 300 }, () => { /* never answers */ });
      const res = await get('/alice/previews/events/ev1');
      assert.strictEqual(res.status, 504);
      assert.match(res.body, /Previews upstream timed out/);
    });
  });
});
