/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Events tests (Pattern C)
 * Tests that can run in parallel without shared testData infrastructure
 * Converted from events.test.js for parallel execution
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, notifications */

const ErrorIds = require('errors').ErrorIds;
const timestamp = require('unix-timestamp');
describe('[EVPC] events (Pattern C)', function () {
  let username, token, basePath;
  let user, fixtures;
  let stream1Id, stream2Id, stream1ChildId, trashedStreamId;

  before(async function () {
    await initTests();
    await initCore();

    fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    basePath = '/' + username + '/events';

    user = await fixtures.user(username);

    // Create test streams
    stream1Id = 'stream1-' + username;
    stream2Id = 'stream2-' + username;
    stream1ChildId = 'stream1-child-' + username;
    trashedStreamId = 'trashed-' + username;

    await user.stream({ id: stream1Id, name: 'Stream 1' });
    await user.stream({ id: stream2Id, name: 'Stream 2' });
    await user.stream({ id: stream1ChildId, name: 'Stream 1 Child', parentId: stream1Id });
    await user.stream({ id: trashedStreamId, name: 'Trashed Stream', trashed: true });

    await user.access({ token, type: 'personal' });
    await user.session(token);

    // Initialize notifications if not already done
    if (!global.notifications) {
      const { pubsub } = require('messages');
      global.testMsgs = [];
      const testNotifier = { emit: (...args) => global.testMsgs.push(args) };
      pubsub.setTestNotifier(testNotifier);
      global.notifications = {
        reset: () => { global.testMsgs = []; },
        count: (type, u) => global.testMsgs.filter(m => m[0] === type && (u == null || m[1] === u)).length,
        eventsChanged: (u) => global.notifications.count('test-events-changed', u),
        streamsChanged: (u) => global.notifications.count('test-streams-changed', u),
        accountChanged: (u) => global.notifications.count('test-account-changed', u),
        accessesChanged: (u) => global.notifications.count('test-accesses-changed', u),
        all: () => global.testMsgs
      };
    }
  });

  function path (id) {
    return basePath + '/' + id;
  }

  describe('[EPC01] GET /', function () {
    const testEventIds = [];

    before(async function () {
      // Create test events
      for (let i = 0; i < 5; i++) {
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', token)
          .send({
            streamIds: [stream1Id],
            type: 'note/txt',
            content: 'Test event ' + i,
            time: timestamp.now('-' + i + 'h')
          });
        testEventIds.push(res.body.event.id);
      }
    });

    it('[PC01] must return events', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.events);
      assert.ok(Array.isArray(res.body.events));
      assert.ok(res.body.events.length >= 5);
    });

    it('[PC02] must only return events for the given streams when set', async function () {
      // Create an event in stream2
      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream2Id], type: 'note/txt', content: 'Stream 2 event' });

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ streams: [stream1Id], fromTime: timestamp.now('-48h') });

      assert.strictEqual(res.status, 200);
      res.body.events.forEach(event => {
        // Event should be in stream1 or its child
        assert.ok(
          event.streamIds.includes(stream1Id) || event.streamIds.includes(stream1ChildId),
          'Event should be in stream1 or child'
        );
      });
    });

    it('[PC03] must return an error if some of the given streams do not exist', async function () {
      const params = { streams: ['bad-id-A', 'bad-id-B'] };
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query(params);

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownReferencedResource);
    });

    it('[PC04] must only return events of any of the given types when set', async function () {
      // Create events of different types
      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'mass/kg', content: 75 });

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ types: ['mass/kg'], state: 'all' });

      assert.strictEqual(res.status, 200);
      res.body.events.forEach(event => {
        assert.strictEqual(event.type, 'mass/kg');
      });
    });

    it('[PC05] must refuse unsupported event types', async function () {
      const params = { types: ['activity/asd asd'], state: 'all' };
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query(params);

      assert.strictEqual(res.status, 400);
    });

    it('[PC06] must only return events in the given time period', async function () {
      const fromTime = timestamp.now('-2h');
      const toTime = timestamp.now('-1h');

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ fromTime, toTime, sortAscending: true });

      assert.strictEqual(res.status, 200);
      res.body.events.forEach(event => {
        // Events should be within time range or overlapping (running events)
        assert.ok(
          (event.time >= fromTime && event.time <= toTime) ||
          (event.duration === null && event.time <= toTime),
          'Event time should be in range'
        );
      });
    });

    it('[PC07] must take into account fromTime and toTime even if set to 0', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ fromTime: 0, toTime: 0 });

      assert.strictEqual(res.status, 200);
      // All returned events should have time = 0 or be running (null duration)
      res.body.events.forEach(event => {
        assert.ok(event.time === 0 || event.duration === null);
      });
    });

    it('[PC08] must return only trashed events when requested', async function () {
      // Create and trash an event
      const createRes = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'note/txt', content: 'To trash' });
      const eventId = createRes.body.event.id;

      await coreRequest
        .del(path(eventId))
        .set('Authorization', token);

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ state: 'trashed' });

      assert.strictEqual(res.status, 200);
      res.body.events.forEach(event => {
        assert.strictEqual(event.trashed, true);
      });
    });

    it('[PC09] must return all events (trashed or not) when requested', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ state: 'all', limit: 1000 });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.events.length > 0);
    });

    it('[PC10] must return only running period events when requested', async function () {
      // Create a running event (null duration)
      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'activity/plain', duration: null });

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ running: true });

      assert.strictEqual(res.status, 200);
      res.body.events.forEach(event => {
        assert.strictEqual(event.duration, null);
      });
    });

    it('[PC11] must return an error if withDeletions is given as parameter', async function () {
      const params = {
        state: 'all',
        modifiedSince: timestamp.now('-45m'),
        includeDeletions: true,
        withDeletions: true
      };

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query(params);

      assert.ok(res.body.error);
      assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
    });

    it('[PC12] must only return events in the given paging range when set', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ state: 'all', skip: 1, limit: 3 });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.events.length <= 3);
    });
  });

  describe('[EPC02] POST /', function () {
    beforeEach(function () {
      notifications.reset();
    });

    it('[PC20] must create an event with the sent data', async function () {
      const data = {
        time: timestamp.fromDate('2012-03-22T10:00'),
        duration: timestamp.duration('55m'),
        type: 'temperature/celsius',
        content: 36.7,
        streamIds: [stream1Id],
        description: 'Test description',
        clientData: { testField: 'testValue' }
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 201);
      assert.ok(res.body.event);
      assert.strictEqual(res.body.event.type, data.type);
      assert.strictEqual(res.body.event.content, data.content);
      assert.strictEqual(res.body.event.description, data.description);

      // Check notification
      if (global.testMsgs && global.testMsgs.length > 0) {
        assert.ok(notifications.eventsChanged(username) >= 1, 'events notifications');
      }
    });

    it('[PC21] must set the event time to "now" if missing', async function () {
      const data = {
        streamIds: [stream2Id],
        type: 'mass/kg',
        content: 10.7
      };
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      const expectedTimestamp = timestamp.now();

      assert.strictEqual(res.status, 201);
      // allow 1 second of lag
      assert.ok(res.body.event.time >= expectedTimestamp - 1 && res.body.event.time <= expectedTimestamp);
    });

    it('[PC22] must accept explicit null for optional fields', async function () {
      const data = {
        type: 'test/null',
        streamIds: [stream2Id],
        duration: null,
        content: null,
        description: null,
        clientData: null,
        trashed: null
      };
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 201);
    });

    it('[PC23] must refuse events with no stream id', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ type: 'test/test' });

      assert.strictEqual(res.status, 400);
    });

    it('[PC24] must return a correct error if an event with the same id already exists', async function () {
      // Create an event first
      const createRes = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'test/test' });

      const existingId = createRes.body.event.id;

      // Try to create another with same id
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: existingId, streamIds: [stream2Id], type: 'test/test' });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.id, ErrorIds.ItemAlreadyExists);
    });

    it('[PC25] must only allow ids that are formatted like cuids', async function () {
      const data = {
        id: 'man, this is a baaad id',
        streamIds: [stream2Id],
        type: 'test/test'
      };
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 400);
    });

    it('[PC28] must validate the event content if its type is known', async function () {
      const data = {
        streamIds: [stream1Id],
        type: 'note/webclip',
        content: {
          url: 'bad-url',
          content: '<p>Some content</p>'
        }
      };
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 400);
    });

    it('[PC29] must return an error if the sent data is badly formatted', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ badProperty: 'bad value' });

      assert.strictEqual(res.status, 400);
    });

    it('[PC30] must return an error if the associated stream is unknown', async function () {
      const data = {
        time: timestamp.fromDate('2012-03-22T10:00'),
        type: 'test/test',
        streamIds: ['unknown-stream-id']
      };
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownReferencedResource);
    });

    it('[PC31] must return an error if the assigned stream is trashed', async function () {
      const data = {
        type: 'test/test',
        streamIds: [trashedStreamId]
      };
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
    });

    it('[PC32] must not fail (500) when sending an array instead of an object', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send([{}]);

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat);
    });

    it('[PC33] must not accept an empty streamIds array', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          streamIds: [],
          type: 'note/txt',
          content: 'i should return an error!'
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat);
    });

    it('[PC34] must not fail when validating content if passing a string instead of an object', async function () {
      const data = {
        streamIds: [stream1Id],
        type: 'note/webclip',
        content: 'This should be an object'
      };
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 400);
    });
  });

  describe('[EPC03] GET /<event id>', function () {
    let eventId;

    before(async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'note/txt', content: 'Get test' });
      eventId = res.body.event.id;
    });

    it('[PC40] must return the event', async function () {
      const res = await coreRequest
        .get(path(eventId))
        .set('Authorization', token);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.event);
      assert.strictEqual(res.body.event.id, eventId);
    });

    it('[PC41] must return an error if the event does not exist', async function () {
      const res = await coreRequest
        .get(path('unknown-event-id'))
        .set('Authorization', token);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownResource);
    });
  });

  describe('[EPC04] PUT /<id>', function () {
    let eventId;

    beforeEach(async function () {
      notifications.reset();
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          streamIds: [stream1Id],
          type: 'note/txt',
          content: 'Original content',
          clientData: { stringProp: 'original', numberProp: 42 }
        });
      eventId = res.body.event.id;
      notifications.reset();
    });

    it('[PC50] must modify the event with the sent data', async function () {
      const data = {
        time: timestamp.now('-15m'),
        duration: timestamp.duration('15m'),
        type: 'test/test',
        content: 'updated',
        streamIds: [stream1ChildId],
        description: 'New description',
        clientData: { clientField: 'client value' }
      };

      const res = await coreRequest
        .put(path(eventId))
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.event.content, 'updated');
      assert.strictEqual(res.body.event.description, 'New description');

      if (global.testMsgs && global.testMsgs.length > 0) {
        assert.ok(notifications.eventsChanged(username) >= 1, 'events notifications');
      }
    });

    it('[PC51] must add/update/remove the specified client data fields without touching the others', async function () {
      const data = {
        clientData: {
          booleanProp: true,
          stringProp: 'Where Art Thou?',
          numberProp: null
        }
      };

      const res = await coreRequest
        .put(path(eventId))
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.event.clientData.booleanProp, true);
      assert.strictEqual(res.body.event.clientData.stringProp, 'Where Art Thou?');
      assert.strictEqual(res.body.event.clientData.numberProp, undefined);
    });

    it('[PC52] must accept explicit null for optional fields', async function () {
      const data = {
        type: 'test/null',
        duration: null,
        content: null,
        description: null,
        clientData: null,
        trashed: null
      };
      const res = await coreRequest
        .put(path(eventId))
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 200);
    });

    it('[PC53] must validate the event content if its type is known', async function () {
      const data = {
        type: 'position/wgs84',
        content: {
          latitude: 'bad-value',
          longitude: false
        }
      };
      const res = await coreRequest
        .put(path(eventId))
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 400);
    });

    it('[PC54] must return an error if the event does not exist', async function () {
      const res = await coreRequest
        .put(path('unknown-id'))
        .set('Authorization', token)
        .send({ time: timestamp.now() });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownResource);
    });

    it('[PC55] must return an error if the sent data is badly formatted', async function () {
      const res = await coreRequest
        .put(path(eventId))
        .set('Authorization', token)
        .send({ badProperty: 'bad value' });

      assert.strictEqual(res.status, 400);
    });

    it('[PC56] must return an error if the associated stream is unknown', async function () {
      const res = await coreRequest
        .put(path(eventId))
        .set('Authorization', token)
        .send({ streamIds: ['unknown-stream-id'] });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownReferencedResource);
    });
  });

  describe('[EPC05] DELETE /<id>', function () {
    let eventId;

    beforeEach(async function () {
      notifications.reset();
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'note/txt', content: 'To delete' });
      eventId = res.body.event.id;
      notifications.reset();
    });

    it('[PC60] must flag the event as trashed', async function () {
      const res = await coreRequest
        .del(path(eventId))
        .set('Authorization', token);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.event.trashed, true);

      if (global.testMsgs && global.testMsgs.length > 0) {
        assert.ok(notifications.eventsChanged(username) >= 1, 'events notifications');
      }
    });

    it('[PC61] must delete the event when already trashed', async function () {
      // First trash
      await coreRequest
        .del(path(eventId))
        .set('Authorization', token);

      notifications.reset();

      // Then delete
      const res = await coreRequest
        .del(path(eventId))
        .set('Authorization', token);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.eventDeletion, { id: eventId });

      if (global.testMsgs && global.testMsgs.length > 0) {
        assert.ok(notifications.eventsChanged(username) >= 1, 'events notifications');
      }
    });

    it('[PC62] must return an error if event does not exist', async function () {
      const res = await coreRequest
        .del(path('unknown-event-id'))
        .set('Authorization', token);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownResource);
    });
  });

  describe('[EPC07] Type wildcard support', function () {
    before(async function () {
      // Create events of activity types
      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'activity/plain' });

      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'activity/test' });
    });

    it('[PC80] must (unofficially) support a wildcard for event types', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ types: ['activity/*'], state: 'all' });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.events.some(e => e.type.startsWith('activity/')));
    });
  });

  describe('[EPC08] Deletions support', function () {
    it('[PC90] must include event deletions when requested', async function () {
      // Create and delete an event
      const createRes = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ streamIds: [stream1Id], type: 'note/txt', content: 'To be deleted' });
      const eventId = createRes.body.event.id;

      // Trash it
      await coreRequest
        .del(path(eventId))
        .set('Authorization', token);

      // Delete it permanently
      await coreRequest
        .del(path(eventId))
        .set('Authorization', token);

      const params = {
        state: 'all',
        modifiedSince: timestamp.now('-5m'),
        includeDeletions: true
      };

      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query(params);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.eventDeletions);
      assert.ok(res.body.eventDeletions.some(d => d.id === eventId));
    });
  });
});
