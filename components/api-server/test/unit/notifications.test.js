/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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

require('./test-helper');
const assert = require('chai').assert;
const { pubsub } = require('messages');

describe('Notifications', () => {
  let axonMsgs = [];
  let emittedMsgs = [];
  // Clear out received messages before each test.
  beforeEach(() => {
    axonMsgs = [];
    emittedMsgs = [];
  });
  // stub out axonSocket
  const axonSocket = {
    emit: (...args) => axonMsgs.push(args)
  };
  before(async () => {
    // intercept internal events
    pubsub.status.on(pubsub.SERVER_READY, (message) => {
      emittedMsgs.push(pubsub.SERVER_READY);
    });
    pubsub.notifications.on('USERNAME', (message) => {
      emittedMsgs.push(message);
    });
    // attach "fake" axonSocket to pubsub.
    pubsub.setTestNotifier(axonSocket);
  });
  describe('#serverReady', () => {
    beforeEach(() => {
      pubsub.status.emit(pubsub.SERVER_READY);
    });
    it('[B76G] notifies internal listeners', () => {
      assert.deepInclude(emittedMsgs, pubsub.SERVER_READY);
    });
    it('[SRAU] notifies axon listeners', () => {
      assert.deepInclude(axonMsgs, ['axon-server-ready']);
    });
  });
  describe('#accountChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    });
    it('[P6ZD] notifies internal listeners', () => {
      assert.deepInclude(emittedMsgs, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    });
    it('[Q96S] notifies axon listeners', () => {
      assert.deepInclude(axonMsgs, ['axon-account-changed', 'USERNAME']);
    });
  });
  describe('#accessesChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    });
    it('[P5CG] notifies internal listeners', () => {
      assert.deepInclude(emittedMsgs, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    });
    it('[VSN6] notifies axon listeners', () => {
      assert.deepInclude(axonMsgs, ['axon-accesses-changed', 'USERNAME']);
    });
  });
  describe('#followedSlicesChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_FOLLOWEDSLICES_CHANGED);
    });
    it('[VU4A] notifies internal listeners', () => {
      assert.deepInclude(emittedMsgs, pubsub.USERNAME_BASED_FOLLOWEDSLICES_CHANGED);
    });
    it('[UD2B] notifies axon listeners', () => {
      assert.deepInclude(axonMsgs, [
        'axon-followed-slices-changed',
        'USERNAME'
      ]);
    });
  });
  describe('#streamsChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_STREAMS_CHANGED);
    });
    it('[LDUQ] notifies internal listeners', () => {
      assert.deepInclude(emittedMsgs, pubsub.USERNAME_BASED_STREAMS_CHANGED);
    });
    it('[BUR1] notifies axon listeners', () => {
      assert.deepInclude(axonMsgs, ['axon-streams-changed', 'USERNAME']);
    });
  });
  describe('#eventsChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_EVENTS_CHANGED);
    });
    it('[N8RI] notifies internal listeners', () => {
      assert.deepInclude(emittedMsgs, pubsub.USERNAME_BASED_EVENTS_CHANGED);
    });
    it('[TRMW] notifies axon listeners', () => {
      assert.deepInclude(axonMsgs, ['axon-events-changed', 'USERNAME']);
    });
  });
});
