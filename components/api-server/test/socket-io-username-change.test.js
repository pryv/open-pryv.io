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
 * [SIUC] a socket connected before a username change does not stay open
 * listening under the former name: it is disconnected by the server, and a
 * socket opened again (by either name) receives the account's notifications.
 */

const http = require('node:http');
const ioClient = require('socket.io-client');
const setupSocketIO = require('../src/socket-io/index.ts').default;

const PASSWORD = 'siuc-passw0rd';

describe('[SIUC] socket.io after a username change', function () {
  this.timeout(30000);
  let fixtures, username, personalToken, port;
  const servers = [];
  const clients = [];

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = ('siuc' + cuid.slug()).toLowerCase();
    personalToken = cuid();
    const user = await fixtures.user(username, { password: PASSWORD });
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    const s = http.createServer(app.expressApp);
    const setup = await setupSocketIO(s, app.api, app.getCustomAuthFunction('test'));
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
    servers.push({ s, socketServer: setup?.io });
    port = s.address().port;
  });

  after(async function () {
    for (const c of clients) c.disconnect();
    for (const { s, socketServer } of servers) {
      s.closeAllConnections();
      if (socketServer != null) await new Promise((resolve) => socketServer.close(() => resolve()));
      else await new Promise((resolve) => s.close(resolve));
    }
    await fixtures.clean();
  });

  function connect (name) {
    const c = ioClient.connect(`http://127.0.0.1:${port}/${name}?auth=${personalToken}`, { forceNew: true, transports: ['websocket'], reconnection: false });
    clients.push(c);
    return c;
  }

  function once (emitter, name, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ' + name + ' within ' + timeoutMs + ' ms')), timeoutMs);
      emitter.once(name, (arg) => { clearTimeout(timer); resolve(arg); });
      emitter.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  async function createEvent (name) {
    const streamId = 'siuc-' + cuid.slug();
    const stream = await coreRequest.post(`/${name}/streams`).set('Authorization', personalToken).send({ id: streamId, name: streamId });
    assert.strictEqual(stream.status, 201, JSON.stringify(stream.body));
    const event = await coreRequest.post(`/${name}/events`).set('Authorization', personalToken)
      .send({ streamIds: [streamId], type: 'note/txt', content: 'x' });
    assert.strictEqual(event.status, 201, JSON.stringify(event.body));
  }

  it('[SIUC1] the server disconnects the sockets of the former name; reopened by either name they are notified', async function () {
    const before = connect(username);
    await once(before, 'connect');
    const disconnected = once(before, 'disconnect');
    const newName = ('siud' + cuid.slug()).toLowerCase();
    const res = await coreRequest.post('/' + username + '/account/change-username')
      .set('Authorization', personalToken).send({ newUsername: newName });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await disconnected, 'io server disconnect');

    for (const name of [username, newName]) {
      const again = connect(name);
      await once(again, 'connect');
      const changed = once(again, 'eventsChanged');
      await createEvent(newName);
      await changed;
      again.disconnect();
    }
  });
});
