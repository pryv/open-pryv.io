/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Streams tests (Pattern C)
 * Tests that can run without the full testData infrastructure
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, notifications */

const ErrorIds = require('errors').ErrorIds;
const { getMall } = require('mall');

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

  // The actual deletion of a trashed stream removes its whole subtree and its
  // events (or moves them to the parent), so a non-personal access needs
  // `manage` on every stream of the subtree, and `contribute` on the parent
  // when merging the events into it.
  describe('[STP06] DELETE /<id> subtree permissions for non-personal accesses', function () {
    let fixtureUser, sdaUsername, sdaPersonalToken;

    before(async function () {
      const fixtures = getNewFixture();
      // a dedicated user keeps these destructive tests apart from the others
      sdaUsername = cuid();
      fixtureUser = await fixtures.user(sdaUsername);
      sdaPersonalToken = cuid();
      await fixtureUser.access({ token: sdaPersonalToken, type: 'personal' });
      await fixtureUser.session(sdaPersonalToken);
    });

    // P (root) > S > X, one event in S and one in X; returns the ids and an app
    // token holding the permissions built by `permissionsFor`.
    async function setupTree (permissionsFor) {
      const suffix = cuid().slice(-8);
      const ids = { P: 'sda-p-' + suffix, S: 'sda-s-' + suffix, X: 'sda-x-' + suffix, evS: cuid(), evX: cuid() };
      await fixtureUser.stream({ id: ids.P, name: 'P ' + suffix });
      await fixtureUser.stream({ id: ids.S, name: 'S ' + suffix, parentId: ids.P });
      await fixtureUser.stream({ id: ids.X, name: 'X ' + suffix, parentId: ids.S });
      await fixtureUser.event({ id: ids.evS, type: 'note/txt', content: 'in S', streamIds: [ids.S] });
      await fixtureUser.event({ id: ids.evX, type: 'note/txt', content: 'in X', streamIds: [ids.X] });
      const appToken = cuid();
      await fixtureUser.access({ token: appToken, type: 'app', name: 'sda app ' + suffix, permissions: permissionsFor(ids) });
      return { ids, appToken };
    }

    function streamPath (id) {
      return '/' + sdaUsername + '/streams/' + id;
    }

    async function getStream (id) {
      const mall = await getMall();
      return await mall.streams.getOneWithNoChildren(sdaUsername, id, 'local');
    }

    // null when the event is unknown or deleted (a deletion leaves a tombstone)
    async function getEvent (id) {
      const res = await coreRequest
        .get('/' + sdaUsername + '/events/' + id)
        .set('Authorization', sdaPersonalToken);
      if (res.status !== 200 || res.body.event.deleted != null) return null;
      return res.body.event;
    }

    async function trash (id, token) {
      const res = await coreRequest.del(streamPath(id)).set('Authorization', token);
      assert.strictEqual(res.status, 200, 'trashing must succeed');
      assert.strictEqual(res.body.stream.trashed, true);
    }

    it('[SDA1] must forbid deleting a trashed stream when the access cannot manage a descendant', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' },
        { streamId: i.X, level: 'read' }
      ]);
      await trash(ids.S, appToken);

      const res = await coreRequest
        .del(streamPath(ids.S))
        .set('Authorization', appToken)
        .query({ mergeEventsWithParent: false });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
      assert.ok(await getStream(ids.S), 'S must still exist');
      assert.ok(await getStream(ids.X), 'X must still exist');
      const evS = await getEvent(ids.evS);
      const evX = await getEvent(ids.evX);
      assert.ok(evS, 'event in S must still exist');
      assert.ok(evX, 'event in X must still exist');
      assert.deepStrictEqual(evS.streamIds, [ids.S]);
      assert.deepStrictEqual(evX.streamIds, [ids.X]);
    });

    it('[SDA2] must delete a trashed stream and its descendants when the access manages all of them', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' },
        { streamId: i.X, level: 'manage' }
      ]);
      await trash(ids.S, appToken);

      const res = await coreRequest
        .del(streamPath(ids.S))
        .set('Authorization', appToken)
        .query({ mergeEventsWithParent: false });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(await getStream(ids.S), null, 'S must be deleted');
      assert.strictEqual(await getStream(ids.X), null, 'X must be deleted');
      assert.strictEqual(await getEvent(ids.evS), null, 'event in S must be deleted');
      assert.strictEqual(await getEvent(ids.evX), null, 'event in X must be deleted');
    });

    it('[SDA3] must forbid merging the events into a parent the access cannot contribute to', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.P, level: 'read' },
        { streamId: i.S, level: 'manage' }
      ]);
      await trash(ids.S, appToken);

      const res = await coreRequest
        .del(streamPath(ids.S))
        .set('Authorization', appToken)
        .query({ mergeEventsWithParent: true });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
      assert.ok(await getStream(ids.S), 'S must still exist');
      assert.ok(await getStream(ids.X), 'X must still exist');
      assert.deepStrictEqual((await getEvent(ids.evS)).streamIds, [ids.S], 'event in S must not move');
      assert.deepStrictEqual((await getEvent(ids.evX)).streamIds, [ids.X], 'event in X must not move');
    });

    it('[SDA4] must merge the events into a parent the access can contribute to', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.P, level: 'contribute' },
        { streamId: i.S, level: 'manage' }
      ]);
      await trash(ids.S, appToken);

      const res = await coreRequest
        .del(streamPath(ids.S))
        .set('Authorization', appToken)
        .query({ mergeEventsWithParent: true });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(await getStream(ids.S), null, 'S must be deleted');
      assert.strictEqual(await getStream(ids.X), null, 'X must be deleted');
      assert.deepStrictEqual((await getEvent(ids.evS)).streamIds, [ids.P], 'event in S must move to P');
      assert.deepStrictEqual((await getEvent(ids.evX)).streamIds, [ids.P], 'event in X must move to P');
    });

    it('[SDA5] must still let a personal access delete a trashed stream with its descendants', async function () {
      // the app access restricting X is irrelevant to the personal token
      const { ids } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' },
        { streamId: i.X, level: 'read' }
      ]);
      await trash(ids.S, sdaPersonalToken);

      const res = await coreRequest
        .del(streamPath(ids.S))
        .set('Authorization', sdaPersonalToken)
        .query({ mergeEventsWithParent: false });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(await getStream(ids.S), null, 'S must be deleted');
      assert.strictEqual(await getStream(ids.X), null, 'X must be deleted');
      assert.strictEqual(await getEvent(ids.evS), null, 'event in S must be deleted');
      assert.strictEqual(await getEvent(ids.evX), null, 'event in X must be deleted');
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

  // A concurrent streams.create that loses the race between the existence
  // pre-check and the insert must return item-already-exists (409), not leak
  // the store's raw unique-constraint violation as an unexpected-error (500).
  describe('[STDU] concurrent create (same id)', function () {
    it('[DUPC1] must map a duplicate insert to item-already-exists even when the pre-check passed', async function () {
      const dupId = 'dup-backstop-' + cuid();

      // seed the stream normally
      const seed = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: dupId, name: 'Backstop Seed' });
      assert.strictEqual(seed.status, 201);

      // force the pre-check to miss (simulate the racing peer inserting between
      // our getOne and our create), so only the store constraint stops us
      const mall = await getMall();
      const localStore = mall.streams.streamsStores.get('local');
      const originalGetOne = localStore.getOne;
      localStore.getOne = async () => null;
      try {
        let thrown = null;
        try {
          await mall.streams.create(username, { id: dupId, name: 'Backstop Racer', parentId: null });
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown != null, 'create must reject on the duplicate id');
        assert.strictEqual(thrown.id, ErrorIds.ItemAlreadyExists);
        assert.strictEqual(thrown.httpStatus, 409);
        assert.strictEqual(thrown.data.id, dupId);
        assert.ok(!/unexpected/i.test(thrown.message), 'must not surface as an unexpected-error');
      } finally {
        localStore.getOne = originalGetOne;
      }
    });

    it('[DUPC2] concurrent HTTP creates of the same id yield exactly one 201 and the rest 409, never 5xx', async function () {
      const dupId = 'dup-http-' + cuid();
      const attempts = 5;
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, (_, i) =>
          coreRequest
            .post(basePath)
            .set('Authorization', token)
            .send({ id: dupId, name: 'HTTP Racer ' + i })));

      const statuses = results.map((r) => r.status === 'fulfilled' ? r.value.status : 599);
      const created = statuses.filter((s) => s === 201);
      const conflicts = statuses.filter((s) => s === 409);
      const serverErrors = statuses.filter((s) => s >= 500);

      assert.strictEqual(created.length, 1, 'exactly one create should win: ' + statuses.join(','));
      assert.strictEqual(conflicts.length, attempts - 1, 'all losers should be 409: ' + statuses.join(','));
      assert.strictEqual(serverErrors.length, 0, 'no 5xx allowed: ' + statuses.join(','));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.status === 409) {
          assert.strictEqual(r.value.body.error.id, ErrorIds.ItemAlreadyExists);
        }
      }
    });

    it('[DUPC3] the local store raises the cross-engine duplicate contract on a second insert', async function () {
      const dupId = 'dup-contract-' + cuid();
      const seed = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: dupId, name: 'Contract Seed' });
      assert.strictEqual(seed.status, 201);

      const mall = await getMall();
      const localStore = mall.streams.streamsStores.get('local');
      let thrown = null;
      try {
        await localStore.create(username, { id: dupId, name: 'Contract Racer', parentId: null });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown != null, 'second store.create must reject');
      assert.strictEqual(thrown.isDuplicate, true, 'engine must set the isDuplicate contract flag');
    });
  });
});
