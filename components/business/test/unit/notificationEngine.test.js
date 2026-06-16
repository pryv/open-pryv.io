/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { NotificationEngine } = require('../../src/notifications/NotificationEngine.ts');
const { pubsub } = require('messages');

/** Build a subscriber whose deliveries are collected for assertions. */
function fakeSubscriber (id, scopes) {
  const deliveries = [];
  return { id, scopes, deliver: (keys) => deliveries.push(keys), deliveries };
}

const eventInDiary = { kind: 'events', changeType: 'change', event: { id: 'e1', streamIds: ['diary'], type: 'note/txt', content: { status: 'unread' } } };

describe('[SNEN] NotificationEngine', function () {
  describe('[SNED] dispatch via onSignal', function () {
    it('[SNED1] delivers only the matched scope keys', function () {
      const engine = new NotificationEngine();
      const sub = fakeSubscriber('s1', [
        { key: 'diary', kind: 'events', query: { streams: [{ any: ['diary'] }] } },
        { key: 'health', kind: 'events', query: { streams: [{ any: ['health'] }] } },
        { key: 'unread', kind: 'events', query: { content: [{ field: 'content', path: ['status'], op: 'eq', value: 'unread' }] } }
      ]);
      engine.register('alice', sub);
      engine.onSignal('alice', eventInDiary);
      assert.deepEqual(sub.deliveries, [['diary', 'unread']]);
    });

    it('[SNED2] does not deliver when no scope matches', function () {
      const engine = new NotificationEngine();
      const sub = fakeSubscriber('s1', [{ key: 'health', kind: 'events', query: { streams: [{ any: ['health'] }] } }]);
      engine.register('alice', sub);
      engine.onSignal('alice', eventInDiary);
      assert.equal(sub.deliveries.length, 0);
    });

    it('[SNED3] only matches scopes of the signal kind', function () {
      const engine = new NotificationEngine();
      const sub = fakeSubscriber('s1', [{ key: 'streamScope', kind: 'streams', query: { streams: [{ any: ['diary'] }] } }]);
      engine.register('alice', sub);
      engine.onSignal('alice', eventInDiary); // kind 'events' -> stream scope ignored
      assert.equal(sub.deliveries.length, 0);
    });

    it('[SNED4] fans out to multiple subscribers independently', function () {
      const engine = new NotificationEngine();
      const a = fakeSubscriber('a', [{ key: 'd', kind: 'events', query: { streams: [{ any: ['diary'] }] } }]);
      const b = fakeSubscriber('b', [{ key: 'h', kind: 'events', query: { streams: [{ any: ['health'] }] } }]);
      engine.register('alice', a);
      engine.register('alice', b);
      engine.onSignal('alice', eventInDiary);
      assert.deepEqual(a.deliveries, [['d']]);
      assert.equal(b.deliveries.length, 0);
    });

    it('[SNED5] ignores signals for other usernames', function () {
      const engine = new NotificationEngine();
      const sub = fakeSubscriber('s1', [{ key: 'd', kind: 'events', query: { streams: [{ any: ['diary'] }] } }]);
      engine.register('alice', sub);
      engine.onSignal('bob', eventInDiary);
      assert.equal(sub.deliveries.length, 0);
    });
  });

  describe('[SNER] registry lifecycle', function () {
    it('[SNER1] tracks subscriber count and clears on last unregister', function () {
      const engine = new NotificationEngine();
      const a = fakeSubscriber('a', []);
      const b = fakeSubscriber('b', []);
      engine.register('alice', a);
      engine.register('alice', b);
      assert.equal(engine.subscriberCount('alice'), 2);
      engine.unregister('alice', a);
      assert.equal(engine.subscriberCount('alice'), 1);
      engine.unregister('alice', b);
      assert.equal(engine.subscriberCount('alice'), 0);
    });
  });

  describe('[SNEP] pubsub wiring', function () {
    it('[SNEP1] delivers a scopedNotifications emit to a registered subscriber', function () {
      const engine = new NotificationEngine();
      const sub = fakeSubscriber('s1', [{ key: 'diary', kind: 'events', query: { streams: [{ any: ['diary'] }] } }]);
      engine.register('carol', sub);
      pubsub.scopedNotifications.emit('carol', eventInDiary);
      // forwardToInternal delivers synchronously in-process; a transport echo (if
      // any) would only repeat the same matched keys, deduped downstream.
      assert.ok(sub.deliveries.length >= 1, 'expected at least one delivery');
      assert.deepEqual(sub.deliveries[0], ['diary']);
      engine.unregister('carol', sub);
    });
  });
});
