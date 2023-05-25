/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
/* global it, assert, describe, before, beforeEach */

const { setTimeout } = require('timers/promises');
const cache = require('cache');
const synchro = require('../../src/synchro');
const MESSAGES = synchro.MESSAGES;
const { pubsub } = require('messages');
const { getConfig } = require('@pryv/boiler');

const { connect, JSONCodec } = require('nats');
const { encode } = JSONCodec();

describe('Synchro', function () {
  let natsClient;

  before(async function () {
    const config = await getConfig();
    if (config.get('openSource:isActive')) this.skip();

    const natsUri = config.get('nats:uri');
    natsClient = await connect({
      servers: natsUri,
      json: true
    });
  });

  beforeEach(() => {
    // empty eventual listener list
    for (const userId of synchro.listenerMap.keys()) {
      synchro.removeListenerForUserId(userId);
    }
  });

  it('[LHGV] Should register listener on userId when using setStreams', () => {
    cache.setStreams('toto', 'test', 'titi');
    assert.isTrue(synchro.listenerMap.has('toto'), 'should be registered');
  });

  it('[RYQD] Should register listener on userId when using setAccessLogic.', () => {
    cache.setAccessLogic('toto', { id: 'test', token: 'titi' });
    assert.isTrue(synchro.listenerMap.has('toto'), 'should be registered');
  });

  it('[R7I6] Should unset access Logic on unset Message', async () => {
    cache.setAccessLogic('toto', { id: 'test', token: 'titi' });
    const al = cache.getAccessLogicForId('toto', 'test');
    assert.exists(al);
    assert.equal(al.token, 'titi');
    await setTimeout(50);
    natsClient.publish('cache.toto', encode({ eventName: 'toto', payload: { action: MESSAGES.UNSET_ACCESS_LOGIC, accessId: 'test', accessToken: 'titi' } }));
    await setTimeout(50);
    assert.notExists(cache.getAccessLogicForId('toto', 'test'));
  });

  it('[8M1B] Registered listener should be removed on clearEvent', async () => {
    cache.setStreams('toto-id', 'test', 'titi');
    assert.isTrue(synchro.listenerMap.has('toto-id'), 'should be registered');
    cache.unsetUserData('toto-id');
    assert.isFalse(synchro.listenerMap.has('toto-id'), 'should be removed');
  });

  it('[KF7E] Registered listener should be removed on unsetUser', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'test', 'titi');
    assert.isTrue(synchro.listenerMap.has('toto-id'), 'should be registered');
    cache.unsetUser('toto');
    assert.isFalse(synchro.listenerMap.has('toto-id'), 'should be removed');
  });

  it('[OKHQ] Listeners should not receive "internal" messages', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'test', 'titi');
    assert.isTrue(synchro.listenerMap.has('toto-id'), 'should be registered');
    await setTimeout(50);
    pubsub.cache.emit('toto', { action: MESSAGES.UNSET_USER_DATA });
    await setTimeout(50);
    assert.isTrue(synchro.listenerMap.has('toto-id'), 'should not be removed');
  });

  it('[Y5GA] Listeners should receive "nats" messages UNSET_USER_DATA', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'test', 'titi');
    assert.isTrue(synchro.listenerMap.has('toto-id'), 'should be registered');
    await setTimeout(50);
    natsClient.publish('cache.toto-id', encode({ eventName: 'toto-id', payload: { action: MESSAGES.UNSET_USER_DATA } }));
    await setTimeout(50);
    assert.isFalse(synchro.listenerMap.has('toto-id'), 'should be removed');
  });

  it('[Y5GU] Listeners should receive "nats" messages UNSET_USER', async () => {
    cache.setUserId('toto', 'toto-id');
    cache.setStreams('toto-id', 'test', 'titi');
    assert.equal(cache.getUserId('toto'), 'toto-id', 'userId should be cached');
    assert.isTrue(synchro.listenerMap.has('toto-id'), 'should be registered');
    await setTimeout(50);
    natsClient.publish('cache.unset-user', encode({ eventName: 'unset-user', payload: { action: MESSAGES.UNSET_USER, username: 'toto' } }));
    await setTimeout(50);
    assert.isFalse(synchro.listenerMap.has('toto-id'), 'listner should be removed');
    assert.isUndefined(cache.getUserId('toto'), 'userId should be removed');
  });
});
