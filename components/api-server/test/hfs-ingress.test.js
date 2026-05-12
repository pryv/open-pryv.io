/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert */

const http = require('http');
const { buildHfsIngress, isHfsPath } = require('../src/hfsIngress.ts');

describe('[HFSI] HFS in-process ingress dispatcher', function () {
  describe('[HF01] isHfsPath', function () {
    it('[HF1A] matches /<user>/events/<id>/series (dnsLess topology)', function () {
      assert.strictEqual(isHfsPath('/alice/events/cuid-xyz/series'), true);
      assert.strictEqual(isHfsPath('/alice/events/cuid-xyz/series?format=flatJSON'), true);
    });

    it('[HF1B] matches /<user>/series/batch (dnsLess topology)', function () {
      assert.strictEqual(isHfsPath('/alice/series/batch'), true);
      assert.strictEqual(isHfsPath('/alice/series/batch?foo=1'), true);
    });

    it('[HF1D] matches /events/<id>/series (subdomain-per-user topology, e.g. {user}.pryv.me)', function () {
      // The HFS server's subdomainToPath middleware extracts the
      // username from the Host header. The dispatcher must let these
      // through without requiring a user prefix in the URL.
      assert.strictEqual(isHfsPath('/events/cuid-xyz/series'), true);
      assert.strictEqual(isHfsPath('/events/cuid-xyz/series?foo=1'), true);
      assert.strictEqual(isHfsPath('/series/batch'), true);
    });

    it('[HF1C] does not match unrelated paths', function () {
      assert.strictEqual(isHfsPath('/alice/events'), false);
      assert.strictEqual(isHfsPath('/alice/events/cuid-xyz'), false);
      assert.strictEqual(isHfsPath('/alice/events/cuid-xyz/something-else'), false);
      assert.strictEqual(isHfsPath('/service/info'), false);
      assert.strictEqual(isHfsPath('/'), false);
      assert.strictEqual(isHfsPath('/alice/series'), false);
      assert.strictEqual(isHfsPath('/events'), false);
      assert.strictEqual(isHfsPath('/events/cuid-xyz'), false);
      // Tricky cases that should NOT route to HFS even if they look close
      assert.strictEqual(isHfsPath('/alice/events//series'), false); // missing eventId
      assert.strictEqual(isHfsPath('/events//series'), false); // missing eventId
    });
  });

  describe('[HF02] dispatch', function () {
    let upstream;
    let lastUpstreamReq = null;

    before(function (done) {
      upstream = http.createServer(function (req, res) {
        lastUpstreamReq = { method: req.method, url: req.url, headers: req.headers };
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          lastUpstreamReq.body = body;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: 'hfs-upstream' }));
        });
      });
      upstream.listen(0, '127.0.0.1', done);
    });

    after(function (done) { upstream.close(done); });

    beforeEach(function () { lastUpstreamReq = null; });

    function buildAndDispatch (path, fallback, cb) {
      const dispatcher = buildHfsIngress({
        hfsHost: '127.0.0.1',
        hfsPort: upstream.address().port,
        logger: { warn: () => {} }
      });
      const front = http.createServer((req, res) => dispatcher(req, res, fallback));
      front.listen(0, '127.0.0.1', function () {
        const port = front.address().port;
        const r = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: { 'content-type': 'application/json' }
        }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            front.close(() => cb(null, { status: res.statusCode, body }));
          });
        });
        r.on('error', (err) => front.close(() => cb(err)));
        r.end(JSON.stringify({ fields: ['t', 'v'], points: [[0, 1]] }));
      });
    }

    it('[HF2A] HFS path proxies to upstream (response body comes from upstream)', function (done) {
      const fallback = () => assert.fail('fallback must not be called for HFS path');
      buildAndDispatch('/alice/events/cuid-1/series', fallback, function (err, res) {
        if (err) return done(err);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(JSON.parse(res.body).ok, 'hfs-upstream');
        assert.ok(lastUpstreamReq, 'upstream must have received the request');
        assert.strictEqual(lastUpstreamReq.url, '/alice/events/cuid-1/series');
        assert.strictEqual(lastUpstreamReq.method, 'POST');
        done();
      });
    });

    it('[HF2B] non-HFS path falls through to express handler (upstream untouched)', function (done) {
      const fallback = function (req, res) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: 'express' }));
      };
      buildAndDispatch('/alice/events', fallback, function (err, res) {
        if (err) return done(err);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(JSON.parse(res.body).ok, 'express');
        assert.strictEqual(lastUpstreamReq, null, 'upstream must NOT receive the request');
        done();
      });
    });

    it('[HF2C] HFS path returns 502 when upstream is unreachable', function (done) {
      const fallback = () => assert.fail('fallback must not be called');
      const dispatcher = buildHfsIngress({
        hfsHost: '127.0.0.1',
        hfsPort: 1, // reserved/unbindable; connection refused
        logger: { warn: () => {} }
      });
      const front = http.createServer((req, res) => dispatcher(req, res, fallback));
      front.listen(0, '127.0.0.1', function () {
        const port = front.address().port;
        const r = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/alice/events/cuid-1/series'
        }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            front.close(() => {
              assert.strictEqual(res.statusCode, 502);
              const parsed = JSON.parse(body);
              assert.strictEqual(parsed.error.id, 'unexpected-error');
              done();
            });
          });
        });
        r.on('error', done);
        r.end('');
      });
    });
  });
});
