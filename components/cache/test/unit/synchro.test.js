/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global it, assert, describe, before, beforeEach */

const { setTimeout } = require('timers/promises');
const net = require('node:net');
const cache = require('cache').default;
const synchro = require('../../src/synchro.ts');
const MESSAGES = synchro.MESSAGES;
const { pubsub } = require('messages');
const { getConfig } = require('@pryv/boiler');

describe('[SYNC] Synchro', function () {
  let tcpClient;
  let port;

  before(async function () {
    const config = await getConfig();
    port = config.get('tcpBroker:port');
    tcpClient = await connectRawTcp(port);
  });

  // Helper: connect raw TCP client and wait for welcome
  function connectRawTcp (p) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: p, host: '127.0.0.1' }, () => {
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
          const msg = JSON.parse(line);
          if (msg.t === 'welcome') {
            resolve(socket);
          }
        }
      });
    });
  }

  // Helper: publish via raw TCP (same semantics as tcp_pubsub.deliver)
  function tcpPublish (scope, eventName, payload) {
    tcpClient.write(JSON.stringify({ t: 'pub', scope, event: eventName, payload }) + '\n');
  }

  beforeEach(() => {
    // empty eventual listener list
    for (const userId of [...synchro.listenerMap.keys()]) {
      synchro.removeListenerForUserId(userId);
    }
  });

  it('[LHGV] Should register listener on userId when using setStreams', () => {
    cache.setStreams('toto', 'test', 'titi');
    assert.strictEqual(synchro.listenerMap.has('toto'), true, 'should be registered');
  });

  it('[RYQD] Should register listener on userId when using setAccessLogic.', () => {
    cache.setAccessLogic('toto', { id: 'test', token: 'titi' });
    assert.strictEqual(synchro.listenerMap.has('toto'), true, 'should be registered');
  });

  it('[R7I6] Should unset access Logic on unset Message', async () => {
    cache.setAccessLogic('toto', { id: 'test', token: 'titi' });
    const al = cache.getAccessLogicForId('toto', 'test');
    assert.ok(al);
    assert.strictEqual(al.token, 'titi');
    await setTimeout(50);
    tcpPublish('cache.toto', 'toto', { action: MESSAGES.UNSET_ACCESS_LOGIC, accessId: 'test', accessToken: 'titi' });
    await setTimeout(50);
    assert.ok(cache.getAccessLogicForId('toto', 'test') == null);
  });

  it('[8M1B] Registered listener should be kept on a data bust (stream write)', async () => {
    cache.setStreams('toto-id', 'local', 'titi');
    assert.strictEqual(cache.getStreams('toto-id', 'local'), 'titi');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    cache.unsetUserData('toto-id');
    assert.ok(cache.getStreams('toto-id', 'local') == null, 'data should be cleared');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should still be registered');
  });

  it('[KF7E] unsetUser clears the name and the data', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'local', 'titi');
    assert.strictEqual(cache.getStreams('toto-id', 'local'), 'titi');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    cache.unsetUser('toto');
    assert.strictEqual(cache.getUserId('toto'), undefined, 'name should be cleared');
    assert.ok(cache.getStreams('toto-id', 'local') == null, 'data should be cleared');
  });

  it('[OKHQ] Listeners should not receive "internal" messages', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'test', 'titi');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    await setTimeout(50);
    pubsub.cache.emit('toto', { action: MESSAGES.UNSET_USER_DATA });
    await setTimeout(50);
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should not be removed');
  });

  it('[Y5GA] Listeners should receive transport messages UNSET_USER_DATA', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'local', 'titi');
    assert.strictEqual(cache.getStreams('toto-id', 'local'), 'titi');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    await setTimeout(50);
    tcpPublish('cache.toto-id', 'toto-id', { action: MESSAGES.UNSET_USER_DATA });
    await setTimeout(50);
    assert.ok(cache.getStreams('toto-id', 'local') == null, 'data should be cleared');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'listener should be kept');
  });

  it('[SYL1] a user whose listener goes has nothing served from the cache any more', () => {
    cache.setAccessLogic('syl1-id', { id: 'a', token: 'syl1-tok' });
    cache.setStreams('syl1-id', 'local', ['s']);
    assert.ok(cache.getAccessLogicForToken('syl1-id', 'syl1-tok') != null);
    synchro.removeListenerForUserId('syl1-id'); // same path as an eviction from the listener LRU
    assert.ok(cache.getAccessLogicForToken('syl1-id', 'syl1-tok') == null, 'accesses dropped with the listener');
    assert.ok(cache.getStreams('syl1-id', 'local') == null, 'streams dropped with the listener');
  });

  it('[SYL2] a cache hit keeps the user among the most recently followed', () => {
    cache.setAccessLogic('syl2-a', { id: 'a', token: 'syl2-tok' });
    cache.setStreams('syl2-b', 'local', ['s']);
    assert.strictEqual([...synchro.listenerMap.keys()][0], 'syl2-b');
    assert.ok(cache.getAccessLogicForToken('syl2-a', 'syl2-tok') != null);
    assert.strictEqual([...synchro.listenerMap.keys()][0], 'syl2-a', 'the hit refreshed the listener');
    assert.ok(cache.getStreams('syl2-b', 'local') != null);
    assert.strictEqual([...synchro.listenerMap.keys()][0], 'syl2-b');
  });

  it('[SYL3] a name lookup straddling a name bust does not re-cache the old mapping', async () => {
    for (let i = 0; i < 400 && cache.getUserIdEpoch() < 0; i++) await setTimeout(5);
    const epoch = cache.getUserIdEpoch();
    assert.ok(epoch >= 0, 'the name channel is followed');
    cache.unsetUser('syl3-name'); // a rename or deletion lands during the storage read
    cache.setUserId('syl3-name', 'syl3-old-id', true, epoch);
    assert.strictEqual(cache.getUserId('syl3-name'), undefined, 'stale mapping not cached');
    cache.setUserId('syl3-name', 'syl3-id', true, cache.getUserIdEpoch());
    assert.strictEqual(cache.getUserId('syl3-name'), 'syl3-id');
  });

  it('[Y5GU] Listeners should receive transport messages UNSET_USER', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'local', 'titi');
    assert.strictEqual(cache.getStreams('toto-id', 'local'), 'titi');
    assert.strictEqual(cache.getUserId('toto'), 'toto-id', 'userId should be cached');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    await setTimeout(50);
    tcpPublish('cache.unset-user', 'unset-user', { action: MESSAGES.UNSET_USER, username: 'toto' });
    await setTimeout(50);
    assert.ok(cache.getStreams('toto-id', 'local') == null, 'data should be cleared');
    assert.strictEqual(cache.getUserId('toto'), undefined, 'userId should be removed');
  });
});
