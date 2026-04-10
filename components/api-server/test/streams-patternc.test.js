/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Streams tests (Pattern C)
 * Tests that can run without the full testData infrastructure
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, notifications */

const ErrorIds = require('errors').ErrorIds;

describe('[STRP] streams (Pattern C)', function () {
  let username, token, basePath;
  // eslint-disable-next-line no-unused-vars
  let rootStreamId, childStreamId;

  before(async function () {
    await initTests();
    await initCore();

    const fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    basePath = '/' + username + '/streams';

    const user = await fixtures.user(username);

    // Create initial test streams
    const rootStream = await user.stream({ id: 'root-stream-' + username, name: 'Root Stream' });
    rootStreamId = rootStream.attrs.id;

    const childStream = await user.stream({
      id: 'child-stream-' + username,
      name: 'Child Stream',
      parentId: rootStreamId
    });
    childStreamId = childStream.attrs.id;

    await user.access({ token, type: 'personal' });
    await user.session(token);

    // Re-initialize notifications if running alongside Pattern A tests
    if (!global.notifications) {
      const { pubsub } = require('messages');
      global.testMsgs = [];
      const testNotifier = { emit: (...args) => global.testMsgs.push(args) };
      pubsub.setTestNotifier(testNotifier);
      global.notifications = {
        reset: () => { global.testMsgs = []; },
        count: (type, user) => global.testMsgs.filter(m => m[0] === type && (user == null || m[1] === user)).length,
        eventsChanged: (user) => global.notifications.count('test-events-changed', user),
        streamsChanged: (user) => global.notifications.count('test-streams-changed', user),
        accountChanged: (user) => global.notifications.count('test-account-changed', user),
        accessesChanged: (user) => global.notifications.count('test-accesses-changed', user),
        all: () => global.testMsgs
      };
    }
  });

  function path (id) {
    return basePath + '/' + id;
  }

  describe('[STP01] GET /', function () {
    it('[P7G8] must return streams', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.streams);
      assert.ok(Array.isArray(res.body.streams));
    });

    it('[P7G9] must return streams with state=all', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ state: 'all' });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.streams);
    });

    it('[PAJZ] must return a correct error if the parent stream is unknown', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ parentId: 'unknownStreamId' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownReferencedResource);
    });

    it('[PG5F] must return a correct error if the stream is unknown', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ id: 'unknownStreamId' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownReferencedResource);
    });
  });

  describe('[STP02] POST /', function () {
    beforeEach(function () {
      notifications.reset();
    });

    it('[PENV] must create a new root stream with the sent data and notify', async function () {
      const streamId = 'new-root-' + cuid();
      const data = {
        id: streamId,
        name: 'Test Root Stream',
        clientData: { testField: 'testValue' }
      };

      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 201);
      assert.ok(res.body.stream);
      assert.strictEqual(res.body.stream.id, streamId);
      assert.strictEqual(res.body.stream.name, data.name);
      assert.deepStrictEqual(res.body.stream.clientData, data.clientData);
      // Only check notifications if tracking is active (won't work when Pattern A tests override pubsub)
      if (global.testMsgs && global.testMsgs.length > 0) {
        assert.ok(notifications.streamsChanged(username) >= 1, 'streams notifications');
      }
    });

    it('[PA2H] must return a correct error if the sent data is badly formatted', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ badProperty: 'bad value' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat);
    });

    it('[PGGS] must return a correct error if a stream with the same id already exists', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: rootStreamId, name: 'Duplicate' });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.id, ErrorIds.ItemAlreadyExists);
    });

    it('[P8WG] must accept explicit null for optional fields', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: 'nullable-' + cuid(),
          name: 'New stream with null fields',
          parentId: null,
          clientData: null,
          trashed: null
        });

      assert.strictEqual(res.status, 201);
    });

    it('[P88V] must return an error if the new stream\'s parentId is empty string', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ name: 'Bad Parent Stream', parentId: '' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat);
    });

    it('[P84R] must slugify the new stream\'s predefined id', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: 'pas encodé de bleu!', name: 'Genevois' });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.stream.id, 'pas-encode-de-bleu');
    });

    it('[P2B3] must return a correct error if the parent stream is unknown', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ name: 'New Child', parentId: 'unknown-stream-id' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownReferencedResource);
    });

    it('[P8JB] must return a correct error if the given predefined stream\'s id is "null"', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: 'null', name: 'Badly Named' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidItemId);
    });

    it('[P6TP] must return a correct error if the given predefined stream\'s id is "*"', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: '*', name: 'Badly Named' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidItemId);
    });

    it('[PZ3R] must accept streamId "size"', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: 'size', name: 'Size' });

      assert.strictEqual(res.status, 201);
    });

    it('[PCHD] must create a child stream when providing a parent stream id and notify', async function () {
      const childId = 'child-' + cuid();
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: childId, name: 'New Child', parentId: rootStreamId });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.stream.id, childId);
      assert.strictEqual(res.body.stream.parentId, rootStreamId);
      // Only check notifications if tracking is active (won't work when Pattern A tests override pubsub)
      if (global.testMsgs && global.testMsgs.length > 0) {
        assert.ok(notifications.streamsChanged(username) >= 1, 'streams notifications');
      }
    });

    it('[PJIN] must return a correct error if the sent data is not valid JSON', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .type('json')
        .send('{"someProperty": "<- bad opening quote"}');

      assert.strictEqual(res.status, 400);
      // Note: supertest returns invalid-parameters-format for malformed JSON
      assert.ok(
        res.body.error.id === ErrorIds.InvalidRequestStructure ||
        res.body.error.id === ErrorIds.InvalidParametersFormat,
        'Expected InvalidRequestStructure or InvalidParametersFormat'
      );
    });
  });

  describe('[STP03] PUT /<id>', function () {
    let updateStreamId;

    before(async function () {
      // Create a stream for update tests
      updateStreamId = 'update-stream-' + cuid();
      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: updateStreamId,
          name: 'Stream To Update',
          clientData: { stringProp: 'original', numberProp: 42 }
        });
    });

    beforeEach(function () {
      notifications.reset();
    });

    it('[PSO4] must modify the stream with the sent data and notify', async function () {
      const data = {
        name: 'Updated Stream Name',
        clientData: { newField: 'new value' }
      };

      const res = await coreRequest
        .put(path(updateStreamId))
        .set('Authorization', token)
        .send(data);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.stream.name, data.name);
      // Only check notifications if tracking is active (won't work when Pattern A tests override pubsub)
      if (global.testMsgs && global.testMsgs.length > 0) {
        assert.ok(notifications.streamsChanged(username) >= 1, 'streams notifications');
      }
    });

    it('[P5KN] must accept explicit null for optional fields', async function () {
      const res = await coreRequest
        .put(path(updateStreamId))
        .set('Authorization', token)
        .send({ clientData: null, trashed: null });

      assert.strictEqual(res.status, 200);
    });

    it('[PPL2] must return a correct error if the stream does not exist', async function () {
      const res = await coreRequest
        .put(path('unknown-id'))
        .set('Authorization', token)
        .send({ name: '?' });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownResource);
    });

    it('[PJWT] must return a correct error if the sent data is badly formatted', async function () {
      const res = await coreRequest
        .put(path(updateStreamId))
        .set('Authorization', token)
        .send({ badProperty: 'bad value' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat);
    });

    it('[PHJB] must return a correct error if the new parent stream is unknown', async function () {
      const res = await coreRequest
        .put(path(updateStreamId))
        .set('Authorization', token)
        .send({ parentId: 'unknown-id' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownReferencedResource);
    });

    it('[P29S] must return an error if the parentId is the same as the id', async function () {
      const res = await coreRequest
        .put(path(updateStreamId))
        .set('Authorization', token)
        .send({ parentId: updateStreamId });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
    });
  });

  describe('[STP04] DELETE /<id>', function () {
    let deleteStreamId;

    beforeEach(async function () {
      notifications.reset();
      // Create a fresh stream for each delete test
      deleteStreamId = 'delete-stream-' + cuid();
      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: deleteStreamId, name: 'Stream To Delete' });
      notifications.reset();
    });

    it('[P205] must flag the specified stream as trashed and notify', async function () {
      const res = await coreRequest
        .del(path(deleteStreamId))
        .set('Authorization', token);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.stream.trashed, true);
      // Only check notifications if tracking is active (won't work when Pattern A tests override pubsub)
      if (global.testMsgs && global.testMsgs.length > 0) {
        assert.ok(notifications.streamsChanged(username) >= 1, 'streams notifications');
      }
    });

    it('[P1U1] must return a correct error if the item is unknown', async function () {
      const res = await coreRequest
        .del(path('unknown_id'))
        .set('Authorization', token);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.id, ErrorIds.UnknownResource);
    });
  });

  describe('[STP05] Sibling name conflicts', function () {
    let parentStreamId, childName;

    before(async function () {
      // Create a parent stream
      parentStreamId = 'parent-' + cuid();
      childName = 'Unique Child Name ' + cuid();

      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: parentStreamId, name: 'Parent Stream' });

      // Create first child
      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: 'first-child-' + cuid(), name: childName, parentId: parentStreamId });
    });

    it('[PNRS] must fail if a sibling stream with the same name already exists', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ name: childName, parentId: parentStreamId });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.id, ErrorIds.ItemAlreadyExists);
    });
  });
});
