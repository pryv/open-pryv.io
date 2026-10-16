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
const net = require('node:net');
const { compileAllowList } = require('../../src/webhooks/destination.ts');
const {
  MAX_PEER_RESPONSE_BYTES,
  PeerFetchRefusedError,
  peerFetch,
  peerUrlRefusal,
  platformHostMatcher,
  describeCmcConfig,
  setPeerTransportForTests
} = require('../../src/outbound/peerFetch.ts');

const settings = (allowed = [], { allowInsecure = true, isPlatformHost = () => false } = {}) =>
  ({ allow: compileAllowList(allowed), allowInsecure, isPlatformHost });

async function failure (promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail('the call should have failed');
}

describe('[PFRT] counterparty calls (peerFetch)', function () {
  const receivers = [];
  // A receiver on the loopback interface; `handler` decides the answer.
  async function receiver (handler) {
    const r = { requests: [], server: null, port: 0 };
    r.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        r.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        handler(req, res);
      });
    });
    await new Promise((resolve) => r.server.listen(0, '127.0.0.1', resolve));
    r.port = r.server.address().port;
    receivers.push(r);
    return r;
  }

  before(function () {
    setPeerTransportForTests(null); // the guarded client, whatever a test-wide setup installed
  });
  after(async function () {
    for (const r of receivers) {
      r.server.closeAllConnections();
      await new Promise((resolve) => r.server.close(resolve));
    }
  });

  it('[PFR1] refuses loopback, private and IPv6 loopback literals without connecting', async function () {
    const r = await receiver((req, res) => res.end('{}'));
    const literals = [`http://127.0.0.1:${r.port}/events`, 'https://10.0.0.1/events', 'https://[::1]/events', 'https://169.254.169.254/latest',
      // forms the URL parser normalises to a dotted or embedded IPv4
      `http://2130706433:${r.port}/`, `http://0x7f.1:${r.port}/`, 'https://[::ffff:10.0.0.1]/', 'https://[64:ff9b::a00:1]/'];
    for (const url of literals) {
      const err = await failure(peerFetch(url, { method: 'POST', body: '{}' }, settings()));
      assert.ok(err instanceof PeerFetchRefusedError, url);
      assert.equal(err.code, 'EPEERREFUSED');
      assert.equal(err.kind, 'address', url);
    }
    assert.equal(r.requests.length, 0);
  });

  it('[PFR2] refuses a host name resolving to loopback, before connecting', async function () {
    const r = await receiver((req, res) => res.end('{}'));
    const err = await failure(peerFetch(`http://localhost:${r.port}/events`, {}, settings()));
    assert.ok(err instanceof PeerFetchRefusedError);
    assert.equal(err.kind, 'address');
    assert.equal(err.host, 'localhost');
    assert.equal(r.requests.length, 0);
  });

  it('[PFR3] lets an allow-listed private host through by name, IP or range, and the platform names', async function () {
    const r = await receiver((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":1}'); });
    for (const [allowed, host] of [[['localhost'], 'localhost'], [['127.0.0.1'], '127.0.0.1'], [['127.0.0.0/8'], 'localhost']]) {
      const res = await peerFetch(`http://${host}:${r.port}/events`, {}, settings(allowed));
      assert.equal(res.status, 200, String(allowed));
      assert.deepEqual(await res.json(), { ok: 1 });
    }
    const res = await peerFetch(`http://localhost:${r.port}/events`, {}, settings([], { isPlatformHost: (h) => h === 'localhost' }));
    assert.equal(res.status, 200);
    assert.equal(r.requests.length, 4);
  });

  it('[PFR4] refuses http unless insecure peers are allowed, other schemes and credentials', async function () {
    assert.equal(peerUrlRefusal('http://peer.example.com/events', settings([], { allowInsecure: false })).kind, 'scheme');
    assert.equal(peerUrlRefusal('http://peer.example.com/events', settings([], { allowInsecure: true })), null);
    assert.equal(peerUrlRefusal('ftp://peer.example.com/events', settings()).kind, 'scheme');
    assert.equal(peerUrlRefusal('https://tok@peer.example.com/events', settings()).kind, 'url');
    assert.equal(peerUrlRefusal('not a url', settings()).kind, 'url');
    assert.equal(peerUrlRefusal('https://peer.example.com/' + 'a'.repeat(2100), settings()).kind, 'url');
    assert.equal(peerUrlRefusal('https://peer.example.com/events', settings()), null);
  });

  it('[PFR5] does not follow a redirect', async function () {
    const target = await receiver((req, res) => res.end('{}'));
    const r = await receiver((req, res) => { res.statusCode = 307; res.setHeader('location', `http://127.0.0.1:${target.port}/x`); res.end(); });
    const err = await failure(peerFetch(`http://127.0.0.1:${r.port}/events`, { method: 'POST', body: '{}', redirect: 'error' }, settings(['127.0.0.1'])));
    assert.ok(err instanceof PeerFetchRefusedError);
    assert.equal(err.kind, 'redirect');
    assert.equal(target.requests.length, 0);
  });

  it('[PFR6] refuses an answer over the size cap and returns a smaller one as a Response', async function () {
    const big = await receiver((req, res) => res.end('x'.repeat(MAX_PEER_RESPONSE_BYTES + 10)));
    const err = await failure(peerFetch(`http://127.0.0.1:${big.port}/events`, {}, settings(['127.0.0.1'])));
    assert.ok(err instanceof PeerFetchRefusedError);
    assert.equal(err.kind, 'too-large');
    const small = await receiver((req, res) => { res.statusCode = 201; res.end('{"event":{"id":"e1"}}'); });
    const res = await peerFetch(`http://127.0.0.1:${small.port}/events`, { method: 'POST', headers: { authorization: 'tok', 'content-type': 'application/json' }, body: '{"a":1}' }, settings(['127.0.0.1']));
    assert.equal(res.status, 201);
    assert.equal(res.ok, true);
    assert.deepEqual(await res.json(), { event: { id: 'e1' } });
    const seen = small.requests[0];
    assert.equal(seen.method, 'POST');
    assert.equal(seen.headers.authorization, 'tok');
    assert.equal(seen.body, '{"a":1}');
  });

  it('[PFR7] an aborted call rejects as AbortError, a closed port with a socket error', async function () {
    const slow = await receiver(() => { /* never answers */ });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const aborted = await failure(peerFetch(`http://127.0.0.1:${slow.port}/events`, { signal: controller.signal }, settings(['127.0.0.1'])));
    assert.equal(aborted.name, 'AbortError');
    const closed = await receiver((req, res) => res.end());
    const port = closed.port;
    closed.server.closeAllConnections();
    await new Promise((resolve) => closed.server.close(resolve));
    receivers.splice(receivers.indexOf(closed), 1);
    const err = await failure(peerFetch(`http://127.0.0.1:${port}/events`, {}, settings(['127.0.0.1'])));
    assert.ok(!(err instanceof PeerFetchRefusedError));
  });

  it('[PFR8] platformHostMatcher: core url host, dns domain and below, service.api host', function () {
    const sub = platformHostMatcher({ coreUrl: 'https://core-a.example.org/', dnsDomain: 'pryv.me', serviceApi: 'https://{username}.pryv.me/' });
    for (const h of ['core-a.example.org', 'pryv.me', 'alice.pryv.me', 'reg.pryv.me', 'Core-A.example.org.']) assert.equal(sub(h), true, h);
    for (const h of ['evilpryv.me', 'pryv.me.evil', 'example.org', 'core-b.example.org', '']) assert.equal(sub(h), false, h);
    const path = platformHostMatcher({ serviceApi: 'https://api.example.com/{username}/' });
    assert.equal(path('api.example.com'), true);
    assert.equal(path('alice.example.com'), false);
    const tmpl = platformHostMatcher({ serviceApi: 'https://{username}.users.example.com/' });
    assert.equal(tmpl('alice.users.example.com'), true);
    assert.equal(tmpl('a.b.users.example.com'), false);
    assert.equal(platformHostMatcher({})('anything.com'), false);
  });

  it('[PFR9] describeCmcConfig reports unusable allow-list entries', function () {
    assert.deepEqual(describeCmcConfig(undefined).problems, []);
    assert.deepEqual(describeCmcConfig({ allowedPrivateHosts: ['10.0.0.0/8', 'peer.internal', '192.168.1.5'] }).problems, []);
    assert.equal(describeCmcConfig({ allowedPrivateHosts: 'peer.internal' }).problems.length, 1);
    const problems = describeCmcConfig({ allowedPrivateHosts: ['0.0.0.0/0', '', 'bad host'] }).problems;
    assert.equal(problems.length, 3);
    assert.deepEqual(problems[0].path, ['cmc', 'allowedPrivateHosts', 0]);
  });

  it('[PFR10] a refusal message names the host and kind, never the path, query or token', async function () {
    const err = await failure(peerFetch('https://10.1.2.3/secret/path?token=abc', {}, settings()));
    assert.equal(err.message, "peer call refused: address, host '10.1.2.3'");
    assert.ok(!err.message.includes('secret') && !err.message.includes('abc'));
  });

  it('[PFR11] a reason phrase Response would refuse is not forwarded and never crashes the process', async function () {
    const rawAnswer = (head) => {
      const server = net.createServer((socket) => {
        socket.once('data', () => socket.end(head + 'content-length: 2\r\nconnection: close\r\n\r\n{}'));
      });
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
    };
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const servers = [];
    try {
      const del = await rawAnswer('HTTP/1.1 200 A\x7fB\r\n');
      servers.push(del);
      const delRes = await peerFetch(`http://127.0.0.1:${del.address().port}/events`, {}, settings(['127.0.0.1']));
      assert.equal(delRes.status, 200);
      assert.equal(delRes.statusText, '', 'the peer reason phrase is not forwarded');
      assert.deepEqual(await delRes.json(), {});
      const spaced = await rawAnswer('HTTP/1.1 200 OK\r\nx-pad:  value\r\n');
      servers.push(spaced);
      const res = await peerFetch(`http://127.0.0.1:${spaced.address().port}/events`, {}, settings(['127.0.0.1']));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {});
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaught, []);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      for (const s of servers) await new Promise((resolve) => s.close(resolve));
    }
  });
});
