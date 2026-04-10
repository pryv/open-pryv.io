/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

require('./test-helper');
const assert = require('node:assert');
const { pubsub } = require('messages');

// Helper to replace chai's deepInclude
function assertDeepInclude (array, value) {
  const found = array.some(item => {
    try {
      assert.deepStrictEqual(item, value);
      return true;
    } catch { return false; }
  });
  assert.ok(found, `Expected array to deep-include ${JSON.stringify(value)}`);
}

describe('[NOTF] Notifications', () => {
  let testMsgs = [];
  let emittedMsgs = [];
  // Clear out received messages before each test.
  beforeEach(() => {
    testMsgs = [];
    emittedMsgs = [];
  });
  // stub out test notifier
  const testNotifier = {
    emit: (...args) => testMsgs.push(args)
  };
  before(async () => {
    // intercept internal events
    pubsub.status.on(pubsub.SERVER_READY, (message) => {
      emittedMsgs.push(pubsub.SERVER_READY);
    });
    pubsub.notifications.on('USERNAME', (message) => {
      emittedMsgs.push(message);
    });
    // attach "fake" test notifier to pubsub.
    pubsub.setTestNotifier(testNotifier);
  });
  describe('[NF01] #serverReady', () => {
    beforeEach(() => {
      pubsub.status.emit(pubsub.SERVER_READY);
    });
    it('[B76G] notifies internal listeners', () => {
      assertDeepInclude(emittedMsgs, pubsub.SERVER_READY);
    });
    it('[SRAU] notifies test listeners', () => {
      assertDeepInclude(testMsgs, ['test-server-ready']);
    });
  });
  describe('[NF02] #accountChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    });
    it('[P6ZD] notifies internal listeners', () => {
      assertDeepInclude(emittedMsgs, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    });
    it('[Q96S] notifies test listeners', () => {
      assertDeepInclude(testMsgs, ['test-account-changed', 'USERNAME']);
    });
  });
  describe('[NF03] #accessesChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    });
    it('[P5CG] notifies internal listeners', () => {
      assertDeepInclude(emittedMsgs, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    });
    it('[VSN6] notifies test listeners', () => {
      assertDeepInclude(testMsgs, ['test-accesses-changed', 'USERNAME']);
    });
  });
  describe('[NF05] #streamsChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_STREAMS_CHANGED);
    });
    it('[LDUQ] notifies internal listeners', () => {
      assertDeepInclude(emittedMsgs, pubsub.USERNAME_BASED_STREAMS_CHANGED);
    });
    it('[BUR1] notifies test listeners', () => {
      assertDeepInclude(testMsgs, ['test-streams-changed', 'USERNAME']);
    });
  });
  describe('[NF06] #eventsChanged', () => {
    beforeEach(() => {
      pubsub.notifications.emit('USERNAME', pubsub.USERNAME_BASED_EVENTS_CHANGED);
    });
    it('[N8RI] notifies internal listeners', () => {
      assertDeepInclude(emittedMsgs, pubsub.USERNAME_BASED_EVENTS_CHANGED);
    });
    it('[TRMW] notifies test listeners', () => {
      assertDeepInclude(testMsgs, ['test-events-changed', 'USERNAME']);
    });
  });
});
