/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/* global it, assert, describe, before, beforeEach */

const { setTimeout } = require('timers/promises');
const net = require('node:net');
const cache = require('cache');
const synchro = require('../../src/synchro');
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
    for (const userId of synchro.listenerMap.keys()) {
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

  it('[8M1B] Registered listener should be removed on clearEvent', async () => {
    cache.setStreams('toto-id', 'test', 'titi');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    cache.unsetUserData('toto-id');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), false, 'should be removed');
  });

  it('[KF7E] Registered listener should be removed on unsetUser', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'test', 'titi');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    cache.unsetUser('toto');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), false, 'should be removed');
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
    cache.setStreams('toto-id', 'test', 'titi');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    await setTimeout(50);
    tcpPublish('cache.toto-id', 'toto-id', { action: MESSAGES.UNSET_USER_DATA });
    await setTimeout(50);
    assert.strictEqual(synchro.listenerMap.has('toto-id'), false, 'should be removed');
  });

  it('[Y5GU] Listeners should receive transport messages UNSET_USER', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'test', 'titi');
    assert.strictEqual(cache.getUserId('toto'), 'toto-id', 'userId should be cached');
    assert.strictEqual(synchro.listenerMap.has('toto-id'), true, 'should be registered');
    await setTimeout(50);
    tcpPublish('cache.unset-user', 'unset-user', { action: MESSAGES.UNSET_USER, username: 'toto' });
    await setTimeout(50);
    assert.strictEqual(synchro.listenerMap.has('toto-id'), false, 'listner should be removed');
    assert.strictEqual(cache.getUserId('toto'), undefined, 'userId should be removed');
  });
});
