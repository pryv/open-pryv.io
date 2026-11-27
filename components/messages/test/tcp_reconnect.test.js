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
const { describeBindError } = require('test-helpers/src/portHolder.ts');

// Minimal newline-delimited-JSON broker that speaks the tcp_pubsub protocol, so
// the module joins as a client and we control when the broker dies.
function makeRawBroker (port, answers = { subok: false, pong: false }) {
  const sockets = new Set();
  const subs = new Map(); // scope → Set<socket>
  const pubs = []; // events published to this broker, in order
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
          if (answers.subok) socket.write(JSON.stringify({ t: 'subok', scope: msg.scope, n: msg.n }) + '\n');
        } else if (msg.t === 'ping') {
          if (answers.blockOnceMs) {
            // Same process as the module: blocks its event loop with a ping outstanding.
            const until = Date.now() + answers.blockOnceMs;
            answers.blockOnceMs = 0;
            while (Date.now() < until) { /* busy */ }
          }
          if (answers.pong) socket.write(JSON.stringify({ t: 'pong' }) + '\n');
        } else if (msg.t === 'unsub') {
          subs.get(msg.scope)?.delete(socket);
        } else if (msg.t === 'pub') {
          pubs.push(msg.event);
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
    pubs,
    listen () {
      return new Promise((resolve, reject) => {
        // A port collision here is an environment problem (another checkout or a
        // hand-started server on the canonical port), not a pubsub defect: name
        // the holder rather than failing with a bare EADDRINUSE.
        const rejectDescribed = (err) => reject(describeBindError(err, port, 'tcpBroker:port'));
        server.once('error', rejectDescribed);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', rejectDescribed); resolve(); });
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

  it('[RC18] delivers while the broker is up (baseline)', async () => {
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

  it('[RC20] a subscription is confirmed only once the broker acknowledged it', async () => {
    // The default raw broker routes but never acknowledges.
    const unconfirmed = await tcpPubsub.subscribe('rc20-silent', stub);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(unconfirmed.isConfirmed(), false, 'not acknowledged: not confirmed');
    tcpPubsub._closeForTests();
    await rawBroker.kill();
    rawBroker = makeRawBroker(port, { subok: true, pong: true });
    await rawBroker.listen();
    await tcpPubsub.init();
    await waitFor(() => tcpPubsub._isConnectedForTests());
    const sub = await tcpPubsub.subscribe('rc20-acked', stub);
    await waitFor(() => sub.isConfirmed(), 4000);
    sub.unsubscribe();
    assert.strictEqual(sub.isConfirmed(), false, 'ended: no longer confirmed');
  });

  it('[RC21] a stale subscription released late does not end its successor', async () => {
    const first = await tcpPubsub.subscribe('rc21-scope', stub);
    const second = await tcpPubsub.subscribe('rc21-scope', stub);
    first.unsubscribe(); // late release of the earlier one
    await publishVia(port, 'rc21-scope', 'evt-rc21');
    await waitFor(() => received.includes('evt-rc21'));
    second.unsubscribe();
  });

  it('[RC22] a broker that stops answering is reported as a disconnection, its next answer as a reconnection', async () => {
    tcpPubsub._closeForTests();
    await rawBroker.kill();
    const answers = { subok: true, pong: true };
    rawBroker = makeRawBroker(port, answers);
    await rawBroker.listen();
    tcpPubsub._setHeartbeatForTests(50, 300);
    const states = [];
    const remove = tcpPubsub.onConnectionStateChange((state) => states.push(state));
    try {
      await tcpPubsub.init();
      await waitFor(() => tcpPubsub._isConnectedForTests()).catch((err) => { throw new Error(err.message + ' (connected) states=' + JSON.stringify(states)); });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepStrictEqual(states, [], 'answering broker: nothing reported');
      answers.pong = false; // stuck event loop: socket open, no answer
      await waitFor(() => states.includes('disconnected'), 3000).catch((err) => { throw new Error(err.message + ' (disconnected) states=' + JSON.stringify(states)); });
      assert.strictEqual(tcpPubsub._isConnectedForTests(), true, 'the socket itself stayed open');
      answers.pong = true;
      await waitFor(() => states.includes('reconnected'), 3000).catch((err) => { throw new Error(err.message + ' (reconnected) states=' + JSON.stringify(states)); });
      assert.deepStrictEqual(states, ['disconnected', 'reconnected']);
    } finally {
      remove();
      tcpPubsub._setHeartbeatForTests(1000, 5000);
    }
  });

  async function ackingBroker (answers = { subok: true, pong: true }) {
    tcpPubsub._closeForTests();
    await rawBroker.kill();
    rawBroker = makeRawBroker(port, answers);
    await rawBroker.listen();
    await tcpPubsub.init();
    await waitFor(() => tcpPubsub._isConnectedForTests());
  }

  it('[RC23] a confirmation does not survive the connection: lost with the broker, given again by the next one', async () => {
    await ackingBroker();
    const sub = await tcpPubsub.subscribe('rc23-scope', stub);
    await waitFor(() => sub.isConfirmed());
    await rawBroker.kill();
    rawBroker = null;
    await waitFor(() => !sub.isConfirmed(), 4000);
    // the module takes the freed port as broker and re-subscribes over TCP
    await waitFor(() => tcpPubsub._isConnectedForTests(), 8000);
    await waitFor(() => sub.isConfirmed(), 8000);
  });

  it('[RC24] a pause of this process\'s own event loop is not taken for a stalled broker', async () => {
    tcpPubsub._setHeartbeatForTests(50, 300);
    const states = [];
    const remove = tcpPubsub.onConnectionStateChange((state) => states.push(state));
    try {
      const answers = { subok: true, pong: true, blockOnceMs: 0 };
      await ackingBroker(answers);
      await new Promise((resolve) => setTimeout(resolve, 200));
      answers.blockOnceMs = 700; // at the next ping: blocked well past the deadline
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.strictEqual(answers.blockOnceMs, 0, 'the pause happened');
      assert.deepStrictEqual(states, [], 'nothing reported');
    } finally {
      remove();
      tcpPubsub._setHeartbeatForTests(1000, 5000);
    }
  });

  it('[RC25] what is published while disconnected is sent once the connection is back', async () => {
    await rawBroker.kill();
    await waitFor(() => !tcpPubsub._isConnectedForTests());
    // Take the freed port before the module's first reconnect attempt (200 ms).
    rawBroker = makeRawBroker(port);
    await rawBroker.listen();
    await tcpPubsub.deliver('rc25-scope', 'evt-gap', { action: 'x' }); // still disconnected
    await waitFor(() => rawBroker.pubs.includes('evt-gap'), 8000);
  });

  it('[RC26] flushPublished: routed once the broker answered after the publications, unreachable when it never answers, alone as a broker nobody joined', async () => {
    await ackingBroker();
    tcpPubsub.deliver('rc26-scope', 'evt-rc26a', ''); // not awaited, as a cache bust is sent
    tcpPubsub.deliver('rc26-scope', 'evt-rc26b', '');
    assert.strictEqual(await tcpPubsub.flushPublished(2000), 'routed');
    assert.deepStrictEqual(rawBroker.pubs.filter((e) => e.startsWith('evt-rc26')), ['evt-rc26a', 'evt-rc26b'], 'both handled by the broker before the answer');

    await ackingBroker({ subok: false, pong: true });
    const started = Date.now();
    assert.strictEqual(await tcpPubsub.flushPublished(300), 'unreachable');
    assert.ok(Date.now() - started < 2000, 'bounded by the timeout');

    tcpPubsub._closeForTests();
    await rawBroker.kill();
    rawBroker = null;
    await tcpPubsub.init(); // the port is free: the module is the broker
    await waitFor(() => tcpPubsub._isConnectedForTests());
    assert.strictEqual(await tcpPubsub.flushPublished(300), 'alone');
  });

  it('[RC19] tells listeners the connection dropped, then that it is back', async () => {
    const states = [];
    const remove = tcpPubsub.onConnectionStateChange((state) => states.push(state));
    try {
      await rawBroker.kill();
      rawBroker = null;
      await waitFor(() => states.includes('reconnected'), 8000);
      assert.strictEqual(states[0], 'disconnected', 'the drop is reported first');
      assert.strictEqual(states[states.length - 1], 'reconnected');
    } finally {
      remove();
    }
  });
});
