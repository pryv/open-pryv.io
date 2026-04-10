/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Events tests - Parallel-ready version using createTestContext
 * Demonstrates how to write parallel-safe tests with isolated data
 *
 * Run with: just test api-server --grep "EVTP"
 */

/* global initTests, initCore, coreRequest, assert */

const { createTestContext } = require('test-helpers').parallelTestHelper;

describe('[EVTP] Events (parallel)', function () {
  const ctx = createTestContext();

  before(async function () {
    // Initialize Pattern C infrastructure
    await initTests();
    await initCore();

    // Initialize isolated test context
    await ctx.init();
    ctx.request = coreRequest; // Use Pattern C request
  });

  after(async function () {
    await ctx.cleanup();
  });

  describe('[ETP01] GET /events', function () {
    let streamId;

    before(async function () {
      // Create test stream and events
      streamId = `stream-${ctx.testRunId}`;
      const stream = await ctx.createStream({ id: streamId, name: 'Test Stream' });

      await stream.event({ type: 'note/txt', content: 'Event 1' });
      await stream.event({ type: 'note/txt', content: 'Event 2' });
      await stream.event({ type: 'mass/kg', content: 75 });
    });

    it('[PTEV] must return events for the user', async function () {
      const res = await ctx.request
        .get(ctx.basePath('/events'))
        .set('Authorization', ctx.token);

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.events));
      assert.ok(res.body.events.length >= 3);
    });

    it('[PT2V] must filter events by stream', async function () {
      const res = await ctx.request
        .get(ctx.basePath('/events'))
        .set('Authorization', ctx.token)
        .query({ streams: [streamId] });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.events.length >= 3);
      res.body.events.forEach(event => {
        assert.ok(event.streamIds.includes(streamId));
      });
    });

    it('[PT3V] must filter events by type', async function () {
      const res = await ctx.request
        .get(ctx.basePath('/events'))
        .set('Authorization', ctx.token)
        .query({ types: ['note/txt'] });

      assert.strictEqual(res.status, 200);
      res.body.events.forEach(event => {
        assert.strictEqual(event.type, 'note/txt');
      });
    });
  });

  describe('[ETP02] POST /events', function () {
    let streamId;

    before(async function () {
      streamId = `create-stream-${ctx.testRunId}`;
      await ctx.createStream({ id: streamId });
    });

    it('[PTC1] must create an event', async function () {
      const eventData = {
        streamIds: [streamId],
        type: 'note/txt',
        content: 'Created via test'
      };

      const res = await ctx.request
        .post(ctx.basePath('/events'))
        .set('Authorization', ctx.token)
        .send(eventData);

      assert.strictEqual(res.status, 201);
      assert.ok(res.body.event);
      assert.strictEqual(res.body.event.streamIds[0], streamId);
      assert.strictEqual(res.body.event.type, 'note/txt');
      assert.strictEqual(res.body.event.content, 'Created via test');
    });

    it('[PTC2] must reject event with invalid stream', async function () {
      const eventData = {
        streamIds: ['non-existent-stream'],
        type: 'note/txt',
        content: 'Should fail'
      };

      const res = await ctx.request
        .post(ctx.basePath('/events'))
        .set('Authorization', ctx.token)
        .send(eventData);

      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error);
    });
  });

  describe('[ETP03] PUT /events/:id', function () {
    let streamId, eventId;

    before(async function () {
      streamId = `update-stream-${ctx.testRunId}`;
      const stream = await ctx.createStream({ id: streamId });
      const event = await stream.event({ type: 'note/txt', content: 'Original' });
      eventId = event.attrs.id;
    });

    it('[PTU1] must update an event', async function () {
      const res = await ctx.request
        .put(ctx.basePath(`/events/${eventId}`))
        .set('Authorization', ctx.token)
        .send({ content: 'Updated content' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.event.content, 'Updated content');
    });
  });

  describe('[ETP04] DELETE /events/:id', function () {
    let streamId, eventId;

    beforeEach(async function () {
      streamId = `delete-stream-${ctx.testRunId}`;
      const stream = await ctx.createStream({ id: streamId });
      const event = await stream.event({ type: 'note/txt', content: 'To delete' });
      eventId = event.attrs.id;
    });

    it('[PTD1] must trash an event', async function () {
      const res = await ctx.request
        .delete(ctx.basePath(`/events/${eventId}`))
        .set('Authorization', ctx.token);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.event.trashed, true);
    });
  });
});
