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
        logger: { warn: () => {}, debug: () => {} }
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
        logger: { warn: () => {}, debug: () => {} }
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

  // The proxy forwards two streams with different lifetimes: the client request
  // body to the worker, and the worker's answer back to the client. A client
  // going away, or a worker going silent, must reach the other side instead of
  // leaving a request half-open or a socket stalled.
  //
  // Everything runs in-process (fake worker, front server, raw clients) so each
  // resource is observed where it lives: the worker's request and socket, the
  // front's response, the dispatcher's log lines. Answers are 16 MiB: a small
  // answer fits in one socket read and is consumed even onto a closed response,
  // which would make the release tests pass against the leak. The fake worker
  // keeps idle sockets for 30 s, so only the proxy can close one within the 3 s
  // windows below.
  describe('[HIAB] client aborts and stalled workers', function () {
    this.timeout(20_000);

    const SIZE = 16 * 1024 * 1024;
    const HEAD = Buffer.alloc(64 * 1024, 0x61);

    let upstream, front, warns, debugs, uncaught, frontResClosed;
    let keepAliveAgent = null;
    const onUncaught = (err) => { uncaught = err; };

    beforeEach(function () {
      upstream = null;
      front = null;
      warns = [];
      debugs = [];
      uncaught = null;
      frontResClosed = false;
      process.on('uncaughtException', onUncaught);
    });

    afterEach(async function () {
      process.removeListener('uncaughtException', onUncaught);
      if (keepAliveAgent != null) {
        keepAliveAgent.destroy();
        keepAliveAgent = null;
      }
      for (const server of [front, upstream]) {
        if (server == null) continue;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    async function setup (upstreamHandler, dispatcherOpts = {}) {
      upstream = http.createServer(upstreamHandler);
      upstream.keepAliveTimeout = 30_000;
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const dispatcher = buildHfsIngress({
        hfsHost: '127.0.0.1',
        hfsPort: upstream.address().port,
        logger: { warn: (m) => warns.push(m), debug: (m) => debugs.push(m) },
        ...dispatcherOpts
      });
      front = http.createServer((req, res) => {
        res.once('close', () => { frontResClosed = true; });
        dispatcher(req, res, () => assert.fail('fallback must not be called for an HFS path'));
      });
      await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
    }

    // `agent: false` by default so the client never shares the pool the proxy
    // uses; that also sends `Connection: close`.
    function clientRequest (path, headers = {}, agent = false) {
      const req = http.request({
        host: '127.0.0.1',
        port: front.address().port,
        method: 'POST',
        path,
        headers,
        agent
      });
      req.on('error', () => { /* aborts caused by the test */ });
      return req;
    }

    // A worker answer that does not end on its own (a long streamed query): it
    // stops only when its socket closes. A finite answer is no good here, even a
    // large one: a proxy that ignores the client leaving still reads it to the
    // end into the void and frees the socket, so the test would pass unfixed.
    async function streamForever (req, res) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      while (!req.socket.destroyed) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            res.once('drain', resolve);
            req.socket.once('close', resolve);
          });
        }
      }
    }

    // Collects how the client's response went.
    function collect (req) {
      const outcome = { status: null, body: '', received: 0, ended: false, closed: false };
      req.on('response', (res) => {
        outcome.status = res.statusCode;
        res.on('data', (chunk) => {
          outcome.received += chunk.length;
          if (outcome.received <= 4096) outcome.body += chunk;
        });
        res.on('end', () => { outcome.ended = true; });
        res.on('error', () => { /* a cut response */ });
        res.on('close', () => { outcome.closed = true; });
      });
      return outcome;
    }

    async function until (predicate, deadlineMs = 3000) {
      const started = Date.now();
      while (Date.now() - started < deadlineMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return false;
    }

    it('[HIAB1] a client that goes away mid-upload reaches the worker promptly', async function () {
      const worker = { req: null, bytes: 0, reqClosed: false };
      await setup((req, res) => {
        worker.req = req;
        req.on('data', (chunk) => { worker.bytes += chunk.length; });
        req.once('close', () => { worker.reqClosed = true; });
        req.on('end', () => res.end());
      });
      const client = clientRequest('/alice/series/batch', { 'content-length': SIZE });
      client.write(HEAD);
      assert.ok(await until(() => worker.bytes > 0), 'the first bytes must cross the proxy');
      client.destroy();
      assert.ok(await until(() => worker.reqClosed),
        'the worker must see the aborted upload promptly, not at its request timeout');
      assert.strictEqual(worker.req.complete, false);
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
    });

    it('[HIAB2] a client already gone when the worker answers gets nothing piped and the worker socket is released', async function () {
      const worker = { ended: false, req: null, held: null, socketClosed: false };
      await setup((req, res) => {
        req.socket.once('close', () => { worker.socketClosed = true; });
        req.resume();
        req.on('end', () => { worker.ended = true; worker.req = req; worker.held = res; });
      });
      const client = clientRequest('/alice/events/cuid-1/series', { 'content-type': 'application/json' });
      client.end('{}');
      assert.ok(await until(() => worker.ended), 'the worker must receive the request');
      client.destroy();
      assert.ok(await until(() => frontResClosed), 'the front must see the client leave');
      streamForever(worker.req, worker.held);
      assert.ok(await until(() => worker.socketClosed),
        'the worker socket must close promptly when the client left before the answer');
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
      assert.deepStrictEqual(warns, []);
    });

    it('[HIAB3] a client that goes away mid-answer releases the worker socket', async function () {
      const worker = { socketClosed: false };
      await setup((req, res) => {
        req.socket.once('close', () => { worker.socketClosed = true; });
        req.resume();
        req.on('end', () => { streamForever(req, res); });
      });
      const client = clientRequest('/alice/events/cuid-1/series', { 'content-type': 'application/json' });
      client.on('response', (res) => {
        res.on('error', () => { /* the abort we caused */ });
        res.once('data', () => client.destroy());
      });
      client.end('{}');
      assert.ok(await until(() => worker.socketClosed),
        'the worker socket must close promptly when the client stopped reading the answer');
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
      assert.deepStrictEqual(warns, []);
    });

    it('[HIAB4] the proxy\'s own teardown is not reported as a worker failure', async function () {
      const worker = { bytes: 0, reqClosed: false };
      await setup((req, res) => {
        req.on('data', (chunk) => { worker.bytes += chunk.length; });
        req.once('close', () => { worker.reqClosed = true; });
        req.on('end', () => res.end());
      });
      const client = clientRequest('/alice/series/batch', { 'content-length': SIZE });
      client.write(HEAD);
      assert.ok(await until(() => worker.bytes > 0));
      client.destroy();
      assert.ok(await until(() => worker.reqClosed));
      assert.ok(await until(() => debugs.length + warns.length >= 1, 1000),
        'the request-side teardown must surface on the upstream request as socket hang up');
      assert.deepStrictEqual(warns, [], 'a teardown the proxy caused itself must not be logged as a worker failure');
      assert.strictEqual(debugs.length, 1);
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
    });

    it('[HIAB5] an early worker answer reaches the client intact while the upload is still arriving', async function () {
      // A worker may answer before reading the body (an access refused on a
      // large batch). Node's HTTP server then closes that connection, so the
      // rest of the upload cannot reach the worker whatever the proxy does; what
      // the proxy owes is the answer itself, whole, and no false alarm.
      await setup((req, res) => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"error":{"id":"forbidden"}}');
      });
      keepAliveAgent = new http.Agent({ keepAlive: true });
      const client = clientRequest('/alice/series/batch', { 'content-length': SIZE }, keepAliveAgent);
      const outcome = collect(client);
      client.write(HEAD);
      assert.ok(await until(() => outcome.ended), 'the early answer must reach the client');
      assert.strictEqual(outcome.status, 403);
      assert.strictEqual(JSON.parse(outcome.body).error.id, 'forbidden');
      client.end(Buffer.alloc(SIZE - HEAD.length, 0x62));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepStrictEqual(warns, []);
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
    });

    it('[HIAB6] a worker that never answers yields 504 and releases the worker socket', async function () {
      const worker = { socketClosed: false };
      await setup((req) => {
        req.socket.once('close', () => { worker.socketClosed = true; });
        req.resume();
      }, { upstreamIdleTimeoutMs: 200 });
      const client = clientRequest('/alice/events/cuid-1/series', { 'content-type': 'application/json' });
      const outcome = collect(client);
      client.end('{}');
      assert.ok(await until(() => outcome.ended), 'the client must get an answer instead of waiting on a silent worker');
      assert.strictEqual(outcome.status, 504);
      assert.strictEqual(JSON.parse(outcome.body).error.id, 'unexpected-error');
      assert.ok(await until(() => worker.socketClosed), 'the worker socket must be released');
      assert.strictEqual(warns.length, 1);
      assert.match(warns[0], /upstream idle for 200 ms/);
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
    });

    it('[HIAB7] a timeout is reported once and its own teardown is not a second failure', async function () {
      await setup((req) => { req.resume(); }, { upstreamIdleTimeoutMs: 200 });
      const client = clientRequest('/alice/events/cuid-1/series', { 'content-type': 'application/json' });
      const outcome = collect(client);
      client.end('{}');
      assert.ok(await until(() => outcome.ended));
      await until(() => debugs.length >= 1, 1000);
      assert.strictEqual(warns.length, 1, 'a timeout must be logged once; the socket hang up it causes is not a worker failure');
      assert.strictEqual(debugs.length, 1);
      assert.strictEqual(outcome.status, 504);
      assert.strictEqual(JSON.parse(outcome.body).error.message, 'HFS upstream timed out');
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
    });

    it('[HIAB8] a worker that stalls mid-answer ends the client response instead of leaving it open', async function () {
      const worker = { socketClosed: false };
      await setup((req, res) => {
        req.socket.once('close', () => { worker.socketClosed = true; });
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': SIZE });
          res.write(HEAD);
        });
      }, { upstreamIdleTimeoutMs: 200 });
      const client = clientRequest('/alice/events/cuid-1/series', { 'content-type': 'application/json' });
      const outcome = collect(client);
      client.end('{}');
      assert.ok(await until(() => outcome.closed), 'a stalled answer must be ended, not left open');
      assert.ok(outcome.received < SIZE);
      assert.strictEqual(warns.length, 1);
      assert.ok(await until(() => worker.socketClosed), 'the worker socket must be released');
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
    });

    it('[HIAB9] a slow but flowing answer is not cut (idle time, not a total budget)', async function () {
      const CHUNK = 1024 * 1024;
      await setup((req, res) => {
        req.resume();
        req.on('end', async () => {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 16 * CHUNK });
          for (let i = 0; i < 16; i++) {
            res.write(Buffer.alloc(CHUNK, 0x61));
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          res.end();
        });
      }, { upstreamIdleTimeoutMs: 200 });
      const client = clientRequest('/alice/events/cuid-1/series', { 'content-type': 'application/json' });
      const outcome = collect(client);
      client.end('{}');
      assert.ok(await until(() => outcome.ended, 5000), 'a flowing answer must complete');
      assert.strictEqual(outcome.received, 16 * CHUNK);
      assert.deepStrictEqual(warns, []);
      assert.strictEqual(uncaught, null, uncaught && uncaught.stack);
    });
  });
});
