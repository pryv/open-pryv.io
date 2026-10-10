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
 * [APBS] A token's restrictions hold when several socket.io packets of the
 * same client are handled together.
 *
 * Every connection of a token shares the access object held in the access
 * cache. A namespace handshake expands that access again while a call on an
 * already open namespace of the same token reads it. The packets are sent in
 * ONE Engine.IO polling payload, so the server decodes them in the same turn of
 * the event loop: with an all-synchronous storage engine (SQLite) nothing
 * separates the two, and a reader must still never see the access without its
 * restrictions, nor keep a permission level computed from a partial view.
 */

const http = require('node:http');
const setupSocketIO = require('../src/socket-io/index.ts').default;

const FILLER_PERMISSIONS = 60; // permissions listed before the restrictions
const ROUNDS = 24; // batched payloads sent
const STREAMS_PER_ROUND = 8; // streams read by each subscription
const CALLS_PER_BATCH = 15; // webhooks.create attempts inside each callBatch
const RS = '\x1e'; // Engine.IO v4 polling payload separator

describe('[APBS] access restrictions with batched socket.io packets', function () {
  this.timeout(120000);
  let fixtures, server, port;
  let username, personalToken, hooksToken, writerToken;
  const plainStreams = [];
  const readOnlyStreams = [];

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username, {});
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    const streamId = cuid();
    await user.stream({ id: streamId, name: 'apbs-' + streamId });
    for (let i = 0; i < ROUNDS * STREAMS_PER_ROUND; i++) {
      const id = 'apbs-plain-' + i + '-' + cuid();
      await user.stream({ id, name: id });
      plainStreams.push(id);
    }
    for (let r = 0; r < ROUNDS; r++) {
      const id = 'apbs-read-only-' + r + '-' + cuid();
      await user.stream({ id, name: id });
      readOnlyStreams.push(id);
    }
    const fillers = (level) => {
      const res = [];
      for (let i = 0; i < FILLER_PERMISSIONS; i++) res.push({ streamId: 'apbs-filler-' + i, level });
      return res;
    };

    // Forbidden to use webhooks; the restriction comes last.
    hooksToken = cuid();
    await user.access({
      id: cuid(),
      type: 'app',
      token: hooksToken,
      name: 'apbs-hooks',
      permissions: [{ streamId, level: 'manage' }, ...fillers('read'), { feature: 'webhooks', setting: 'forbidden' }]
    });

    // Contributes everywhere but in the read-only streams, listed last.
    writerToken = cuid();
    await user.access({
      id: cuid(),
      type: 'app',
      token: writerToken,
      name: 'apbs-writer',
      permissions: [{ streamId: '*', level: 'contribute' }, ...fillers('contribute'),
        ...readOnlyStreams.map((id) => ({ streamId: id, level: 'read' }))]
    });

    server = http.createServer(app.expressApp);
    await setupSocketIO(server, app.api, app.getCustomAuthFunction('test'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async function () {
    if (server != null) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await fixtures.clean();
  });

  /** One Engine.IO polling request; resolves with the status and the body. */
  function eio (method, query, body) {
    const qs = new URLSearchParams(Object.assign({ EIO: '4', transport: 'polling' }, query)).toString();
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
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

  /**
   * A raw polling session connected to the user's namespace; received packets
   * are collected until a predicate holds.
   */
  async function openSession (token) {
    const open = await eio('GET', { auth: token });
    assert.strictEqual(open.status, 200, open.text);
    assert.ok(open.text.startsWith('0'), open.text);
    const sid = JSON.parse(open.text.slice(1)).sid;
    const received = [];
    const nsp = '/' + username;
    const session = {
      async send (packets) {
        const res = await eio('POST', { sid }, packets.join(RS));
        assert.strictEqual(res.status, 200, res.text);
      },
      async waitFor (predicate) {
        for (let polls = 0; polls < 50; polls++) {
          const index = received.findIndex(predicate);
          if (index >= 0) return received.splice(index, 1)[0];
          const res = await eio('GET', { sid });
          assert.strictEqual(res.status, 200, res.text);
          for (const packet of res.text.split(RS)) {
            if (packet === '2') { await session.send(['3']); continue; } // ping
            received.push(packet);
          }
        }
        throw new Error('expected packet not received; got: ' + JSON.stringify(received));
      },
      async connected (namespace) {
        await session.waitFor((p) => p.startsWith('40' + namespace + ','));
      },
      /** A call on the user's namespace, as a packet. */
      call (id, method, params) {
        return '42' + nsp + ',' + id + JSON.stringify([method, params]);
      },
      /** The arguments of the acknowledgement `id` on the user's namespace. */
      async ackOf (id) {
        const prefix = '43' + nsp + ',' + id + '[';
        const packet = await session.waitFor((p) => p.startsWith(prefix));
        return JSON.parse(packet.slice(prefix.length - 1));
      }
    };
    await session.send(['40' + nsp + ',']);
    await session.connected(nsp);
    return session;
  }

  /** The handshake packet of a new namespace of the same user. */
  function handshake (prefix) {
    return '40/' + prefix + '/' + username + ',';
  }

  async function storedWebhooksCount () {
    const res = await coreRequest.get('/' + username + '/webhooks').set('Authorization', personalToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.webhooks.length;
  }

  function assertForbidden (answer, what) {
    assert.ok(answer != null && answer.error != null, what + ' must be refused: ' + JSON.stringify(answer));
    assert.strictEqual(answer.error.id, 'forbidden', what + ': ' + JSON.stringify(answer));
  }

  it('[APBS1] a webhooks-forbidden token creates no webhook while another namespace of the same token connects', async function () {
    const session = await openSession(hooksToken);
    assert.strictEqual(await storedWebhooksCount(), 0);
    const url = 'https://example.com/apbs';
    let ackId = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const singleId = ++ackId;
      const batchId = ++ackId;
      const batch = [];
      for (let i = 0; i < CALLS_PER_BATCH; i++) batch.push({ method: 'webhooks.create', params: { url } });
      const otherNsp = 'apbs-hooks-' + round;
      await session.send([
        handshake(otherNsp),
        session.call(singleId, 'webhooks.create', { url }),
        session.call(batchId, 'callBatch', batch)
      ]);
      const [singleAnswer] = await session.ackOf(singleId);
      assertForbidden(singleAnswer, 'round ' + round + ' single call');
      const [batchError, batchResult] = await session.ackOf(batchId);
      assert.ok(batchError == null, JSON.stringify(batchError));
      batchResult.results.forEach((answer, i) => assertForbidden(answer, 'round ' + round + ' batched call ' + i));
      await session.connected('/' + otherNsp + '/' + username);
    }
    assert.strictEqual(await storedWebhooksCount(), 0);
  });

  it('[APBS2] read-only streams under a contribute grant stay read-only after subscriptions read them during a handshake', async function () {
    const session = await openSession(writerToken);
    let ackId = 0;
    for (let round = 0; round < ROUNDS; round++) {
      // Fresh streams each round, the read-only one at a different position,
      // so its level is first computed at a different moment of the handshake.
      const streams = plainStreams.slice(round * STREAMS_PER_ROUND, (round + 1) * STREAMS_PER_ROUND);
      streams.splice(round % STREAMS_PER_ROUND, 0, readOnlyStreams[round]);
      const id = ++ackId;
      const otherNsp = 'apbs-subscribe-' + round;
      await session.send([
        handshake(otherNsp),
        session.call(id, 'subscribe', { key: 'apbs-' + round, kind: 'events', query: { streams } })
      ]);
      const [err] = await session.ackOf(id);
      assert.ok(err == null, JSON.stringify(err));
      await session.connected('/' + otherNsp + '/' + username);
    }
    const written = [];
    for (let round = 0; round < ROUNDS; round++) {
      const id = ++ackId;
      await session.send([session.call(id, 'events.create', { streamIds: [readOnlyStreams[round]], type: 'note/txt', content: 'apbs' })]);
      const [answer] = await session.ackOf(id);
      if (answer == null || answer.error == null) written.push(round);
      else assert.strictEqual(answer.error.id, 'forbidden', JSON.stringify(answer));
    }
    assert.deepStrictEqual(written, [], 'events were created in read-only streams');
  });
});
