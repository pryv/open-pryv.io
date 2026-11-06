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
const https = require('node:https');
const net = require('node:net');
const { buildAdapterIngress, attachAdapterContinueCheck } = require('../src/adapterIngress.ts');
const { describeAdapterRoutes } = require('business/src/adapterRoutes.ts');
const { configureTrustedProxies, currentTrustedProxies } = require('middleware/src/clientIp.ts');

/**
 * The adapter routes dispatcher against a fake upstream (a local HTTP server)
 * and a front server, as the HFS dispatcher tests do.
 */

const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function routesOf (adapterRoutes) {
  const r = describeAdapterRoutes({ adapterRoutes, domain: 'pryv.test', dnsLessActive: false });
  assert.deepEqual(r.problems, []);
  return r.routes;
}

function listen (server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server)));
}

function close (server) {
  if (server == null) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * A fake upstream that records every request it receives (method, url,
 * headers, body, whether the body completed) and answers with `handler`
 * (default: 200 JSON echo).
 */
function fakeUpstream (handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const record = { method: req.method, url: req.url, headers: req.headers, body: '', complete: false, closed: null };
    seen.push(record);
    record.closed = new Promise((resolve) => req.once('close', () => resolve()));
    record.resClosed = new Promise((resolve) => res.once('close', () => resolve(res.writableFinished)));
    if (handler != null) { handler(req, res, record); return; }
    req.on('data', (c) => { record.body += c; });
    req.on('end', () => {
      record.complete = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ upstream: true, url: req.url }));
    });
  });
  return { server, seen };
}

/** One request; resolves { status, headers, rawHeaders, body }. */
function request (port, { method = 'GET', path = '/', headers = {}, body, chunks, tls = false, onContinue } = {}) {
  return new Promise((resolve, reject) => {
    const transport = tls ? https : http;
    const r = transport.request({ host: '127.0.0.1', port, method, path, headers, ...(tls ? { rejectUnauthorized: false } : {}) }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(parts).toString() }));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (onContinue != null) {
      r.on('continue', () => onContinue(r));
      return;
    }
    if (chunks != null) {
      (async () => {
        for (const c of chunks) {
          if (r.destroyed) return;
          r.write(c);
          await sleep(20);
        }
        r.end();
      })();
      return;
    }
    r.end(body);
  });
}

/**
 * Sends `text` as is on a new connection; resolves with what came back once
 * the server has answered (or closed) and `settleMs` passed.
 */
function rawRequest (port, text, settleMs = 300) {
  return new Promise((resolve, reject) => {
    let answer = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.on('data', (c) => { answer += c; });
    socket.on('error', reject);
    let done = false;
    const finish = () => { if (done) return; done = true; socket.destroy(); resolve(answer); };
    socket.on('close', () => setTimeout(finish, settleMs));
    const timer = setInterval(() => {
      if (/^HTTP\/1\.1 \d{3}/.test(answer) && answer.includes('\r\n\r\n')) { clearInterval(timer); setTimeout(finish, settleMs); }
    }, 20);
    setTimeout(() => { clearInterval(timer); finish(); }, 5000);
  });
}

/** A self-signed certificate valid for the IP 127.0.0.1 (no DNS name). */
function ipCertificate () {
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 3600000);
  const subject = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keyPem: forge.pki.privateKeyToPem(keys.privateKey), certPem: forge.pki.certificateToPem(cert) };
}

describe('[ADRI] adapter routes in-process dispatcher', function () {
  this.timeout(10000);
  const savedTrust = currentTrustedProxies();
  let upstream, front, frontPort, fallbackCalls;

  async function setup (handler, routeExtra = {}, opts = {}) {
    upstream = fakeUpstream(handler);
    await listen(upstream.server);
    const up = 'http://127.0.0.1:' + upstream.server.address().port;
    const dispatch = buildAdapterIngress({
      routes: routesOf({ calendar: Object.assign({ upstream: up, paths: ['/.well-known/oauth-protected-resource/adapter/calendar/'] }, routeExtra) }),
      logger: quietLogger
    });
    fallbackCalls = [];
    const fallback = (req, res) => {
      fallbackCalls.push(req.url);
      req.resume();
      res.writeHead(299, { 'content-type': 'text/plain' });
      res.end('fallback');
    };
    front = opts.tls != null
      ? https.createServer(opts.tls, (req, res) => dispatch(req, res, fallback))
      : http.createServer((req, res) => dispatch(req, res, fallback));
    attachAdapterContinueCheck(front, dispatch, quietLogger);
    await listen(front);
    frontPort = front.address().port;
  }

  afterEach(async function () {
    configureTrustedProxies(savedTrust);
    await close(front);
    await close(upstream?.server);
    front = null;
    upstream = null;
  });

  it('[ADRI01] match table: the route prefixes (with and without the slash) go upstream, path and raw query unchanged; the rest falls through', async function () {
    await setup();
    const forwarded = {
      '/adapter/calendar': '/adapter/calendar',
      '/adapter/calendar/': '/adapter/calendar/',
      '/adapter/calendar/x/y?a=1&b=%27&c=\'q\'': '/adapter/calendar/x/y?a=1&b=%27&c=\'q\'',
      '/adapter/calendar/a/../b?x': '/adapter/calendar/b?x',
      '/.well-known/oauth-protected-resource/adapter/calendar/': '/.well-known/oauth-protected-resource/adapter/calendar/',
      '/.well-known/oauth-protected-resource/adapter/calendar': '/.well-known/oauth-protected-resource/adapter/calendar'
    };
    for (const [path, expected] of Object.entries(forwarded)) {
      const res = await request(frontPort, { path });
      assert.equal(res.status, 200, path);
      assert.equal(upstream.seen.at(-1).url, expected, path);
    }
    const before = upstream.seen.length;
    for (const path of ['/adapterx/calendar/', '/adapter/other/', '/adapter/', '/adapter', '/adapter/calendarx', '//adapter/calendar/', '/x/adapter/calendar/', '/ADAPTER/calendar/', '/.well-known/oauth-protected-resource/adapter/other/', 'http://elsewhere/adapter/calendar/']) {
      const res = await request(frontPort, { path });
      assert.equal(res.status, 299, path);
      assert.equal(res.body, 'fallback', path);
    }
    assert.equal(upstream.seen.length, before, 'none of them reached the upstream');
  });

  it('[ADRI02] every method but TRACE reaches the upstream with its body, a chunked body included, whatever the method', async function () {
    await setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const body = 'body of ' + method;
      const res = await request(frontPort, { method, path: '/adapter/calendar/m', headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) }, body });
      assert.equal(res.status, 200, method);
      assert.equal(upstream.seen.at(-1).method, method);
      assert.equal(upstream.seen.at(-1).body, 'body of ' + method);
    }
    for (const method of ['GET', 'HEAD']) {
      const res = await request(frontPort, { method, path: '/adapter/calendar/m' });
      assert.equal(res.status, 200, method);
      assert.equal(upstream.seen.at(-1).method, method);
      if (method === 'HEAD') assert.equal(res.body, '');
    }
    // TRACE would echo the credentials: answered by the core.
    const count = upstream.seen.length;
    const trace = await request(frontPort, { method: 'TRACE', path: '/adapter/calendar/m', headers: { authorization: 'Bearer abc' } });
    assert.equal(trace.status, 405);
    assert.equal(trace.headers.connection, 'close');
    assert.deepEqual(JSON.parse(trace.body), { error: { id: 'invalid-operation', message: 'adapter calendar: TRACE is not allowed' } });
    assert.equal(upstream.seen.length, count, 'TRACE did not reach the upstream');
    for (const method of ['DELETE', 'POST', 'GET']) {
      // Framed explicitly: Node's client sends a GET or DELETE body unframed otherwise.
      const res = await request(frontPort, { method, path: '/adapter/calendar/chunked', headers: { 'transfer-encoding': 'chunked' }, chunks: ['one,', 'two,', 'three'] });
      assert.equal(res.status, 200, method);
      const seen = upstream.seen.at(-1);
      assert.equal(seen.body, 'one,two,three', method);
      assert.equal(seen.headers['transfer-encoding'], 'chunked', method);
      assert.equal(seen.headers['content-length'], undefined, method);
    }
    // The next request is read as one.
    const res = await request(frontPort, { path: '/adapter/calendar/after' });
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.at(-1).url, '/adapter/calendar/after');
  });

  it('[ADRI14] a Connection header cannot remove the framing nor the Host: a request-shaped body is never read as a second request', async function () {
    await setup();
    const inner = 'GET /elsewhere HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 10.0.0.1\r\n\r\n';
    for (const [method, connection] of [['GET', 'content-length'], ['DELETE', 'content-length'], ['OPTIONS', 'content-length'], ['GET', 'host, content-length'], ['DELETE', 'Host']]) {
      upstream.seen.length = 0;
      const answer = await rawRequest(frontPort,
        `${method} /adapter/calendar/x HTTP/1.1\r\nHost: public.example\r\nConnection: ${connection}\r\nContent-Length: ${inner.length}\r\n\r\n${inner}`);
      const label = method + ' / ' + connection;
      assert.match(answer, /^HTTP\/1\.1 200/, label);
      assert.equal(upstream.seen.length, 1, label + ': the upstream saw exactly one request');
      const seen = upstream.seen[0];
      assert.equal(seen.url, '/adapter/calendar/x', label);
      assert.equal(seen.headers['content-length'], String(inner.length), label);
      assert.equal(seen.headers.host, 'public.example', label);
      assert.equal(seen.body, inner, label);
    }
  });

  it('[ADRI15] a transfer-encoding other than chunked is refused before the upstream', async function () {
    await setup();
    const answer = await rawRequest(frontPort,
      'POST /adapter/calendar/x HTTP/1.1\r\nHost: public.example\r\nTransfer-Encoding: gzip, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 400/);
    assert.match(answer, /only the chunked transfer-encoding is accepted/);
    assert.equal(upstream.seen.length, 0);
    const chunked = await rawRequest(frontPort,
      'POST /adapter/calendar/x HTTP/1.1\r\nHost: public.example\r\nTransfer-Encoding: Chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n');
    assert.match(chunked, /^HTTP\/1\.1 200/);
    assert.equal(upstream.seen.at(-1).body, 'hello');
  });

  it('[ADRI03] request headers: credentials and custom headers pass, hop-by-hop ones do not; Host kept; X-Forwarded-* set by the core', async function () {
    await setup();
    configureTrustedProxies([]);
    await request(frontPort, {
      method: 'POST',
      path: '/adapter/calendar/h',
      headers: {
        host: 'public.example:8443',
        authorization: 'Bearer abc',
        cookie: 'a=1',
        dpop: 'proof',
        'x-session-id': 's-1',
        'content-type': 'application/json',
        connection: 'keep-alive, x-hop',
        'x-hop': 'dropped',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        'proxy-authorization': 'Basic eA==',
        forwarded: 'for=1.2.3.4',
        'x-forwarded-port': '1',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-host': 'spoofed.example',
        'x-forwarded-proto': 'https'
      },
      body: '{}'
    });
    const h = upstream.seen.at(-1).headers;
    assert.equal(h.host, 'public.example:8443');
    assert.equal(h.authorization, 'Bearer abc');
    assert.equal(h.cookie, 'a=1');
    assert.equal(h.dpop, 'proof');
    assert.equal(h['x-session-id'], 's-1');
    assert.equal(h['content-type'], 'application/json');
    assert.equal(h['content-length'], '2');
    for (const name of ['x-hop', 'keep-alive', 'te', 'proxy-authorization', 'forwarded', 'x-forwarded-port', 'upgrade', 'expect']) {
      assert.equal(h[name], undefined, name);
    }
    assert.notEqual(h.connection, 'keep-alive, x-hop');
    assert.equal(h['x-forwarded-for'], '127.0.0.1', 'the peer, the client value replaced');
    assert.equal(h['x-forwarded-host'], 'public.example:8443', 'the received Host, the client value replaced');
    assert.equal(h['x-forwarded-proto'], 'http', 'the socket, the client value replaced');

    // A trusted peer (loopback, the default): its own X-Forwarded-* are kept.
    configureTrustedProxies(['loopback']);
    await request(frontPort, {
      path: '/adapter/calendar/h',
      headers: { host: 'internal:3000', 'x-forwarded-for': '1.2.3.4, 203.0.113.7', 'x-forwarded-host': 'edge.example', 'x-forwarded-proto': 'https' }
    });
    const t = upstream.seen.at(-1).headers;
    assert.equal(t['x-forwarded-for'], '203.0.113.7');
    assert.equal(t['x-forwarded-host'], 'edge.example');
    assert.equal(t['x-forwarded-proto'], 'https');
    assert.equal(t.host, 'internal:3000');
    // Without them, they are set from the request.
    await request(frontPort, { path: '/adapter/calendar/h', headers: { host: 'internal:3000' } });
    assert.equal(upstream.seen.at(-1).headers['x-forwarded-host'], 'internal:3000');
    assert.equal(upstream.seen.at(-1).headers['x-forwarded-proto'], 'http');

    // Expect: answered by this server; the upstream never waits for a 100.
    const res = await request(frontPort, {
      method: 'POST',
      path: '/adapter/calendar/e',
      headers: { expect: '100-continue', 'content-length': '5' },
      onContinue: (r) => r.end('hello')
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.at(-1).headers.expect, undefined);
    assert.equal(upstream.seen.at(-1).body, 'hello');
  });

  it('[ADRI03b] X-Forwarded-Proto is https on a TLS front', async function () {
    const { generate } = require('business/src/acme/selfSignedPlaceholder.ts');
    const { keyPem, certPem } = generate({ commonName: 'localhost' });
    await setup(null, {}, { tls: { key: keyPem, cert: certPem } });
    configureTrustedProxies([]);
    const res = await request(frontPort, { path: '/adapter/calendar/tls', tls: true, headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.at(-1).headers['x-forwarded-proto'], 'https');
  });

  it('[ADRI04] response headers pass as sent, hop-by-hop ones aside; status and content-length kept; the core adds nothing', async function () {
    await setup((req, res) => {
      req.resume();
      res.writeHead(418, {
        'www-authenticate': ['Bearer realm="x", error="invalid_token"', 'DPoP algs="ES256"'],
        link: ['<a>; rel="x"', '<b>; rel="y"'],
        'set-cookie': ['a=1; HttpOnly', 'b=2'],
        'access-control-allow-origin': 'https://app.example',
        'x-custom': 'yes',
        'content-type': 'text/plain',
        'content-length': '5',
        connection: 'keep-alive, x-drop',
        'x-drop': 'dropped',
        'keep-alive': 'timeout=99'
      });
      res.end('hello');
    });
    const res = await request(frontPort, { path: '/adapter/calendar/r', headers: { origin: 'https://app.example' } });
    assert.equal(res.status, 418);
    assert.equal(res.body, 'hello');
    // Repeated headers come back as the separate lines the upstream sent.
    const lines = (name) => res.rawHeaders.filter((_, i) => i % 2 === 0 && res.rawHeaders[i].toLowerCase() === name).length;
    assert.equal(lines('www-authenticate'), 2);
    assert.equal(lines('link'), 2);
    assert.equal(lines('set-cookie'), 2);
    assert.equal(res.headers['www-authenticate'], 'Bearer realm="x", error="invalid_token", DPoP algs="ES256"');
    assert.deepEqual(res.headers['set-cookie'], ['a=1; HttpOnly', 'b=2']);
    assert.equal(res.headers['access-control-allow-origin'], 'https://app.example');
    assert.equal(res.headers['x-custom'], 'yes');
    assert.equal(res.headers['content-length'], '5');
    assert.equal(res.headers['x-drop'], undefined);
    assert.notEqual(res.headers['keep-alive'], 'timeout=99');
    const allowed = new Set(['www-authenticate', 'link', 'set-cookie', 'access-control-allow-origin', 'x-custom', 'content-type', 'content-length', 'date', 'connection', 'keep-alive']);
    for (const name of Object.keys(res.headers)) assert.ok(allowed.has(name), 'unexpected header ' + name);

    // A chunked upstream answer is re-chunked, not double-chunked.
    await close(front); await close(upstream.server);
    await setup((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('part1,');
      setTimeout(() => res.end('part2'), 20);
    });
    const chunked = await request(frontPort, { path: '/adapter/calendar/c' });
    assert.equal(chunked.body, 'part1,part2');
    assert.equal(chunked.headers['transfer-encoding'], 'chunked');
  });

  it('[ADRI05] streaming: an event stream is received as it is written, not when it ends; a large chunked upload arrives whole', async function () {
    let upstreamEnded = false;
    await setup((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: one\n\n');
      setTimeout(() => res.write('data: two\n\n'), 300);
      setTimeout(() => { upstreamEnded = true; res.end('data: three\n\n'); }, 600);
    });
    const firstEventBeforeEnd = await new Promise((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: frontPort, path: '/adapter/calendar/events' }, (res) => {
        let first = null;
        let all = '';
        res.on('data', (c) => {
          if (first == null) first = !upstreamEnded;
          all += c;
        });
        res.on('end', () => {
          assert.equal(all, 'data: one\n\ndata: two\n\ndata: three\n\n');
          resolve(first);
        });
      });
      r.on('error', reject);
    });
    assert.equal(firstEventBeforeEnd, true, 'the first event arrived before the upstream ended');

    await close(front); await close(upstream.server);
    await setup();
    const piece = 'x'.repeat(16 * 1024);
    const res = await request(frontPort, { method: 'POST', path: '/adapter/calendar/upload', chunks: Array(20).fill(piece) });
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.at(-1).body.length, 20 * piece.length);
  });

  it('[ADRI06] body cap: a declared length over it answers 413 without the upstream; a chunked body crossing it is cut with 413', async function () {
    await setup(null, { maxBodyBytes: 1000 });
    const res = await request(frontPort, { method: 'POST', path: '/adapter/calendar/big', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(5000) });
    assert.equal(res.status, 413);
    assert.equal(res.headers.connection, 'close');
    assert.equal(res.headers['content-type'], 'application/json');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body), { error: { id: 'invalid-request-structure', message: 'request body exceeds adapterRoutes.calendar.maxBodyBytes (1000 bytes)' } });
    assert.equal(upstream.seen.length, 0, 'the upstream was not contacted');

    // Exactly at the cap passes.
    const atCap = await request(frontPort, { method: 'POST', path: '/adapter/calendar/ok', body: 'x'.repeat(1000) });
    assert.equal(atCap.status, 200);

    // Chunked: the client stops writing once it has the answer.
    const chunked = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: frontPort, method: 'POST', path: '/adapter/calendar/big' });
      const state = { answered: null };
      r.on('response', (res) => { state.answered = { status: res.statusCode, headers: res.headers }; res.resume(); resolve(state.answered); });
      r.on('error', (err) => { if (state.answered == null) reject(err); });
      (async () => {
        for (let i = 0; i < 3 && state.answered == null; i++) { r.write('y'.repeat(600)); await sleep(50); }
        if (state.answered == null) r.end();
      })();
    });
    assert.equal(chunked.status, 413);
    assert.equal(chunked.headers.connection, 'close');
    const seen = upstream.seen.at(-1);
    assert.equal(seen.url, '/adapter/calendar/big');
    await seen.closed;
    assert.equal(seen.complete, false, 'the upstream request was cut before its body completed');
    assert.equal(seen.body.length, 600, 'the chunk that crossed the cap was not forwarded');

    // Expect: 100-continue with a declared length over the cap: refused before the client sends the body.
    const before = upstream.seen.length;
    const early = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: frontPort, method: 'POST', path: '/adapter/calendar/big', headers: { expect: '100-continue', 'content-length': '5000' } });
      let continued = false;
      r.on('continue', () => { continued = true; r.end('x'.repeat(5000)); });
      r.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, continued }); });
      r.on('error', reject);
      r.flushHeaders();
    });
    assert.equal(early.status, 413);
    assert.equal(early.continued, false, 'no 100 Continue before the 413');
    assert.equal(upstream.seen.length, before);
  });

  it('[ADRI07] upstream down: 502 naming the route only', async function () {
    const dead = await listen(http.createServer());
    const deadPort = dead.address().port;
    await close(dead);
    const dispatch = buildAdapterIngress({ routes: routesOf({ calendar: { upstream: 'http://127.0.0.1:' + deadPort } }), logger: quietLogger });
    front = http.createServer((req, res) => dispatch(req, res, () => assert.fail('no fallback')));
    await listen(front);
    const res = await request(front.address().port, { path: '/adapter/calendar/x' });
    assert.equal(res.status, 502);
    assert.equal(res.headers['content-type'], 'application/json');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body), { error: { id: 'unexpected-error', message: 'adapter calendar unreachable' } });
    assert.ok(!res.body.includes(String(deadPort)), 'no upstream address in the answer');
  });

  it('[ADRI08] idle timeout: a silent upstream answers 504; one that keeps bytes moving is not cut', async function () {
    await setup((req, res) => {
      req.resume();
      if (req.url.endsWith('/silent')) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const timer = setInterval(() => {
        res.write(': keep-alive\n\n');
        if (++n === 8) { clearInterval(timer); res.end('data: done\n\n'); }
      }, 100);
    }, { idleTimeoutMs: 300 });
    const silent = await request(frontPort, { path: '/adapter/calendar/silent' });
    assert.equal(silent.status, 504);
    assert.deepEqual(JSON.parse(silent.body), { error: { id: 'unexpected-error', message: 'adapter calendar timed out' } });
    const alive = await request(frontPort, { path: '/adapter/calendar/alive' });
    assert.equal(alive.status, 200);
    assert.ok(alive.body.endsWith('data: done\n\n'), 'the stream ran past the idle timeout to its end');
  });

  it('[ADRI09] traversal: encoded separators, NUL and bad encodings answer 400; dot segments resolve before the match', async function () {
    await setup();
    for (const path of ['/adapter/calendar/a%2fb', '/adapter/calendar/a%2F..%2F..%2Foauth2', '/adapter/calendar/a%5cb', '/adapter/calendar/a%00b', '/adapter/calendar/%zz']) {
      const res = await request(frontPort, { path });
      assert.equal(res.status, 400, path);
      assert.equal(JSON.parse(res.body).error.id, 'invalid-request-structure', path);
      assert.equal(res.headers.connection, 'close', path);
    }
    for (const path of ['/adapter/calendar/../oauth2/token', '/adapter/calendar/../../oauth2/token', '/adapter/calendar/%2e%2e/%2E%2E/oauth2/token']) {
      const res = await request(frontPort, { path });
      assert.equal(res.status, 299, path);
    }
    // A backslash is read as a separator (or the request refused by the parser).
    const backslash = await request(frontPort, { path: '/adapter/calendar\\..\\..\\oauth2' }).catch(() => ({ status: null }));
    assert.notEqual(backslash.status, 200);
    assert.equal(upstream.seen.length, 0, 'nothing reached the upstream');
    const inside = await request(frontPort, { path: '/adapter/calendar/a/%2e%2e/b' });
    assert.equal(inside.status, 200);
    assert.equal(upstream.seen.at(-1).url, '/adapter/calendar/b');
  });

  it('[ADRI10] a client that leaves mid-upload or mid-stream ends the upstream request', async function () {
    await setup((req, res) => {
      if (req.url.endsWith('/upload') || req.url.endsWith('/hold')) { req.resume(); return; }
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
    });
    const up = http.request({ host: '127.0.0.1', port: frontPort, method: 'POST', path: '/adapter/calendar/upload', headers: { 'content-length': '10000' } });
    up.on('error', () => {});
    up.write('x'.repeat(100));
    while (upstream.seen.length === 0) await sleep(10);
    up.destroy();
    await upstream.seen[0].closed;
    assert.equal(upstream.seen[0].complete, false);

    await new Promise((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: frontPort, path: '/adapter/calendar/stream' }, (res) => {
        res.once('data', () => { r.destroy(); resolve(); });
      });
      r.on('error', () => {});
      setTimeout(() => reject(new Error('no first event')), 3000);
    });
    const finished = await upstream.seen[1].resClosed;
    assert.equal(finished, false, 'the upstream stream was ended by the client leaving');

    // Before the upstream answered at all (the request body was complete, so
    // only the response side tells the client left).
    const hold = http.get({ host: '127.0.0.1', port: frontPort, path: '/adapter/calendar/hold' });
    hold.on('error', () => {});
    while (upstream.seen.length < 3) await sleep(10);
    hold.destroy();
    const left = await Promise.race([upstream.seen[2].resClosed.then(() => 'closed'), sleep(2000).then(() => 'still open')]);
    assert.equal(left, 'closed', 'the upstream request was released when the client left');
  });

  it('[ADRI11] an early answer while the client is still uploading lets the client finish', async function () {
    await setup((req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="x"', 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
    });
    const body = 'z'.repeat(512 * 1024);
    const res = await request(frontPort, { method: 'POST', path: '/adapter/calendar/early', body });
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer realm="x"');
  });

  it('[ADRI12] an Upgrade request is not passed on as an upgrade', async function () {
    await setup();
    await request(frontPort, { path: '/adapter/calendar/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
    const h = upstream.seen.at(-1).headers;
    assert.equal(h.upgrade, undefined);
    assert.notEqual(String(h.connection).toLowerCase(), 'upgrade');
  });

  it('[ADRI13] an https upstream is verified against its own name, not the client Host', async function () {
    const { generate } = require('business/src/acme/selfSignedPlaceholder.ts');
    const { keyPem, certPem } = generate({ commonName: 'localhost' });
    const seen = [];
    const tlsUpstream = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
      seen.push(req.headers.host);
      req.resume();
      res.end('tls ok');
    });
    await listen(tlsUpstream, 'localhost');
    try {
      const routes = routesOf({ calendar: { upstream: 'https://localhost:' + tlsUpstream.address().port } });
      const dispatch = buildAdapterIngress({ routes, logger: quietLogger, ca: certPem });
      front = http.createServer((req, res) => dispatch(req, res, () => assert.fail('no fallback')));
      await listen(front);
      const res = await request(front.address().port, { path: '/adapter/calendar/x', headers: { host: 'public.example' } });
      assert.equal(res.status, 200);
      assert.equal(res.body, 'tls ok');
      assert.deepEqual(seen, ['public.example']);
      // An untrusted certificate is an upstream failure.
      const strict = buildAdapterIngress({ routes, logger: quietLogger });
      const strictFront = await listen(http.createServer((req, res) => strict(req, res, () => assert.fail('no fallback'))));
      const refused = await request(strictFront.address().port, { path: '/adapter/calendar/x' });
      await close(strictFront);
      assert.equal(refused.status, 502);
    } finally {
      await close(tlsUpstream);
    }
  });

  it('[ADRI13b] an https upstream given by IP is verified against the certificate\'s IP entry', async function () {
    const { keyPem, certPem } = ipCertificate();
    const tlsUpstream = https.createServer({ key: keyPem, cert: certPem }, (req, res) => { req.resume(); res.end('ip ok'); });
    await listen(tlsUpstream);
    try {
      const routes = routesOf({ calendar: { upstream: 'https://127.0.0.1:' + tlsUpstream.address().port } });
      const dispatch = buildAdapterIngress({ routes, logger: quietLogger, ca: certPem });
      front = http.createServer((req, res) => dispatch(req, res, () => assert.fail('no fallback')));
      await listen(front);
      const res = await request(front.address().port, { path: '/adapter/calendar/x', headers: { host: 'public.example' } });
      assert.equal(res.status, 200);
      assert.equal(res.body, 'ip ok');
    } finally {
      await close(tlsUpstream);
    }
  });
});

/**
 * Per-user addresses: the account a request is addressed to by its host, its
 * placement on the platform, and the two headers the core sets for the
 * sidecar.
 */
describe('[ADRU] adapter routes: the addressed account', function () {
  this.timeout(10000);
  const { addressedLabelOf } = require('../src/addressedAccount.ts');
  const { platformRoutedLabels } = require('../src/platformLabels.ts');
  const { usernameInHost } = require('business/src/usernameSubdomains.ts');
  const { adapterAddressingFor } = require('../src/adapterIngress.ts');
  const savedTrust = currentTrustedProxies();
  const CONFIG = {
    'core:id': 'core-a',
    'dns:staticEntries': { 'svc-static': { a: ['127.0.0.9'] } },
    hostedSites: { 'site-home': { static: '/tmp' } }
  };
  const configOf = (extra = {}) => ({ get: (key) => ({ ...CONFIG, ...extra })[key] });
  // The platform's runtime DNS names (records added after boot): a predicate
  // on top of the configured names, as the platform keeps them.
  const RUNTIME = new Set(['runtime-rec']);
  const configured = platformRoutedLabels(configOf());
  const isPlatformRoutedLabel = (label) => configured(label) || RUNTIME.has(label);
  let upstream, front, frontPort, warnings;
  const logger = { debug: () => {}, info: () => {}, warn: (m) => warnings.push(m), error: () => {} };

  /** A platform slice: `map` username -> core id; `fail` makes the lookup throw. */
  function stubPlatform ({ isSingleCore = false, map = {}, fail = false } = {}) {
    const calls = [];
    return {
      calls,
      isSingleCore,
      coreId: 'core-a',
      async getUserCore (username) {
        calls.push(username);
        if (fail) throw new Error('platform store down');
        return map[username] ?? null;
      },
      coreIdToUrl: (coreId) => coreId === 'core-nourl' ? 'null/' : 'https://' + coreId + '.example.com/'
    };
  }

  async function setup (platform, opts = {}) {
    warnings = [];
    upstream = fakeUpstream();
    await listen(upstream.server);
    const up = 'http://127.0.0.1:' + upstream.server.address().port;
    const dispatch = buildAdapterIngress({
      routes: routesOf({ calendar: { upstream: up, paths: ['/.well-known/oauth-protected-resource/adapter/calendar/'], ...opts.routeExtra } }),
      logger,
      addressing: opts.addressing === null ? null : { isPlatformRoutedLabel, platform }
    });
    const fallback = (req, res) => { req.resume(); res.writeHead(299); res.end('fallback'); };
    front = opts.tls != null
      ? https.createServer(opts.tls, (req, res) => dispatch(req, res, fallback))
      : http.createServer((req, res) => dispatch(req, res, fallback));
    await listen(front);
    frontPort = front.address().port;
  }

  afterEach(async function () {
    configureTrustedProxies(savedTrust);
    await close(front);
    await close(upstream?.server);
    front = null;
    upstream = null;
  });

  it('[ADRU1] the account label: a username-shaped first label the platform does not route; every other host is a platform address', async function () {
    const cases = {
      'alice.example.com': 'alice',
      'ALICE.Example.com:8443': 'alice',
      'alice-2.example.com.': 'alice-2',
      'reg.example.com': null,
      'access.example.com': null,
      'mfa.example.com': null,
      'core-a.example.com': null,
      'site-home.example.com': null,
      'svc-static.example.com': null,
      'runtime-rec.example.com': null,
      'www.example.com': null,
      'alice': null,
      'localhost:3000': null,
      '127.0.0.1:3000': null,
      '[::1]:3000': null,
      'alice.example.com/evil': null,
      'alice.exa mple.com': null,
      '': null,
      undefined: null
    };
    for (const [host, expected] of Object.entries(cases)) {
      assert.equal(addressedLabelOf(host === 'undefined' ? undefined : host, isPlatformRoutedLabel), expected, host);
    }
    // dnsLess: the host is the core's own name, never an account.
    assert.equal(usernameInHost(configOf({ 'dnsLess:isActive': true })), false);
    assert.equal(adapterAddressingFor(configOf({ 'dnsLess:isActive': true })), null);
    assert.equal(typeof adapterAddressingFor(configOf({ 'dnsLess:isActive': false })).isPlatformRoutedLabel, 'function');
    // Through the ingress: a platform address is forwarded without a lookup.
    const platform = stubPlatform();
    await setup(platform);
    for (const host of ['reg.example.com', 'core-a.example.com', 'runtime-rec.example.com', 'adapter.example.com', '127.0.0.1']) {
      const res = await request(frontPort, { path: '/adapter/calendar/x', headers: { host } });
      assert.equal(res.status, 200, host);
      assert.equal(upstream.seen.at(-1).headers['x-adapter-name'], undefined, host);
    }
    assert.deepEqual(platform.calls, [], 'no placement lookup for a platform address');
  });

  it('[ADRU2] an addressed request reaches the upstream with the name and the route\'s base (scheme, Host, root path); a platform address with neither', async function () {
    await setup(stubPlatform({ map: { alice: 'core-a' } }));
    configureTrustedProxies([]);
    await request(frontPort, { path: '/adapter/calendar/manifest.json', headers: { host: 'Alice.example.com:8443' } });
    let h = upstream.seen.at(-1).headers;
    assert.equal(h['x-adapter-name'], 'alice');
    assert.equal(h['x-adapter-base'], 'http://alice.example.com:8443/adapter/calendar/');
    // Another prefix of the route: the same base (the route root).
    await request(frontPort, { path: '/.well-known/oauth-protected-resource/adapter/calendar/x', headers: { host: 'alice.example.com' } });
    h = upstream.seen.at(-1).headers;
    assert.equal(upstream.seen.at(-1).url, '/.well-known/oauth-protected-resource/adapter/calendar/x');
    assert.equal(h['x-adapter-base'], 'http://alice.example.com/adapter/calendar/');
    // An untrusted peer's X-Forwarded-Proto is not the scheme.
    await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'alice.example.com', 'x-forwarded-proto': 'https' } });
    assert.equal(upstream.seen.at(-1).headers['x-adapter-base'], 'http://alice.example.com/adapter/calendar/');
    // A trusted proxy's is (its first value).
    configureTrustedProxies(['loopback']);
    await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'alice.example.com', 'x-forwarded-proto': 'https, http' } });
    assert.equal(upstream.seen.at(-1).headers['x-adapter-base'], 'https://alice.example.com/adapter/calendar/');
    // A platform address: neither header.
    await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'reg.example.com' } });
    h = upstream.seen.at(-1).headers;
    assert.equal(h['x-adapter-name'], undefined);
    assert.equal(h['x-adapter-base'], undefined);
  });

  it('[ADRU2b] on a TLS front the base is https', async function () {
    const { generate } = require('business/src/acme/selfSignedPlaceholder.ts');
    const { keyPem, certPem } = generate({ commonName: 'localhost' });
    await setup(stubPlatform(), { tls: { key: keyPem, cert: certPem } });
    configureTrustedProxies([]);
    const res = await request(frontPort, { path: '/adapter/calendar/x', tls: true, headers: { host: 'alice.example.com', 'x-forwarded-proto': 'http' } });
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.at(-1).headers['x-adapter-base'], 'https://alice.example.com/adapter/calendar/');
  });

  it('[ADRU3] client-sent X-Adapter-Name / X-Adapter-Base never reach the upstream, from an untrusted peer or a trusted proxy', async function () {
    const spoofed = { 'x-adapter-name': 'mallory', 'x-adapter-base': 'https://mallory.example.com/adapter/calendar/' };
    for (const trust of [[], ['loopback']]) {
      await setup(stubPlatform());
      configureTrustedProxies(trust);
      // Addressed: replaced by the core's values.
      await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'alice.example.com', ...spoofed } });
      let h = upstream.seen.at(-1).headers;
      assert.equal(h['x-adapter-name'], 'alice', String(trust));
      assert.equal(h['x-adapter-base'], 'http://alice.example.com/adapter/calendar/', String(trust));
      // A platform address: removed.
      await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'reg.example.com', ...spoofed } });
      h = upstream.seen.at(-1).headers;
      assert.equal(h['x-adapter-name'], undefined, String(trust));
      assert.equal(h['x-adapter-base'], undefined, String(trust));
      // An ingress without per-user addresses (dnsLess) removes them too.
      await close(front);
      await close(upstream.server);
      await setup(null, { addressing: null });
      configureTrustedProxies(trust);
      await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'alice.example.com', ...spoofed } });
      h = upstream.seen.at(-1).headers;
      assert.equal(h['x-adapter-name'], undefined, String(trust));
      assert.equal(h['x-adapter-base'], undefined, String(trust));
      await close(front);
      await close(upstream.server);
    }
  });

  it('[ADRU4] placement: another core answers 421 wrong-core with its URL without the upstream; this core, an unknown name forward; no usable URL 421 without it; a lookup failure 500', async function () {
    const platform = stubPlatform({ map: { alice: 'core-a', bobby: 'core-b', carol: 'core-nourl' } });
    await setup(platform);
    const before = upstream.seen.length;
    const remote = await request(frontPort, { method: 'POST', path: '/adapter/calendar/x', headers: { host: 'bobby.example.com', 'content-type': 'application/json', authorization: 'Bearer t' }, body: '{"a":1}' });
    assert.equal(remote.status, 421);
    assert.equal(remote.headers['content-type'], 'application/json');
    assert.equal(remote.headers['x-content-type-options'], 'nosniff');
    assert.equal(remote.headers['cache-control'], 'no-store');
    assert.equal(remote.headers.connection, 'close');
    assert.equal(remote.headers.location, undefined, 'never a redirect');
    const body = JSON.parse(remote.body);
    assert.equal(body.error.id, 'wrong-core');
    assert.equal(body.error.coreUrl, 'https://core-b.example.com/');
    assert.match(body.error.message, /account "bobby" is served by another core/);
    assert.equal(upstream.seen.length, before, 'the upstream was not contacted');
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /Bearer|\{"a"/, 'the log names no header and no body');
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      assert.equal((await request(frontPort, { method, path: '/adapter/calendar/x', headers: { host: 'bobby.example.com' } })).status, 421, method);
    }
    // Here, and a name the platform does not map: forwarded.
    for (const name of ['alice', 'nobody-known']) {
      const res = await request(frontPort, { path: '/adapter/calendar/x', headers: { host: name + '.example.com' } });
      assert.equal(res.status, 200, name);
      assert.equal(upstream.seen.at(-1).headers['x-adapter-name'], name);
    }
    // A core without a usable URL: 421, no coreUrl.
    const noUrl = await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'carol.example.com' } });
    assert.equal(noUrl.status, 421);
    assert.equal(JSON.parse(noUrl.body).error.coreUrl, undefined);
    assert.equal(JSON.parse(noUrl.body).error.id, 'wrong-core');
    // A lookup failure: 500, never forwarded.
    await close(front);
    await close(upstream.server);
    await setup(stubPlatform({ fail: true }));
    const failed = await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'alice.example.com' } });
    assert.equal(failed.status, 500);
    assert.equal(JSON.parse(failed.body).error.id, 'unexpected-error');
    assert.equal(upstream.seen.length, 0);
    assert.match(warnings.at(-1), /placement lookup failed/);
  });

  it('[ADRU4b] a declared body over the cap is refused 413 before any lookup', async function () {
    const platform = stubPlatform({ map: { bobby: 'core-b' } });
    await setup(platform, { routeExtra: { maxBodyBytes: 1000 } });
    const res = await request(frontPort, { method: 'POST', path: '/adapter/calendar/x', headers: { host: 'bobby.example.com', 'content-type': 'text/plain' }, body: 'x'.repeat(5000) });
    assert.equal(res.status, 413);
    assert.deepEqual(platform.calls, []);
  });

  it('[ADRU5] single core: no lookup, the headers are still set', async function () {
    const platform = stubPlatform({ isSingleCore: true, map: { alice: 'core-b' } });
    await setup(platform);
    const res = await request(frontPort, { path: '/adapter/calendar/x', headers: { host: 'alice.example.com' } });
    assert.equal(res.status, 200);
    assert.deepEqual(platform.calls, []);
    assert.equal(upstream.seen.at(-1).headers['x-adapter-name'], 'alice');
    assert.equal(upstream.seen.at(-1).headers['x-adapter-base'], 'http://alice.example.com/adapter/calendar/');
  });
});
