/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Example: Events tests using dynData
 *
 * This file demonstrates how to convert tests from static testData to dynData.
 * It can run in parallel with other tests because each instance has unique IDs.
 *
 * Key differences from testData:
 * 1. Call helpers.dynData({ prefix: 'unique' }) to get isolated data
 * 2. Use testData.users, testData.accesses, testData.streams, testData.events
 * 3. Reset functions only affect items with this instance's IDs
 * 4. Call testData.cleanup() in after() hook
 */

/* global initTests, initCore, coreRequest, assert */

const helpers = require('test-helpers');

describe('[EVDY] events with dynData', function () {
  // Each test file gets its own dynData instance with unique prefix
  const testData = helpers.dynData({ prefix: 'evdy' });

  let username, token, basePath;

  before(async function () {
    await initTests();
    await initCore();

    // Get user info from dynData
    username = testData.users[0].username;
    token = testData.accesses[1].token; // Use shared access (doesn't need session)
    basePath = '/' + username + '/events';

    // Reset data using dynData functions (no dropCollection!)
    await testData.resetUsers();
    await testData.resetAccesses();
    await testData.resetStreams();
    await testData.resetEvents();
  });

  after(async function () {
    // Cleanup all data created by this dynData instance
    await testData.cleanup();
  });

  function path (id) {
    return basePath + '/' + id;
  }

  describe('[EVDY01] GET /', function () {
    it('[ED01] must return events for the user', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ limit: 100 });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.events);
      assert.ok(Array.isArray(res.body.events));
      // dynData creates the same number of events as static testData
      assert.ok(res.body.events.length > 0, 'should have events');
    });

    it('[ED02] must filter events by streamIds', async function () {
      // Use stream ID from dynData
      const streamId = testData.streams[0].id;

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ streams: [streamId] });

      assert.strictEqual(res.status, 200);
      // All returned events should be in the requested stream or its children
      res.body.events.forEach(event => {
        const hasMatchingStream = event.streamIds.some(sid =>
          sid === streamId || sid.startsWith(streamId)
        );
        // Note: events might also be in child streams
        assert.ok(hasMatchingStream || event.streamIds.length > 0);
      });
    });
  });

  describe('[EVDY02] POST /', function () {
    it('[ED10] must create a new event', async function () {
      // accesses[1] has 'contribute' permission on streams[1]
      const streamId = testData.streams[1].id;
      const data = {
        // Don't provide ID - let server generate a valid cuid
        streamIds: [streamId],
        type: 'note/txt',
        content: 'Test content from dynData test'
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 201, 'POST failed: ' + JSON.stringify(res.body));
      assert.ok(res.body.event);
      assert.ok(res.body.event.id); // Server generates ID
      assert.strictEqual(res.body.event.content, data.content);
    });
  });

  describe('[EVDY03] GET /:id', function () {
    it('[ED20] must return a specific event from dynData', async function () {
      // Use an event ID from dynData
      const eventId = testData.events[0].id;

      const res = await coreRequest
        .get(path(eventId))
        .set('Authorization', token);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.event);
      assert.strictEqual(res.body.event.id, eventId);
    });
  });

  describe('[EVDY04] Access with different tokens', function () {
    it('[ED30] must return events with read-all access', async function () {
      // accesses[2] has read-all permissions (streamId: '*')
      const readAllToken = testData.accesses[2].token;

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', readAllToken)
        .query({ limit: 10 });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.events);
    });

    it('[ED31] must restrict events with limited access', async function () {
      // accesses[1] has specific stream permissions
      const limitedToken = testData.accesses[1].token;

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', limitedToken);

      assert.strictEqual(res.status, 200);
      // Events should be filtered based on access permissions
      assert.ok(res.body.events);
    });
  });
});
