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
 * [SIOL] socket.io ceilings, per server process: connections per access and
 * per account (refused at the handshake), calls running at once on one
 * connection, subscription scopes per connection (and the length of a scope
 * key). 0 turns a ceiling off. Revalidating the connections after access
 * changes is coalesced, so a burst of changes does not read every
 * connection's access from storage once per change.
 */

const http = require('node:http');
const ioClient = require('socket.io-client');
const setupSocketIO = require('../src/socket-io/index.ts').default;
const { NamespaceContext } = require('../src/socket-io/Manager.ts');
const { injectTestConfigSnapshot, pollUntil } = require('test-helpers');

describe('[SIOL] socket.io ceilings', function () {
  this.timeout(30000);
  let fixtures, username, userId, personalToken, sharedToken, streamId;
  let server, socketServer, port, manager;
  let restoreConfig = null;
  const conns = [];
  // While `holding`, calls reaching the API wait in `held` until released.
  let holding = false;
  const held = [];

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = ('siol' + cuid.slug()).toLowerCase();
    personalToken = cuid();
    sharedToken = cuid();
    streamId = 'siol-' + cuid.slug();
    const user = await fixtures.user(username);
    await user.stream({ id: streamId, name: streamId });
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    await user.access({ id: cuid(), type: 'shared', token: sharedToken, name: 'siol-shared', permissions: [{ streamId: '*', level: 'read' }] });
    const usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    userId = await usersRepository.getUserIdForUsername(username);

    const api = {
      call (context, params, callback) {
        if (holding) held.push(() => app.api.call(context, params, callback));
        else app.api.call(context, params, callback);
      }
    };
    server = http.createServer(app.expressApp);
    const setup = await setupSocketIO(server, api, app.getCustomAuthFunction('test'));
    socketServer = setup.io;
    manager = setup.manager;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterEach(async function () {
    holding = false;
    for (const release of held.splice(0)) release();
    for (const conn of conns.splice(0)) conn.disconnect();
    // Every slot is given back before the next test counts again.
    const left = await pollUntil(async () => manager.connectionsPerUser.size, (size) => size === 0, { timeoutMs: 5000 });
    if (restoreConfig != null) { restoreConfig(); restoreConfig = null; }
    assert.strictEqual(left, 0, 'every connection slot was given back');
  });

  after(async function () {
    server.closeAllConnections();
    await new Promise((resolve) => socketServer.close(() => resolve()));
    await fixtures.clean();
  });

  function setLimits (limits) {
    restoreConfig = injectTestConfigSnapshot({ socketIO: limits });
  }

  /** Connect with `token`; resolves `{ conn }` once connected or `{ conn, err }` when refused. */
  function connect (token) {
    const conn = ioClient.connect(`http://127.0.0.1:${port}/${username}?auth=${token}`,
      { forceNew: true, transports: ['websocket'], reconnection: false });
    conns.push(conn);
    return new Promise((resolve) => {
      conn.once('connect', () => resolve({ conn }));
      conn.once('connect_error', (err) => resolve({ conn, err }));
    });
  }

  async function assertConnects (token) {
    const { conn, err } = await connect(token);
    assert.strictEqual(err, undefined, 'connected: ' + err?.message);
    return conn;
  }

  async function assertRefused (token) {
    const { err } = await connect(token);
    assert.ok(err != null, 'the connection is refused');
    assert.strictEqual(err.data?.id, 'too-many-requests', JSON.stringify(err.data));
    assert.strictEqual(err.data.message, err.message);
  }

  /** Slots held for the test account, once the server has caught up to `expected`. */
  async function slotsHeld (expected) {
    return await pollUntil(async () => manager.connectionsPerUser.get(userId) ?? 0, (n) => n === expected, { timeoutMs: 5000 });
  }

  function call (conn, method, params) {
    return new Promise((resolve) => conn.emit(method, params, (err, result) => resolve({ err, result })));
  }

  it('[SIOL1] past maxConnectionsPerAccess, a connection with that access is refused with too-many-requests', async function () {
    setLimits({ maxConnectionsPerAccess: 2, maxConnectionsPerUser: 0 });
    await assertConnects(personalToken);
    await assertConnects(personalToken);
    await assertRefused(personalToken);
    // Another access of the account still connects.
    await assertConnects(sharedToken);
  });

  it('[SIOL2] a slot given back by a disconnect is usable again, and a refused handshake holds none', async function () {
    setLimits({ maxConnectionsPerAccess: 2, maxConnectionsPerUser: 0 });
    const first = await assertConnects(personalToken);
    await assertConnects(personalToken);
    await assertRefused(personalToken);
    assert.strictEqual(await slotsHeld(2), 2);
    first.disconnect();
    assert.strictEqual(await slotsHeld(1), 1);
    await assertConnects(personalToken);
    await assertRefused(personalToken);
  });

  it('[SIOL3] past maxConnectionsPerUser, a connection of the account is refused whatever its access', async function () {
    setLimits({ maxConnectionsPerAccess: 0, maxConnectionsPerUser: 2 });
    await assertConnects(personalToken);
    await assertConnects(sharedToken);
    await assertRefused(sharedToken);
    await assertRefused(personalToken);
  });

  it('[SIOL4] 0 turns the connection ceilings off', async function () {
    setLimits({ maxConnectionsPerAccess: 0, maxConnectionsPerUser: 0 });
    for (let i = 0; i < 4; i++) await assertConnects(personalToken);
  });

  it('[SIOL5] past maxInflightCallsPerConnection running calls, a call is answered with too-many-requests without running', async function () {
    setLimits({ maxInflightCallsPerConnection: 2 });
    const conn = await assertConnects(personalToken);
    holding = true;
    const first = call(conn, 'getAccessInfo', {});
    const second = call(conn, 'getAccessInfo', {});
    // Messages of one socket are handled in order: these two are running.
    const third = await call(conn, 'getAccessInfo', {});
    assert.strictEqual(third.err?.error?.id, 'too-many-requests', JSON.stringify(third));
    // Subscription messages count as calls.
    const subscriptions = await call(conn, 'getSubscriptions', {});
    assert.strictEqual(subscriptions.err?.error?.id, 'too-many-requests', JSON.stringify(subscriptions));
    assert.strictEqual(held.length, 2, 'the refused call never reached the API');
    holding = false;
    for (const release of held.splice(0)) release();
    for (const answer of await Promise.all([first, second])) {
      assert.ok(answer.err == null, JSON.stringify(answer.err));
      assert.strictEqual(answer.result.type, 'personal');
    }
    // Answered calls give their place back.
    const after = await call(conn, 'getAccessInfo', {});
    assert.ok(after.err == null, JSON.stringify(after.err));
  });

  it('[SIOL6] a subscribe past maxScopesPerConnection is refused and adds none of its scopes', async function () {
    setLimits({ maxScopesPerConnection: 2 });
    const conn = await assertConnects(personalToken);
    const query = { streams: [streamId] };
    const tooMany = await call(conn, 'subscribe', { scopes: { a: { query }, b: { query }, c: { query } } });
    assert.strictEqual(tooMany.err?.error?.id, 'invalid-operation', JSON.stringify(tooMany));
    assert.deepStrictEqual((await call(conn, 'getSubscriptions', {})).result.scopes, {});

    const two = await call(conn, 'subscribe', { scopes: { a: { query }, b: { query } } });
    assert.ok(two.err == null, JSON.stringify(two.err));
    const third = await call(conn, 'subscribe', { key: 'c', query });
    assert.strictEqual(third.err?.error?.id, 'invalid-operation', JSON.stringify(third));
    // Replacing a held key adds no scope.
    const replaced = await call(conn, 'subscribe', { key: 'a', query });
    assert.ok(replaced.err == null, JSON.stringify(replaced.err));
    assert.deepStrictEqual(Object.keys((await call(conn, 'getSubscriptions', {})).result.scopes).sort(), ['a', 'b']);
  });

  it('[SIOL7] a scope key longer than 256 characters is refused with invalid-parameters-format', async function () {
    const conn = await assertConnects(personalToken);
    const query = { streams: [streamId] };
    const long = await call(conn, 'subscribe', { key: 'k'.repeat(257), query });
    assert.strictEqual(long.err?.error?.id, 'invalid-parameters-format', JSON.stringify(long));
    const longest = await call(conn, 'subscribe', { key: 'k'.repeat(256), query });
    assert.ok(longest.err == null, JSON.stringify(longest.err));
  });

  it('[SIOL8] a burst of access changes revalidates the connections at most twice: at once, then once at the end of the window', async function () {
    const logger = { warn () {}, info () {}, debug () {}, error () {} };
    const context = new NamespaceContext('someone', { name: '/someone', emit () {} }, {}, logger, null, 'host', {}, null);
    let reads = 0;
    // Stands in for a connection: each revalidation reads its access from storage.
    context.connections.set('socket-1', { revalidate: async () => { reads++; } });
    try {
      for (let i = 0; i < 20; i++) context.revalidateConnections();
      assert.strictEqual(reads, 1, 'the first change revalidates at once');
      await new Promise((resolve) => setTimeout(resolve, 1300));
      assert.strictEqual(reads, 2, 'the other changes cost one trailing pass');
      // A new burst less than a window after the trailing pass waits for the
      // end of the window; closing the context cancels that pass.
      for (let i = 0; i < 5; i++) context.revalidateConnections();
      assert.strictEqual(reads, 2, 'a change inside the window does not run at once');
      await context.close();
      await new Promise((resolve) => setTimeout(resolve, 1300));
      assert.strictEqual(reads, 2, 'a closed context runs no scheduled pass');
    } finally {
      await context.close();
    }
  });
});
