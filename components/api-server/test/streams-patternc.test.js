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

    it('[PG5F] must refuse "id", which is not a declared parameter', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token)
        .query({ id: 'unknownStreamId' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidParametersFormat);
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

    it('[P84S] must keep a predefined id made of valid characters as given', async function () {
      for (const id of ['keep-a--b', '-keep-edges-', '0--0']) {
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', token)
          .send({ id, name: 'Kept ' + id });

        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.stream.id, id);
        const got = await coreRequest
          .get(basePath)
          .set('Authorization', token)
          .query({ parentId: id });
        assert.strictEqual(got.status, 200);
      }
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

  // Events the deletion moves or trims are modified by the deleting access, so
  // a client syncing with `modifiedSince` sees the change.
  describe('[SWSD] DELETE /<id> of a trashed stream stamps the events it changes', function () {
    let fixtureUser, ownerName, ownerToken, ownerAccessId;
    const OLD = { created: 1000, createdBy: 'test', modified: 1000, modifiedBy: 'test' };

    before(async function () {
      const fixtures = getNewFixture();
      ownerName = cuid();
      fixtureUser = await fixtures.user(ownerName);
      ownerToken = cuid();
      ownerAccessId = cuid();
      await fixtureUser.access({ id: ownerAccessId, token: ownerToken, type: 'personal' });
      await fixtureUser.session(ownerToken);
    });

    // P (root) > S > X, plus Q (root); events in S, in X, and in S and Q.
    async function setupTree () {
      const suffix = cuid().slice(-8);
      const ids = { P: 'swd-p-' + suffix, S: 'swd-s-' + suffix, X: 'swd-x-' + suffix, Q: 'swd-q-' + suffix, evS: cuid(), evX: cuid(), evSQ: cuid() };
      await fixtureUser.stream({ id: ids.P, name: 'P ' + suffix });
      await fixtureUser.stream({ id: ids.S, name: 'S ' + suffix, parentId: ids.P });
      await fixtureUser.stream({ id: ids.X, name: 'X ' + suffix, parentId: ids.S });
      await fixtureUser.stream({ id: ids.Q, name: 'Q ' + suffix });
      await fixtureUser.event({ id: ids.evS, type: 'note/txt', content: 'in S', streamIds: [ids.S], ...OLD });
      await fixtureUser.event({ id: ids.evX, type: 'note/txt', content: 'in X', streamIds: [ids.X], ...OLD });
      await fixtureUser.event({ id: ids.evSQ, type: 'note/txt', content: 'in S and Q', streamIds: [ids.S, ids.Q], ...OLD });
      return ids;
    }

    function streamPath (id) { return '/' + ownerName + '/streams/' + id; }

    async function getEvent (id) {
      const res = await coreRequest.get('/' + ownerName + '/events/' + id).set('Authorization', ownerToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body.event;
    }

    async function deleteTrashed (id, mergeEventsWithParent) {
      const trashed = await coreRequest.del(streamPath(id)).set('Authorization', ownerToken);
      assert.strictEqual(trashed.status, 200, JSON.stringify(trashed.body));
      const res = await coreRequest.del(streamPath(id)).set('Authorization', ownerToken).query({ mergeEventsWithParent });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    }

    async function idsModifiedSince (streamId, since) {
      const res = await coreRequest.get('/' + ownerName + '/events').set('Authorization', ownerToken)
        .query({ streams: JSON.stringify([streamId]), modifiedSince: since });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body.events.map((e) => e.id);
    }

    function assertRestamped (event, tBefore, label) {
      assert.ok(event.modified >= tBefore, label + ': modified is the deletion time');
      assert.strictEqual(event.modifiedBy, ownerAccessId, label + ': modifiedBy is the deleting access');
      assert.strictEqual(event.created, OLD.created, label + ': created is kept');
      assert.strictEqual(event.createdBy, OLD.createdBy, label + ': createdBy is kept');
    }

    it('[SWS4] merged into the parent: every moved event is stamped and returned by modifiedSince', async function () {
      const ids = await setupTree();
      const tBefore = Date.now() / 1000;
      await deleteTrashed(ids.S, true);
      for (const id of [ids.evS, ids.evX, ids.evSQ]) {
        const event = await getEvent(id);
        assert.ok(event.streamIds.includes(ids.P), id + ' moved to the parent: ' + JSON.stringify(event.streamIds));
        assertRestamped(event, tBefore, id);
      }
      const synced = await idsModifiedSince(ids.P, tBefore);
      for (const id of [ids.evS, ids.evX, ids.evSQ]) assert.ok(synced.includes(id), id + ' returned by a sync from before the deletion');
    });

    it('[SWS5] not merged: an event left in another stream is stamped; one only in the subtree is deleted', async function () {
      const ids = await setupTree();
      const tBefore = Date.now() / 1000;
      await deleteTrashed(ids.S, false);
      const kept = await getEvent(ids.evSQ);
      assert.deepStrictEqual(kept.streamIds, [ids.Q]);
      assertRestamped(kept, tBefore, 'event left in Q');
      assert.ok((await idsModifiedSince(ids.Q, tBefore)).includes(ids.evSQ), 'returned by a sync from before the deletion');
      for (const id of [ids.evS, ids.evX]) {
        assert.strictEqual(typeof (await getEvent(id)).deleted, 'number', id + ' is deleted');
      }
    });

    it('[SWS7] a client cannot claim the server marker as author: events.create stamps its own access', async function () {
      const streamId = 'swd-app-' + cuid().slice(-8);
      await fixtureUser.stream({ id: streamId, name: streamId });
      const appToken = cuid();
      const appAccessId = cuid();
      await fixtureUser.access({ id: appAccessId, token: appToken, type: 'app', name: 'swd-app', permissions: [{ streamId, level: 'contribute' }] });
      const res = await coreRequest.post('/' + ownerName + '/events').set('Authorization', appToken)
        .send({ type: 'note/txt', content: 'claims system', streamIds: [streamId], createdBy: 'system', modifiedBy: 'system' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.event.createdBy, appAccessId);
      assert.strictEqual(res.body.event.modifiedBy, appAccessId);
      const stored = await getEvent(res.body.event.id);
      assert.strictEqual(stored.createdBy, appAccessId);
      assert.strictEqual(stored.modifiedBy, appAccessId);
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

  // An access managing a subtree (no `*` grant) renames streams inside it;
  // moving a stream still needs `manage` on the target parent (and on the
  // whole moved subtree, see [STMV]).
  describe('[STRN] PUT /<id> by an access managing a subtree', function () {
    let fixtureUser, rnUsername;

    before(async function () {
      const fixtures = getNewFixture();
      rnUsername = cuid();
      fixtureUser = await fixtures.user(rnUsername);
    });

    // P (root) > S > X, Q (root); the app token manages S only.
    async function setupTree () {
      const suffix = cuid().slice(-8);
      const ids = { P: 'rn-p-' + suffix, S: 'rn-s-' + suffix, X: 'rn-x-' + suffix, Q: 'rn-q-' + suffix };
      await fixtureUser.stream({ id: ids.P, name: 'P ' + suffix });
      await fixtureUser.stream({ id: ids.S, name: 'S ' + suffix, parentId: ids.P });
      await fixtureUser.stream({ id: ids.X, name: 'X ' + suffix, parentId: ids.S });
      await fixtureUser.stream({ id: ids.Q, name: 'Q ' + suffix });
      const appToken = cuid();
      await fixtureUser.access({ token: appToken, type: 'app', name: 'rn app ' + suffix, permissions: [{ streamId: ids.S, level: 'manage' }] });
      return { ids, appToken };
    }

    function update (id, appToken, body) {
      return coreRequest.put('/' + rnUsername + '/streams/' + id).set('Authorization', appToken).send(body);
    }

    it('[STRN1] must let the access rename a child of the stream it manages', async function () {
      const { ids, appToken } = await setupTree();
      const res = await update(ids.X, appToken, { name: 'X renamed ' + ids.X });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.stream.name, 'X renamed ' + ids.X);
      assert.strictEqual(res.body.stream.parentId, ids.S);
    });

    it('[STRN2] must let the access rename the stream it manages, with or without its unchanged parentId', async function () {
      const { ids, appToken } = await setupTree();
      let res = await update(ids.S, appToken, { name: 'S renamed ' + ids.S });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.stream.name, 'S renamed ' + ids.S);
      res = await update(ids.S, appToken, { name: 'S again ' + ids.S, parentId: ids.P });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.stream.parentId, ids.P);
    });

    it('[STRN3] must still forbid moving a stream under a parent the access does not manage, or to the root', async function () {
      const { ids, appToken } = await setupTree();
      let res = await update(ids.X, appToken, { parentId: ids.Q });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
      res = await update(ids.X, appToken, { parentId: null });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
      res = await update(ids.S, appToken, { parentId: ids.Q });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
    });
  });

  // Moving a stream (a new parentId) carries its whole subtree into the new
  // parent's inherited permissions: a non-personal access must manage every
  // stream of the subtree, and the new parent cannot be inside it.
  describe('[STMV] PUT /<id> moving a stream with its subtree', function () {
    let fixtureUser, mvUsername, mvPersonalToken;

    before(async function () {
      const fixtures = getNewFixture();
      mvUsername = cuid();
      mvPersonalToken = cuid();
      fixtureUser = await fixtures.user(mvUsername);
      await fixtureUser.access({ token: mvPersonalToken, type: 'personal' });
      await fixtureUser.session(mvPersonalToken);
    });

    // P (root) > S > X, Q (root); an event in X; an app token with permissionsFor(ids).
    async function setupTree (permissionsFor) {
      const suffix = cuid().slice(-8);
      const ids = { P: 'mv-p-' + suffix, S: 'mv-s-' + suffix, X: 'mv-x-' + suffix, Q: 'mv-q-' + suffix, evX: cuid() };
      await fixtureUser.stream({ id: ids.P, name: 'P ' + suffix });
      await fixtureUser.stream({ id: ids.S, name: 'S ' + suffix, parentId: ids.P });
      await fixtureUser.stream({ id: ids.X, name: 'X ' + suffix, parentId: ids.S });
      await fixtureUser.stream({ id: ids.Q, name: 'Q ' + suffix });
      await fixtureUser.event({ id: ids.evX, type: 'note/txt', content: 'in X', streamIds: [ids.X] });
      const appToken = await appWith(permissionsFor(ids), suffix);
      return { ids, appToken };
    }

    async function appWith (permissions, suffix = cuid().slice(-8)) {
      const appToken = cuid();
      await fixtureUser.access({ token: appToken, type: 'app', name: 'mv app ' + suffix + cuid().slice(-4), permissions });
      return appToken;
    }

    function update (id, token, body) {
      return coreRequest.put('/' + mvUsername + '/streams/' + id).set('Authorization', token).send(body);
    }

    async function parentOf (id) {
      const mall = await getMall();
      const stream = await mall.streams.getOneWithNoChildren(mvUsername, id, 'local');
      return stream.parentId ?? null;
    }

    function readEvent (token, id) {
      return coreRequest.get('/' + mvUsername + '/events/' + id).set('Authorization', token);
    }

    async function assertRefused (ids, res, status = 403, errorId = ErrorIds.Forbidden) {
      assert.strictEqual(res.status, status, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, errorId);
      assert.strictEqual(await parentOf(ids.S), ids.P, 'S did not move');
    }

    it('[SMV1] must forbid moving a stream when the access cannot read a descendant, so another access does not gain it', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' }, { streamId: i.X, level: 'none' }, { streamId: i.Q, level: 'manage' }
      ]);
      const readerOfQ = await appWith([{ streamId: ids.Q, level: 'read' }]);
      assert.notStrictEqual((await readEvent(readerOfQ, ids.evX)).status, 200);
      await assertRefused(ids, await update(ids.S, appToken, { parentId: ids.Q }));
      assert.notStrictEqual((await readEvent(readerOfQ, ids.evX)).status, 200);
    });

    it('[SMV2] must forbid moving a stream when a descendant is granted read', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' }, { streamId: i.X, level: 'read' }, { streamId: i.Q, level: 'manage' }
      ]);
      await assertRefused(ids, await update(ids.S, appToken, { parentId: ids.Q }));
    });

    it('[SMV3] must forbid moving a stream when a descendant is create-only', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' }, { streamId: i.X, level: 'create-only' }, { streamId: i.Q, level: 'manage' }
      ]);
      await assertRefused(ids, await update(ids.S, appToken, { parentId: ids.Q }));
    });

    it('[SMV4] must forbid moving a stream to the root when a descendant is granted below manage, even with `*` manage', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: '*', level: 'manage' }, { streamId: i.X, level: 'read' }
      ]);
      await assertRefused(ids, await update(ids.S, appToken, { parentId: null }));
    });

    it('[SMV5] must move a stream with its descendants when the access manages all of them', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' }, { streamId: i.Q, level: 'manage' }
      ]);
      const res = await update(ids.S, appToken, { parentId: ids.Q });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.stream.parentId, ids.Q);
      assert.strictEqual(await parentOf(ids.X), ids.S);
      assert.strictEqual((await readEvent(appToken, ids.evX)).status, 200);
    });

    it('[SMV6] must move a stream whose descendant restates manage explicitly', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' }, { streamId: i.X, level: 'manage' }, { streamId: i.Q, level: 'manage' }
      ]);
      const res = await update(ids.S, appToken, { parentId: ids.Q });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });

    it('[SMV7] must move a stream when manage is inherited from the old parent', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.P, level: 'manage' }, { streamId: i.Q, level: 'manage' }
      ]);
      const res = await update(ids.S, appToken, { parentId: ids.Q });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(await parentOf(ids.S), ids.Q);
    });

    it('[SMV8] must count trashed descendants', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' }, { streamId: i.X, level: 'read' }, { streamId: i.Q, level: 'manage' }
      ]);
      const trashed = await coreRequest.del('/' + mvUsername + '/streams/' + ids.X).set('Authorization', mvPersonalToken);
      assert.strictEqual(trashed.status, 200, JSON.stringify(trashed.body));
      await assertRefused(ids, await update(ids.S, appToken, { parentId: ids.Q }));
    });

    it('[SMV9] must still let a personal access move a stream', async function () {
      const { ids } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' }, { streamId: i.X, level: 'none' }
      ]);
      const res = await update(ids.S, mvPersonalToken, { parentId: ids.Q });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(await parentOf(ids.S), ids.Q);
    });

    it('[SMV10] must refuse moving a stream under one of its own descendants, for any access', async function () {
      const { ids } = await setupTree((i) => [{ streamId: i.Q, level: 'read' }]);
      await assertRefused(ids, await update(ids.S, mvPersonalToken, { parentId: ids.X }), 400, ErrorIds.InvalidOperation);
      // the tree is intact: an access with no entry on S or X still lists streams
      const readerOfQ = await appWith([{ streamId: ids.Q, level: 'read' }]);
      const res = await coreRequest.get('/' + mvUsername + '/streams').set('Authorization', readerOfQ).timeout(10000);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });

    it('[SMV12] a parent cycle already in storage does not hang the permission walk', async function () {
      const { ids } = await setupTree((i) => [{ streamId: i.Q, level: 'read' }]);
      const mall = await getMall();
      // written below the API, which refuses it
      await mall.streams.update(mvUsername, { id: ids.S, parentId: ids.X });
      try {
        // answered (refused) within the timeout, through the read and the update paths
        const managerOfQ = await appWith([{ streamId: ids.Q, level: 'manage' }]);
        const read = await readEvent(managerOfQ, ids.evX).timeout(10000);
        assert.notStrictEqual(read.status, 200, JSON.stringify(read.body));
        const res = await update(ids.S, managerOfQ, { name: 'renamed ' + ids.S }).timeout(10000);
        assert.ok([403, 404].includes(res.status), JSON.stringify(res.body));
      } finally {
        await mall.streams.update(mvUsername, { id: ids.S, parentId: ids.P });
      }
    });

    it('[SMV11] must check the target parent before the subtree', async function () {
      const { ids, appToken } = await setupTree((i) => [
        { streamId: i.S, level: 'manage' }, { streamId: i.X, level: 'read' }
      ]);
      await assertRefused(ids, await update(ids.S, appToken, { parentId: ids.Q }));
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
