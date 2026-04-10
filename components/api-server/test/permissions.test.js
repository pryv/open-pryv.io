/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Access permissions tests (Pattern C)
 * Migrated from permissions-seq.test.js sections AP01, AP02, and YE49
 * These are pure permission assertions (HTTP call + status check) that are parallel-safe.
 * The AP04 section (custom auth step) remains in permissions-seq.test.js due to
 * file I/O + server.restart requirements.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const timestamp = require('unix-timestamp');
const { getConfig } = require('@pryv/boiler');

describe('[PPERM] Access permissions (Pattern C)', function () {
  let username, eventsPath, streamsPath;

  // Tokens
  let personalToken;
  let sharedToken, sharedAccessId;
  let readAllToken;
  let noPermToken;
  let manageToken2;

  // Stream IDs
  let roStreamId, roChildId;
  let cbStreamId, cbChildId;
  let mgStreamId, mgChildId;
  let mgTrStreamId;
  let mg2StreamId;

  // Event IDs
  let roEventId, roChildEventId;
  let mgEventId, mg2EventId;
  let attEventId, attId;

  let isAuditActive = false;

  before(async function () {
    await initTests();
    await initCore();

    const config = await getConfig();
    isAuditActive = config.get('audit:active');

    const fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    sharedToken = cuid();
    readAllToken = cuid();
    noPermToken = cuid();
    manageToken2 = cuid();

    eventsPath = '/' + username + '/events';
    streamsPath = '/' + username + '/streams';

    const user = await fixtures.user(username);

    // Stream IDs (unique per test run)
    roStreamId = 'ro-' + username;
    roChildId = 'ro-ch-' + username;
    cbStreamId = 'cb-' + username;
    cbChildId = 'cb-ch-' + username;
    mgStreamId = 'mg-' + username;
    mgChildId = 'mg-ch-' + username;
    mgTrStreamId = 'mgtr-' + username;
    mg2StreamId = 'mg2-' + username;

    // Create stream tree
    await user.stream({ id: roStreamId, name: 'Read-Only Stream' });
    await user.stream({ id: roChildId, name: 'RO Child', parentId: roStreamId });
    await user.stream({ id: cbStreamId, name: 'Contribute Stream' });
    await user.stream({ id: cbChildId, name: 'CB Child', parentId: cbStreamId });
    await user.stream({ id: mgStreamId, name: 'Manage Stream' });
    await user.stream({ id: mgChildId, name: 'Manage Child', parentId: mgStreamId });
    await user.stream({ id: mgTrStreamId, name: 'Trashed Managed', trashed: true });
    await user.stream({ id: mg2StreamId, name: 'Manage Stream 2' });

    // Create accesses
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);

    const sharedAccess = await user.access({
      token: sharedToken,
      type: 'shared',
      name: 'mixed permissions',
      permissions: [
        { streamId: roStreamId, level: 'read' },
        { streamId: cbStreamId, level: 'contribute' },
        { streamId: mgStreamId, level: 'manage' },
        { streamId: mgTrStreamId, level: 'manage' }
      ]
    });
    sharedAccessId = sharedAccess.attrs.id;
    await user.session(sharedToken);

    await user.access({
      token: readAllToken,
      type: 'shared',
      name: 'read all',
      permissions: [{ streamId: '*', level: 'read' }]
    });
    await user.session(readAllToken);

    await user.access({
      token: noPermToken,
      type: 'shared',
      name: 'no permissions',
      permissions: []
    });
    await user.session(noPermToken);

    await user.access({
      token: manageToken2,
      type: 'shared',
      name: 'manage stream 2',
      permissions: [{ streamId: mg2StreamId, level: 'manage' }]
    });
    await user.session(manageToken2);

    // Create events using personal token
    let res;

    res = await coreRequest.post(eventsPath).set('Authorization', personalToken)
      .send({ streamIds: [roStreamId], type: 'note/txt', content: 'RO event' });
    roEventId = res.body.event.id;

    res = await coreRequest.post(eventsPath).set('Authorization', personalToken)
      .send({ streamIds: [roChildId], type: 'note/txt', content: 'RO child event' });
    roChildEventId = res.body.event.id;

    res = await coreRequest.post(eventsPath).set('Authorization', personalToken)
      .send({ streamIds: [mgStreamId], type: 'note/txt', content: 'MG event' });
    mgEventId = res.body.event.id;

    res = await coreRequest.post(eventsPath).set('Authorization', personalToken)
      .send({ streamIds: [mg2StreamId], type: 'note/txt', content: 'MG2 event' });
    mg2EventId = res.body.event.id;

    // Create event with attachment (for [KTM1] test)
    res = await coreRequest.post(eventsPath).set('Authorization', personalToken)
      .field('event', JSON.stringify({ streamIds: [roStreamId], type: 'note/txt', content: 'With attachment' }))
      .attach('file', Buffer.from('test file content'), 'test.txt');
    attEventId = res.body.event.id;
    attId = res.body.event.attachments[0].id;
  });

  describe('[AP01] Events', function () {
    it('[1AK1] `get` must only return events in accessible streams', async function () {
      const res = await coreRequest.get(eventsPath).set('Authorization', sharedToken)
        .query({ limit: 100, state: 'all' });

      assert.strictEqual(res.status, 200);
      const accessibleStreamIds = [roStreamId, roChildId, cbStreamId, cbChildId, mgStreamId, mgChildId];
      for (const event of res.body.events) {
        const isAccessible = event.streamIds.some(sid => accessibleStreamIds.includes(sid));
        assert.ok(isAccessible,
          `Event ${event.id} should be in an accessible stream, got streamIds: ${event.streamIds}`);
      }
      // Should NOT contain events from mg2 stream (not in sharedToken's permissions)
      assert.ok(!res.body.events.some(e => e.id === mg2EventId),
        'Should not contain events from non-permitted streams');
    });

    it('[NKI5] `get` must return all events when permissions are defined for "all streams" (*)',
      async function () {
        const res = await coreRequest.get(eventsPath).set('Authorization', readAllToken)
          .query({ limit: 100, state: 'all' });

        assert.strictEqual(res.status, 200);
        // Should contain events from all streams including mg2
        const allEventIds = [roEventId, roChildEventId, mgEventId, mg2EventId, attEventId];
        for (const id of allEventIds) {
          assert.ok(res.body.events.some(e => e.id === id),
            `Should contain event ${id}`);
        }
      });

    it('[5360] `get` must alternatively accept the access token in the query string',
      async function () {
        const res = await coreRequest.get(eventsPath)
          .query({ auth: sharedToken, streams: [mgStreamId], state: 'all' });

        assert.strictEqual(res.status, 200);
        assert.ok(res.body.events.some(e => e.id === mgEventId));
      });

    it('[KTM1] must forbid getting an attached file if permissions are insufficient',
      async function () {
        const res = await coreRequest
          .get(eventsPath + '/' + attEventId + '/' + attId)
          .set('Authorization', noPermToken);

        assert.strictEqual(res.status, 403);
      });

    it('[2773] must forbid creating events for \'read-only\' streams', async function () {
      const res = await coreRequest.post(eventsPath).set('Authorization', sharedToken)
        .send({ type: 'test/test', streamIds: [roStreamId] });

      assert.strictEqual(res.status, 403);
    });

    it('[ZKZZ] must forbid updating events for \'read-only\' streams', async function () {
      // Also checks recursive permissions
      const res = await coreRequest
        .put(eventsPath + '/' + roEventId)
        .set('Authorization', sharedToken)
        .send({ content: {} });

      assert.strictEqual(res.status, 403);
    });

    it('[4H62] must forbid deleting events for \'read-only\' streams', async function () {
      const res = await coreRequest
        .del(eventsPath + '/' + roChildEventId)
        .set('Authorization', sharedToken);

      assert.strictEqual(res.status, 403);
    });

    it('[Y38T] must allow creating events for \'contribute\' streams', async function () {
      const data = {
        time: timestamp.now('-5h'),
        duration: timestamp.duration('1h'),
        type: 'test/test',
        streamIds: [cbStreamId]
      };
      const res = await coreRequest.post(eventsPath).set('Authorization', sharedToken)
        .send(data);

      assert.strictEqual(res.status, 201);
    });
  });

  describe('[AP02] Streams', function () {
    it('[BSFP] `get` must only return streams for which permissions are defined',
      async function () {
        const res = await coreRequest.get(streamsPath).set('Authorization', sharedToken)
          .query({ state: 'all' });

        assert.strictEqual(res.status, 200);
        const expectedStreamIds = [roStreamId, cbStreamId, mgStreamId, mgTrStreamId];
        if (isAuditActive) {
          expectedStreamIds.push(':_audit:access-' + sharedAccessId);
        }
        assert.strictEqual(res.body.streams.length, expectedStreamIds.length,
          `Expected ${expectedStreamIds.length} top-level streams, got ${res.body.streams.length}: ` +
          res.body.streams.map(s => s.id).join(', '));
        for (const stream of res.body.streams) {
          assert.ok(expectedStreamIds.includes(stream.id),
            `Stream ${stream.id} should be in expected list`);
        }
      });

    it('[R4IA] must forbid creating child streams in \'read-only\' streams', async function () {
      const res = await coreRequest.post(streamsPath).set('Authorization', sharedToken)
        .send({ name: 'Forbidden Child', parentId: roStreamId });

      assert.strictEqual(res.status, 403);
    });

    it('[KHI7] must forbid creating child streams in \'contribute\' streams', async function () {
      const res = await coreRequest.post(streamsPath).set('Authorization', sharedToken)
        .send({ name: 'Forbidden Child', parentId: cbStreamId });

      assert.strictEqual(res.status, 403);
    });

    it('[MCDP] must forbid deleting child streams in \'contribute\' streams', async function () {
      const res = await coreRequest
        .del(streamsPath + '/' + cbChildId)
        .set('Authorization', sharedToken);

      assert.strictEqual(res.status, 403);
    });

    it('[7B6P] must forbid updating \'contribute\' streams', async function () {
      const res = await coreRequest
        .put(streamsPath + '/' + cbStreamId)
        .set('Authorization', sharedToken)
        .send({ name: 'Renamed' });

      assert.strictEqual(res.status, 403);
    });

    it('[RG5R] must forbid deleting \'contribute\' streams', async function () {
      const res = await coreRequest
        .del(streamsPath + '/' + cbStreamId)
        .set('Authorization', sharedToken)
        .query({ mergeEventsWithParent: true });

      assert.strictEqual(res.status, 403);
    });

    it('[21AZ] must not allow creating child streams in trashed \'managed\' streams',
      async function () {
        const res = await coreRequest.post(streamsPath).set('Authorization', sharedToken)
          .send({ name: 'Child of Trashed', parentId: mgTrStreamId });

        assert.strictEqual(res.status, 400);
      });

    it('[O1AZ] must allow creating child streams in \'managed\' streams', async function () {
      const res = await coreRequest.post(streamsPath).set('Authorization', manageToken2)
        .send({ name: 'New Child', parentId: mg2StreamId });

      assert.strictEqual(res.status, 201);
    });

    it('[5QPU] must forbid moving streams into non-\'managed\' parent streams',
      async function () {
        const res = await coreRequest
          .put(streamsPath + '/' + mgChildId)
          .set('Authorization', sharedToken)
          .send({ parentId: cbStreamId });

        assert.strictEqual(res.status, 403);
      });

    it('[HHSS] must recursively apply permissions to the streams\' child streams',
      async function () {
        const res = await coreRequest.post(streamsPath).set('Authorization', sharedToken)
          .send({ name: 'Forbidden Grandchild', parentId: roChildId });

        assert.strictEqual(res.status, 403);
      });

    it('[NJ1A] must allow access to all streams when no specific stream permissions are defined',
      async function () {
        const res = await coreRequest.get(streamsPath).set('Authorization', readAllToken)
          .query({ state: 'all' });

        assert.strictEqual(res.status, 200);
        // readAllToken with '*: read' should see all user streams
        const allRootStreamIds = [roStreamId, cbStreamId, mgStreamId, mg2StreamId];
        for (const id of allRootStreamIds) {
          assert.ok(res.body.streams.some(s => s.id === id),
            `Should find stream ${id} in response`);
        }
      });

    // KP1Q must be last: it trashes mgChildId which affects other tests
    it('[KP1Q] must allow deleting child streams in \'managed\' streams', async function () {
      const res = await coreRequest
        .del(streamsPath + '/' + mgChildId)
        .set('Authorization', sharedToken);

      assert.strictEqual(res.status, 200); // trashed -> considered an update
    });
  });

  describe('[AP03] Auth and change tracking', function () {
    it('[YE49] must handle optional caller id in auth (in addition to token)', async function () {
      const callerId = 'test-caller-id';
      const auth = sharedToken + ' ' + callerId;
      const newEventData = {
        type: 'test/test',
        streamIds: [cbStreamId]
      };

      const res = await coreRequest.post(eventsPath)
        .set('Authorization', auth)
        .send(newEventData);

      assert.strictEqual(res.status, 201);
      const event = res.body.event;
      const expectedAuthor = sharedAccessId + ' ' + callerId;
      assert.strictEqual(event.createdBy, expectedAuthor);
      assert.strictEqual(event.modifiedBy, expectedAuthor);
    });
  });
});
