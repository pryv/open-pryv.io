/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global it, describe, before, after, afterEach */

const assert = require('node:assert');
const net = require('node:net');
const { setTimeout } = require('timers/promises');
const { getConfig } = require('@pryv/boiler');
const cache = require('cache').default;
const synchro = require('../../src/synchro.ts');
const { pubsub } = require('messages');
const tcpPubsub = require('messages/src/tcp_pubsub.ts');
const { injectTestConfigSnapshot } = require('test-helpers');

/**
 * Cached entries expire, a worker keeps following a user across data busts,
 * subscribes before it reads, drops its caches after a broker reconnect, and
 * account deletion reaches workers that only know the userId or an alias.
 */
describe('[CMAX] Cache max age and re-synchronisation', function () {
  let seq = 0;
  function freshUserId () { return 'cmax-' + (++seq) + '-' + process.pid; }

  before(async function () {
    await cache.loadConfiguration();
  });

  describe('[CMAX-A] max age', function () {
    let restore;
    before(async function () {
      restore = injectTestConfigSnapshot({ caching: { accessMaxAgeSeconds: 0.1 } });
      await cache.loadConfiguration();
    });
    after(async function () {
      restore();
      await cache.loadConfiguration();
    });

    it('[CMA1] accesses, streams and name mappings are gone after the max age', async function () {
      const u = freshUserId();
      cache.setAccessLogic(u, { id: 'a', token: 'tok' });
      cache.setStreams(u, 'local', ['s']);
      cache.setUserId('name-' + u, u);
      assert.ok(cache.getAccessLogicForToken(u, 'tok') != null, 'cached right after the fill');
      assert.ok(cache.getStreams(u, 'local') != null);
      assert.strictEqual(cache.getUserId('name-' + u), u);
      await setTimeout(250);
      assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'access must expire');
      assert.ok(cache.getStreams(u, 'local') == null, 'streams must expire');
      assert.ok(cache.getUserId('name-' + u) == null, 'name mapping must expire');
    });
  });

  describe('[CMAX-B] invalid max age', function () {
    let restore;
    before(async function () {
      restore = injectTestConfigSnapshot({ caching: { accessMaxAgeSeconds: 0 } });
      await cache.loadConfiguration();
    });
    after(async function () {
      restore();
      await cache.loadConfiguration();
    });

    it('[CMA2] 0 falls back to the default instead of "never expire"', async function () {
      const u = freshUserId();
      cache.setAccessLogic(u, { id: 'a', token: 'tok' });
      // default (60 s) applies: still cached now, and the LRU carries a ttl
      assert.ok(cache.getAccessLogicForToken(u, 'tok') != null);
      assert.strictEqual(cache.getMaxAgeMs(), 60000);
    });
  });

  describe('[CMAX-C] listeners', function () {
    let rawClient;
    before(async function () {
      const config = await getConfig();
      rawClient = await connectRawTcp(config.get('tcpBroker:port'));
    });
    after(function () {
      rawClient.destroy();
    });

    it('[CMA3] a stream write (data bust) keeps the user followed', function () {
      const u = freshUserId();
      cache.setAccessLogic(u, { id: 'a', token: 'tok' });
      assert.strictEqual(synchro.listenerMap.has(u), true);
      cache.unsetUserData(u);
      assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'data cleared');
      assert.strictEqual(synchro.listenerMap.has(u), true, 'listener must be kept');
    });

    it('[CMA4] capturing the epoch subscribes before the read: a bust sent during the read fences the fill', async function () {
      const u = freshUserId();
      const epoch = cache.getAccessLogicEpoch(u); // before the storage read
      assert.strictEqual(synchro.listenerMap.has(u), true, 'followed before the read');
      await setTimeout(50); // subscription reaches the broker
      // another worker deletes the access while this one is still reading
      rawPublish(rawClient, 'cache.' + u, u, { action: synchro.MESSAGES.UNSET_ACCESS_LOGIC, accessId: 'a', accessToken: 'tok' });
      await setTimeout(50);
      cache.setAccessLogic(u, { id: 'a', token: 'tok' }, epoch); // read result arrives
      assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'stale read must not be cached');
    });
  });

  describe('[CMAX-D] broker reconnect', function () {
    afterEach(function () {
      tcpPubsub._emitConnectionStateForTests('reconnected'); // never leave the cache suspended
    });

    it('[CMA5] while disconnected nothing is served or cached; on reconnect everything is dropped and fills in flight are fenced', function () {
      const u = freshUserId();
      cache.setAccessLogic(u, { id: 'a', token: 'tok' });
      cache.setUserId('name-' + u, u);
      cache.setStreams(u, 'local', ['s']);
      const epochBefore = cache.getAccessLogicEpoch(u); // a fill in flight

      tcpPubsub._emitConnectionStateForTests('disconnected');
      assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'no hit while disconnected');
      assert.ok(cache.getUserId('name-' + u) == null);
      assert.ok(cache.getStreams(u, 'local') == null);
      cache.setAccessLogic(u, { id: 'b', token: 'tok-b' });
      cache.setUserId('other-' + u, u);

      tcpPubsub._emitConnectionStateForTests('reconnected');
      assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'entry from before the gap dropped');
      assert.ok(cache.getAccessLogicForToken(u, 'tok-b') == null, 'nothing cached during the gap');
      assert.ok(cache.getUserId('name-' + u) == null, 'names dropped');
      assert.ok(cache.getUserId('other-' + u) == null);
      assert.ok(cache.getStreams(u, 'local') == null, 'streams dropped');
      cache.setAccessLogic(u, { id: 'a', token: 'tok' }, epochBefore);
      assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'fill started before the reconnect is fenced');
      // and normal caching resumes
      cache.setAccessLogic(u, { id: 'a', token: 'tok' }, cache.getAccessLogicEpoch(u));
      assert.ok(cache.getAccessLogicForToken(u, 'tok') != null);
    });
  });

  describe('[CMAX-E] account deletion', function () {
    let delivered;
    let rawClient;
    before(async function () {
      const config = await getConfig();
      rawClient = await connectRawTcp(config.get('tcpBroker:port'));
    });
    after(function () {
      rawClient.destroy();
    });
    afterEach(function () {
      pubsub.setTestDeliverHook(null);
    });
    function captureDeliveries () {
      delivered = [];
      pubsub.setTestDeliverHook((scope, event, payload) => { delivered.push({ scope, event, payload }); });
    }

    it('[CMA6] unsetUser broadcasts even when this process does not know the name', async function () {
      captureDeliveries();
      cache.unsetUser('unknown-name-' + freshUserId());
      await setTimeout(20);
      const msg = delivered.find((d) => d.scope === 'cache.unset-user');
      assert.ok(msg != null, 'name bust must be sent');
    });

    it('[CMA7] unsetUserById broadcasts the userId and clears data and every name pointing to it', async function () {
      const u = freshUserId();
      cache.setUserId('name-' + u, u);
      cache.setUserId('alias-' + u, u);
      cache.setAccessLogic(u, { id: 'a', token: 'tok' });
      captureDeliveries();
      cache.unsetUserById(u);
      await setTimeout(20);
      const msg = delivered.find((d) => d.scope === 'cache.unset-user');
      assert.ok(msg != null, 'id bust must be sent');
      assert.strictEqual(msg.payload.userId, u);
      assert.ok(cache.getUserId('name-' + u) == null);
      assert.ok(cache.getUserId('alias-' + u) == null);
      assert.ok(cache.getAccessLogicForToken(u, 'tok') == null);
    });

    it('[CMA8] a receiver that only knows an alias clears it on an id-keyed bust', async function () {
      const u = freshUserId();
      cache.setUserId('alias-' + u, u); // only alias traffic reached this worker
      cache.setAccessLogic(u, { id: 'a', token: 'tok' });
      await setTimeout(50);
      // the deleting worker knew neither name: it sends the userId only
      rawPublish(rawClient, 'cache.unset-user', 'unset-user', { action: synchro.MESSAGES.UNSET_USER, userId: u });
      await setTimeout(80);
      assert.ok(cache.getUserId('alias-' + u) == null, 'alias mapping dropped');
      assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'accesses dropped');
    });
  });
});

function connectRawTcp (port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      socket.removeListener('error', reject);
    });
    socket.once('error', reject);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        if (JSON.parse(line).t === 'welcome') resolve(socket);
      }
    });
  });
}

function rawPublish (socket, scope, eventName, payload) {
  socket.write(JSON.stringify({ t: 'pub', scope, event: eventName, payload }) + '\n');
}
