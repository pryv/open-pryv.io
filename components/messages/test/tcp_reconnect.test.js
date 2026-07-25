/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Regression: a worker that loses the pubsub broker must reconnect, re-subscribe,
// and resume receiving cache invalidations — otherwise it keeps serving stale
// cache (e.g. a revoked access) forever. See the broker-loss path in tcp_pubsub.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('test-helpers/src/api-server-tests-config.ts');
require('api-server/test/unit/test-helper');
const assert = require('node:assert');
const net = require('node:net');
const { getConfig } = require('@pryv/boiler');

const tcpPubsub = require('../src/tcp_pubsub.ts');

// Minimal newline-delimited-JSON broker that speaks the tcp_pubsub protocol, so
// the module joins as a client and we control when the broker dies.
function makeRawBroker (port) {
  const sockets = new Set();
  const subs = new Map(); // scope → Set<socket>
  let nextCid = 1;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.write(JSON.stringify({ t: 'welcome', cid: 'raw' + (nextCid++) }) + '\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        const msg = JSON.parse(line);
        if (msg.t === 'sub') {
          if (!subs.has(msg.scope)) subs.set(msg.scope, new Set());
          subs.get(msg.scope).add(socket);
        } else if (msg.t === 'unsub') {
          subs.get(msg.scope)?.delete(socket);
        } else if (msg.t === 'pub') {
          const out = JSON.stringify({ t: 'msg', scope: msg.scope, event: msg.event, payload: msg.payload }) + '\n';
          for (const s of subs.get(msg.scope) ?? []) {
            if (s !== socket && !s.destroyed) s.write(out);
          }
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    listen () {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
    },
    // Kill the broker like a crashed/recycled worker: drop every socket, free the port.
    kill () {
      return new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      });
    }
  };
}

function waitFor (predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); } else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('timeout waiting for condition')); }
    }, 25);
  });
}

describe('[PRCN] TcpPubsub reconnect after broker loss', function () {
  this.timeout(15000);
  let port;
  let rawBroker;
  const received = [];
  const stub = { _emit: (eventName) => received.push(eventName) };

  before(async () => {
    const config = await getConfig();
    port = config.get('tcpBroker:port');
  });

  beforeEach(async () => {
    received.length = 0;
    // Release any broker the module owns from earlier tests, then occupy the port
    // ourselves so the module joins as a plain client we can cut off at will.
    tcpPubsub._closeForTests();
    rawBroker = makeRawBroker(port);
    await rawBroker.listen();
    await tcpPubsub.init();
    await tcpPubsub.subscribe('reconn-scope', stub);
    await waitFor(() => tcpPubsub._isConnectedForTests());
  });

  afterEach(async () => {
    tcpPubsub._closeForTests();
    if (rawBroker) await rawBroker.kill();
  });

  function publishVia (targetPort, scope, event) {
    return new Promise((resolve, reject) => {
      const c = net.createConnection({ port: targetPort, host: '127.0.0.1' }, () => {});
      let buffer = '';
      c.once('error', reject);
      c.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length === 0) continue;
          if (JSON.parse(line).t === 'welcome') {
            c.write(JSON.stringify({ t: 'pub', scope, event, payload: '' }) + '\n');
            setTimeout(() => { c.destroy(); resolve(); }, 100);
          }
        }
      });
    });
  }

  it('[RC01] delivers while the broker is up (baseline)', async () => {
    await publishVia(port, 'reconn-scope', 'evt-before');
    await waitFor(() => received.includes('evt-before'));
    assert.ok(received.includes('evt-before'));
  });

  it('[RC02] reconnects, re-subscribes and resumes delivery after the broker dies', async () => {
    // Baseline delivery works.
    await publishVia(port, 'reconn-scope', 'evt-before');
    await waitFor(() => received.includes('evt-before'));

    // Broker dies: sockets dropped, port freed. The module must not go permanently deaf.
    await rawBroker.kill();
    rawBroker = null;

    // The module reconnects; with the port now free it elects itself broker.
    await waitFor(() => tcpPubsub._isConnectedForTests(), 8000);
    received.length = 0;

    // Publish through whoever now owns the port (the module's own broker). Delivery
    // resuming proves the subscription was restored on reconnect. Retry because the
    // re-subscribe round-trip may not have registered on the first publish.
    const deadline = Date.now() + 8000;
    while (!received.includes('evt-after') && Date.now() < deadline) {
      try { await publishVia(port, 'reconn-scope', 'evt-after'); } catch (e) { /* broker not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(received.includes('evt-after'), 'invalidation delivered after reconnect');
  });
});
