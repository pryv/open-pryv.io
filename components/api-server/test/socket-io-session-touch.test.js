/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, getNewFixture, assert, cuid, app */

/**
 * [SIST] An open socket keeps a personal session alive only by its calls: the
 * periodic re-validation re-checks the access and the session without
 * extending it, and calls extend it at most once a minute per connection.
 */

const http = require('node:http');
const ioClient = require('socket.io-client');
const setupSocketIO = require('../src/socket-io/index.ts').default;
const { pollUntil } = require('test-helpers');

describe('[SIST] socket.io session touch', function () {
  this.timeout(30000);
  let fixtures, username, personalToken;
  let server, socketServer, port, manager, sessions, originalTouch, originalGet;
  const counts = { touch: 0, get: 0 };
  const conns = [];

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = ('sist' + cuid.slug()).toLowerCase();
    personalToken = cuid();
    const user = await fixtures.user(username);
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    server = http.createServer(app.expressApp);
    const setup = await setupSocketIO(server, app.api, app.getCustomAuthFunction('test'));
    socketServer = setup.io;
    manager = setup.manager;
    sessions = manager.storageLayer.sessions;
    originalTouch = sessions.touch;
    originalGet = sessions.get;
    sessions.touch = function (...args) { counts.touch++; return originalTouch.apply(this, args); };
    sessions.get = function (...args) { counts.get++; return originalGet.apply(this, args); };
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterEach(async function () {
    for (const conn of conns.splice(0)) conn.disconnect();
    await pollUntil(async () => manager.connectionsPerUser.size, (size) => size === 0, { timeoutMs: 5000 });
  });

  after(async function () {
    sessions.touch = originalTouch;
    sessions.get = originalGet;
    server.closeAllConnections();
    await new Promise((resolve) => socketServer.close(() => resolve()));
    await fixtures.clean();
  });

  async function connect () {
    const conn = ioClient.connect(`http://127.0.0.1:${port}/${username}?auth=${personalToken}`,
      { forceNew: true, transports: ['websocket'], reconnection: false });
    conns.push(conn);
    const err = await new Promise((resolve) => {
      conn.once('connect', () => resolve(undefined));
      conn.once('connect_error', (e) => resolve(e));
    });
    assert.strictEqual(err, undefined, 'connected: ' + err?.message);
    return conn;
  }

  /** The server side of the only open connection of the test account. */
  async function serverConnection () {
    return await pollUntil(async () => {
      const all = [...manager.contexts.values()].flatMap((context) => [...context.connections.values()]);
      return all[0] ?? null;
    }, (c) => c != null, { timeoutMs: 5000 });
  }

  function call (conn, method, params) {
    return new Promise((resolve) => conn.emit(method, params, (err, result) => resolve({ err, result })));
  }

  it('[SIST1] the periodic re-validation checks the session but does not extend it', async function () {
    const conn = await connect();
    const serverConn = await serverConnection();
    counts.touch = 0;
    counts.get = 0;
    await serverConn.revalidate(manager.storageLayer);
    assert.ok(counts.get >= 1, 'the session was read');
    assert.strictEqual(counts.touch, 0, 'the session was not extended');
    assert.strictEqual(conn.connected, true, 'the connection stays open');
  });

  it('[SIST2] calls extend the session at most once per minute and connection', async function () {
    const conn = await connect();
    const serverConn = await serverConnection();
    counts.touch = 0;
    const first = await call(conn, 'streams.get', {});
    assert.ok(first.err == null, JSON.stringify(first.err));
    assert.strictEqual(counts.touch, 0, 'the handshake extended it less than a minute ago');
    serverConn.lastSessionTouchAt -= 61_000;
    await call(conn, 'streams.get', {});
    assert.strictEqual(counts.touch, 1, 'a call a minute later extends it');
    await call(conn, 'streams.get', {});
    assert.strictEqual(counts.touch, 1, 'not again within the minute');
  });
});
