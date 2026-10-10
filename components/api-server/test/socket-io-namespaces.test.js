/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, app */

/**
 * [SION] socket.io namespaces: a namespace exists only for a name of the
 * user grammar (`/<username>` or `/<username>/<username>`), is released when
 * its last socket leaves (including a socket refused at the handshake), and
 * notifications keep reaching a namespace opened again later. Messages are
 * bounded in size.
 */

const http = require('node:http');
const ioClient = require('socket.io-client');
const setupSocketIO = require('../src/socket-io/index.ts').default;
const { withInjectedConfig, pollUntil } = require('test-helpers');

const RS = '\x1e'; // Engine.IO v4 polling payload separator
const PASSWORD = 'sion-passw0rd';

describe('[SION] socket.io namespaces', function () {
  this.timeout(30000);
  let fixtures, username, personalToken;
  let port, io, manager;
  const servers = [];

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = ('sion' + cuid.slug()).toLowerCase();
    personalToken = cuid();
    const user = await fixtures.user(username, { password: PASSWORD });
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    ({ port, io, manager } = await startServer());
  });

  after(async function () {
    for (const { s, socketServer } of servers) {
      s.closeAllConnections();
      // Closing the socket.io server closes its engine and the HTTP server.
      if (socketServer != null) await new Promise((resolve) => socketServer.close(() => resolve()));
      else await new Promise((resolve) => s.close(resolve));
    }
    await fixtures.clean();
  });

  async function startServer () {
    const s = http.createServer(app.expressApp);
    const setup = await setupSocketIO(s, app.api, app.getCustomAuthFunction('test'));
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
    servers.push({ s, socketServer: setup?.io });
    return { port: s.address().port, io: setup?.io, manager: setup?.manager };
  }

  /** One Engine.IO polling request on `onPort`. */
  function eio (onPort, method, query, body) {
    const qs = new URLSearchParams(Object.assign({ EIO: '4', transport: 'polling' }, query)).toString();
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: onPort,
        method,
        path: '/socket.io/?' + qs,
        headers: body != null ? { 'Content-Type': 'text/plain;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) } : {}
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      if (body != null) req.write(body);
      req.end();
    });
  }

  /** A raw polling session without credentials. */
  async function openRawSession (onPort = port) {
    const open = await eio(onPort, 'GET', {});
    assert.strictEqual(open.status, 200, open.text);
    const sid = JSON.parse(open.text.slice(1)).sid;
    const received = [];
    return {
      sid,
      async send (packets) {
        return await eio(onPort, 'POST', { sid }, packets.join(RS));
      },
      async waitFor (predicate) {
        for (let polls = 0; polls < 50; polls++) {
          const index = received.findIndex(predicate);
          if (index >= 0) return received.splice(index, 1)[0];
          const res = await eio(onPort, 'GET', { sid });
          assert.strictEqual(res.status, 200, res.text);
          for (const packet of res.text.split(RS)) {
            if (packet === '2') { await eio(onPort, 'POST', { sid }, '3'); continue; }
            received.push(packet);
          }
        }
        throw new Error('expected packet not received; got: ' + JSON.stringify(received));
      }
    };
  }

  function connectClient (namespace) {
    return ioClient.connect(`http://127.0.0.1:${port}${namespace}?auth=${personalToken}`, { forceNew: true, transports: ['websocket'] });
  }

  function onceEvent (emitter, name) {
    return new Promise((resolve, reject) => {
      emitter.once(name, resolve);
      emitter.once('connect_error', reject);
    });
  }

  it('[SION1] a name outside the user grammar is refused before any namespace or authentication step exists', async function () {
    assert.ok(io != null, 'setupSocketIO answers its socket.io server');
    let authSteps = 0;
    const extract = manager.extractUsername.bind(manager);
    manager.extractUsername = (name) => { authSteps++; return extract(name); };
    try {
      const before = io._nsps.size;
      const names = [
        '/abc', // too short to be a username
        '/x/' + username, // a prefix that is not a username
        '/' + username + '/', // trailing slash
        '/aaaaa/bbbbb/ccccc', // three segments
        '/' + 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/c', // over the length limit
        '/' + 'a'.repeat(129)
      ];
      const session = await openRawSession();
      const sent = await session.send(names.map((n) => '40' + n + ','));
      assert.strictEqual(sent.status, 200, sent.text);
      for (const name of names) {
        await session.waitFor((p) => p.startsWith('44' + name + ','));
      }
      assert.strictEqual(io._nsps.size, before, 'no namespace was created');
      assert.strictEqual(authSteps, 0, 'the authentication step never ran');
    } finally {
      manager.extractUsername = extract;
    }
  });

  it('[SION2] a name of the user grammar refused at authentication leaves no namespace behind', async function () {
    const name = '/nouser' + cuid.slug().toLowerCase();
    const session = await openRawSession();
    await session.send(['40' + name + ',']);
    await session.waitFor((p) => p.startsWith('44' + name + ','));
    assert.strictEqual(io._nsps.has(name), false, 'the refused namespace was released');
  });

  it('[SION3] both user forms connect; a namespace is released when its last socket leaves, and notifications reach it once reopened', async function () {
    const single = '/' + username;
    const dnsLess = '/' + username + '/' + username;
    for (const ns of [single, dnsLess]) {
      const conn = connectClient(ns);
      await onceEvent(conn, 'connect');
      assert.ok(io._nsps.has(ns), ns + ' is open');
      conn.disconnect();
      const open = await pollUntil(async () => io._nsps.has(ns), (isOpen) => !isOpen, { timeoutMs: 5000 });
      assert.strictEqual(open, false, ns + ' was released');
    }
    const conn = connectClient(single);
    try {
      await onceEvent(conn, 'connect');
      const changed = onceEvent(conn, 'eventsChanged');
      const streams = await coreRequest.get(`/${username}/streams`).set('Authorization', personalToken);
      assert.strictEqual(streams.status, 200, JSON.stringify(streams.body));
      const streamId = 'sion-' + cuid.slug();
      const created = await coreRequest.post(`/${username}/streams`).set('Authorization', personalToken).send({ id: streamId, name: streamId });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const event = await coreRequest.post(`/${username}/events`).set('Authorization', personalToken)
        .send({ streamIds: [streamId], type: 'note/txt', content: 'x' });
      assert.strictEqual(event.status, 201, JSON.stringify(event.body));
      await changed;
    } finally {
      conn.disconnect();
    }
  });

  function emitWithAck (conn, method, params) {
    return new Promise((resolve) => conn.emit(method, params, (err, result) => resolve({ err, result })));
  }

  it('[SION5] credential-less entry methods are refused over socket.io, directly and inside callBatch', async function () {
    const conn = connectClient('/' + username);
    try {
      await onceEvent(conn, 'connect');
      const loginParams = { username, password: PASSWORD, appId: 'pryv-test', origin: 'http://test.pryv.local' };
      const direct = await emitWithAck(conn, 'auth.login', loginParams);
      assert.strictEqual(direct.err?.error?.id, 'invalid-operation', JSON.stringify(direct));
      assert.strictEqual(direct.result, undefined);
      const recover = await emitWithAck(conn, 'mfa.recover', { username, password: PASSWORD, recoveryCode: 'x' });
      assert.strictEqual(recover.err?.error?.id, 'invalid-operation', JSON.stringify(recover));
      const batched = await emitWithAck(conn, 'callBatch', [
        { method: 'auth.login', params: loginParams },
        { method: 'callBatch', params: [{ method: 'getAccessInfo', params: {} }] },
        { method: 'getAccessInfo', params: {} }
      ]);
      assert.ok(batched.err == null, JSON.stringify(batched.err));
      const results = batched.result.results;
      assert.strictEqual(results[0].error?.id, 'invalid-operation', JSON.stringify(results[0]));
      assert.strictEqual(results[0].token, undefined);
      assert.strictEqual(results[1].error?.id, 'invalid-operation', JSON.stringify(results[1]));
      assert.strictEqual(results[2].type, 'personal');
    } finally {
      conn.disconnect();
    }
  });

  it('[SION4] a message larger than socketIO.maxMessageBytes is refused: a polling payload with 413, a websocket message by closing the connection', async function () {
    const small = await withInjectedConfig({ socketIO: { maxMessageBytes: 1000 } }, () => startServer());
    const session = await openRawSession(small.port);
    const big = await session.send(['42/' + username + ',' + JSON.stringify(['events.get', { pad: 'x'.repeat(2000) }])]);
    assert.strictEqual(big.status, 413, big.text);

    const conn = ioClient.connect(`http://127.0.0.1:${small.port}/${username}?auth=${personalToken}`,
      { forceNew: true, transports: ['websocket'], reconnection: false });
    try {
      await onceEvent(conn, 'connect');
      const closed = new Promise((resolve) => conn.once('disconnect', resolve));
      conn.emit('getAccessInfo', { pad: 'x'.repeat(2000) }, () => {});
      const reason = await closed;
      assert.ok(/transport (close|error)/.test(String(reason)), 'closed by the server: ' + reason);
    } finally {
      conn.disconnect();
    }
  });
});
