/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const Webhook = require('../../src/webhooks/Webhook.ts').default;
const { pubsub } = require('messages');

// A scope's `prepared` query is normally produced by the api-server's
// prepareScopeQuery (access-bound + expanded); here we craft it directly to
// unit-test the Webhook <-> NotificationEngine wiring in isolation.
function makeScopedWebhook (scopes) {
  return new Webhook({
    accessId: 'a1',
    url: 'https://example.test/hook',
    user: { id: 'u1', username: 'wsuser' },
    webhooksRepository: null,
    scopes
  });
}

describe('[SNWH] scoped webhook', function () {
  it('[SNWH1] fires only for in-scope changes, delivering the matched key', function () {
    const webhook = makeScopedWebhook({
      diary: { kind: 'events', query: { streams: ['diary'] }, prepared: { streams: [{ any: ['diary'] }] } }
    });
    const sent = [];
    webhook.send = (message) => { sent.push(message); }; // stub the HTTP/throttle path
    webhook.startListenting('wsuser');

    pubsub.scopedNotifications.emit('wsuser', { kind: 'events', event: { streamIds: ['diary'], type: 'note/txt' } });
    assert.deepEqual(sent, ['diary']);

    // out of scope -> no delivery
    pubsub.scopedNotifications.emit('wsuser', { kind: 'events', event: { streamIds: ['health'], type: 'note/txt' } });
    assert.deepEqual(sent, ['diary']);

    webhook.pubsubTurnOffListener();
  });

  it('[SNWH2] an unfiltered webhook keeps the legacy coarse behaviour', function () {
    const webhook = makeScopedWebhook(null); // no scopes
    const sent = [];
    webhook.send = (message) => { sent.push(message); };
    webhook.startListenting('wsuser2');

    // legacy coarse signal -> fires with the coarse marker
    pubsub.notifications.emit('wsuser2', pubsub.USERNAME_BASED_EVENTS_CHANGED);
    assert.ok(sent.length >= 1, 'unfiltered webhook should fire on the coarse signal');

    webhook.pubsubTurnOffListener();
  });
});
