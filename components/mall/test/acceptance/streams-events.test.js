/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global assert, initTests, initCore, getNewFixture, charlatan, cuid, coreRequest  */

require('test-helpers/src/api-server-tests-config');
const { getConfig } = require('@pryv/boiler');

describe('[MSTE] Stores Streams & Events', function () {
  let user, username, password, access, appAccessDummy, appAccessMaster;
  let personalToken;
  let mongoFixtures;
  let isAuditActive;
  let accessesPath, streamsPath, eventsPath;

  before(async () => {
    isAuditActive = (await getConfig()).get('audit:active');
  });

  const streamId = 'yo';
  before(async function () {
    await initTests();
    await initCore();
    mongoFixtures = getNewFixture();
    user = await mongoFixtures.user(charlatan.Lorem.characters(7), {
      password
    });

    username = user.attrs.username;
    await user.stream({ id: streamId, name: 'YO' });
    await user.stream({ id: 'sonOfYo', name: 'Son of YO', parentId: streamId });
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    personalToken = access.attrs.token;
    await user.session(personalToken);
    user = user.attrs;
    accessesPath = '/' + username + '/accesses/';
    streamsPath = '/' + username + '/streams/';
    eventsPath = '/' + username + '/events/';

    const res = await coreRequest.post(accessesPath)
      .set('Authorization', personalToken)
      .send({ type: 'app', name: 'app access', token: 'app-token', permissions: [{ streamId, level: 'manage' }, { streamId: ':dummy:', level: 'manage' }] });
    appAccessDummy = res.body.access;
    assert.ok(appAccessDummy);

    const res2 = await coreRequest.post(accessesPath)
      .set('Authorization', personalToken)
      .send({ type: 'app', name: 'app access master', token: 'app-token-master', permissions: [{ streamId: '*', level: 'manage' }] });
    appAccessMaster = res2.body.access;
    assert.ok(appAccessMaster);
  });

  after(async function () {
    await mongoFixtures.clean();
  });

  describe('[MS01] Streams', function () {
    describe('[MS02] GET', function () {
      it('[1Q12] Must retrieve dummy streams when querying parentId', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .set('Authorization', appAccessDummy.token)
          .query({ parentId: ':dummy:' });
        const streams = res.body.streams;
        assert.ok(streams);
        assert.strictEqual(streams.length, 1);
        assert.strictEqual(streams[0].children.length, 2);
        assert.strictEqual(streams[0].name, user.username);
        assert.strictEqual(streams[0].parentId, ':dummy:');
      });

      it('[UVQ2] Must retrieve "yo" streams and ":dummy:" when requesting "*"', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .set('Authorization', appAccessDummy.token)
          .query({});
        const streams = res.body.streams;
        assert.ok(streams);
        assert.strictEqual(streams.length, !isAuditActive ? 2 : 3);
        assert.strictEqual(streams[0].id, streamId);
        assert.strictEqual(streams[0].children.length, 1);
        assert.strictEqual(streams[1].id, ':dummy:');
        if (isAuditActive) { assert.strictEqual(streams[2].id, ':_audit:access-' + appAccessDummy.id); }
      });

      it('[XC20] master token must retrieve "yo" streams and all stores when requesting "*"', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .set('Authorization', appAccessMaster.token)
          .query({});
        const streams = res.body.streams;
        assert.ok(streams);
        // Account store streams (:_system:account) are included
        // in local store root queries (account is passthrough)
        assert.strictEqual(streams.length, !isAuditActive ? 4 : 5);
        assert.strictEqual(streams[0].id, ':dummy:');
        assert.strictEqual(streams[1].id, ':faulty:');
        if (isAuditActive) {
          assert.strictEqual(streams[2].id, ':_audit:');
          assert.strictEqual(streams[3].id, streamId);
          assert.strictEqual(streams[3].children.length, 1);
          assert.strictEqual(streams[4].id, ':_system:account');
        }
      });

      it('[XC21] personal token must retrive :dummy: stream structure', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .query({ parentId: ':dummy:' })
          .set('Authorization', personalToken)
          .query({});
        checkDummyStreamsStructure(res.body);
      });

      it('[XC22] app token must retrive :dummy: stream structure', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .query({ parentId: ':dummy:' })
          .set('Authorization', appAccessDummy.token)
          .query({});
        checkDummyStreamsStructure(res.body);
      });

      it('[XC23] master token must retrive :dummy: stream structure', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .query({ parentId: ':dummy:' })
          .set('Authorization', appAccessMaster.token)
          .query({});
        checkDummyStreamsStructure(res.body);
      });

      it('[3ZTM] Root streams must have null parentIds "*"', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .set('Authorization', appAccessDummy.token)
          .query({});
        const streams = res.body.streams;
        for (const stream of streams) {
          assert.ok(stream.parentId == null);
        }
      });
    });

    describe('[MS03] CREATE', function () {
      it('[2Q12] Create a stream under dummy', async () => {
        const res = await coreRequest
          .post(streamsPath)
          .set('Authorization', appAccessDummy.token)
          .send({ id: ':dummy:fluffy', name: 'Fluffy', parentId: ':dummy:' });
        const stream = res.body.stream;
        assert.strictEqual(stream.id, ':dummy:fluffy');
        assert.strictEqual(stream.parentId, ':dummy:');
        assert.strictEqual(stream.name, 'Bluppy');
      });

      it('[2Q13] Should fail creating outside of store', async () => {
        const res = await coreRequest
          .post(streamsPath)
          .set('Authorization', personalToken)
          .send({ id: ':dummy:fluffy', name: 'Fluffy', parentId: 'yo' });
        assert.strictEqual(res.body.error.id, 'invalid-request-structure');
        assert.strictEqual(res.body.error.message, 'streams cannot have an id different non matching from their parentId store');
      });

      it('[2Q14] Should fail creating outside of store 2', async () => {
        const res = await coreRequest
          .post(streamsPath)
          .set('Authorization', personalToken)
          .send({ id: ':dummy:fluffy', name: 'Fluffy' });
        assert.strictEqual(res.body.error.id, 'invalid-request-structure');
        assert.strictEqual(res.body.error.message, 'streams cannot have an id different non matching from their parentId store');
      });
    });

    describe('[MS04] UPDATE', function () {
      it('[3Q12] Create a stream under dummy', async () => {
        const res = await coreRequest
          .put(streamsPath + ':dummy:mariana')
          .set('Authorization', personalToken)
          .send({ name: 'Fluffy' });
        const stream = res.body.stream;
        assert.strictEqual(stream.id, ':dummy:mariana');
        assert.strictEqual(stream.parentId, ':dummy:');
        assert.strictEqual(stream.name, 'Bluppy');
      });

      it('[3Q13] Should fail moving a stream outside of store', async () => {
        const res = await coreRequest
          .put(streamsPath + ':dummy:mariana')
          .set('Authorization', personalToken)
          .send({ parentId: 'yo' });
        assert.strictEqual(res.body.error.id, 'invalid-request-structure');
        assert.strictEqual(res.body.error.message, 'streams cannot have an id different non matching from their parentId store');
      });
    });
  });

  describe('[MS05] Events', function () {
    describe('[MS06] GET', function () {
      it('[XD21] personal token must retrive :dummy: events', async () => {
        const res = await coreRequest
          .get(eventsPath)
          .query({ streams: [':dummy:'] })
          .set('Authorization', personalToken)
          .query({});
        checkDummyEvent0(res.body);
        assert.ok(res.body.events[1], 'We should also get events from antonia');
      });

      it('[XD22] master token must retrive :dummy: events', async () => {
        const res = await coreRequest
          .get(eventsPath)
          .query({ streams: [':dummy:mariana'] })
          .set('Authorization', appAccessMaster.token)
          .query({});
        checkDummyEvent0(res.body);
      });

      it('[XD23] app token must retrive :dummy: events', async () => {
        const res = await coreRequest
          .get(eventsPath)
          .query({ streams: [':dummy:mariana'] })
          .set('Authorization', appAccessDummy.token)
          .query({});
        checkDummyEvent0(res.body);
        assert.ok(res.body.events.length, 1, 'There should be only one event in mariana');
      });
    });

    describe('[MS07] CREATE', function () {
      it('[YD21] create event on :dummy:', async () => {
        const res = await coreRequest
          .post(eventsPath)
          .send({ type: 'note/txt', content: 'hello', streamIds: [':dummy:mariana'] })
          .set('Authorization', appAccessDummy.token);
        assert.strictEqual(res.body.event.content, 'Received');
      });

      it('[YD22] create with a given id on :dummy:', async () => {
        const res = await coreRequest
          .post(eventsPath)
          .send({ id: ':dummy:fluffy', type: 'note/txt', content: 'hello', streamIds: [':dummy:mariana'] })
          .set('Authorization', appAccessDummy.token);
        assert.strictEqual(res.body.event.id, ':dummy:fluffy');
        assert.strictEqual(res.body.event.content, 'Received');
      });

      it('[YD23] should fail on mismatching stream and id in store', async () => {
        const res = await coreRequest
          .post(eventsPath)
          .send({ id: ':dummy:fluffy', type: 'note/txt', content: 'hello', streamIds: ['yo'] })
          .set('Authorization', appAccessMaster.token);
        assert.strictEqual(res.body.error.id, 'invalid-request-structure');
        assert.strictEqual(res.body.error.message, 'Cannot create or update an event with id and streamIds belonging to different stores');
      });

      it('[YD24] should fail on mismatching stream in store and id', async () => {
        const res = await coreRequest
          .post(eventsPath)
          .send({ id: 'cslpldeicsd0nmkkl7dif1qtk', type: 'note/txt', content: 'hello', streamIds: [':dummy:mariana'] })
          .set('Authorization', appAccessMaster.token);
        assert.strictEqual(res.body.error.id, 'invalid-request-structure');
        assert.strictEqual(res.body.error.message, 'Cannot create or update an event with id and streamIds belonging to different stores');
      });
    });

    describe('[MS08] UPDATE', function () {
      it('[ZD21] update event :dummy:dummyevent0', async () => {
        const res = await coreRequest
          .put(eventsPath + ':dummy:dummyevent0')
          .send({ content: 'bye' })
          .set('Authorization', appAccessDummy.token);
        assert.strictEqual(res.body.event.content, 'bye');
      });

      it('[ZD22] should fail moving an event to another store', async () => {
        const res = await coreRequest
          .put(eventsPath + ':dummy:dummyevent0')
          .send({ streamIds: ['yo'] })
          .set('Authorization', appAccessDummy.token);
        assert.strictEqual(res.body.error.id, 'invalid-request-structure');
        assert.strictEqual(res.body.error.message, 'Cannot create or update an event with id and streamIds belonging to different stores');
      });
    });
  });
});

function checkDummyEvent0 (body) {
  assert.ok(body.error == null);
  assert.ok(body.events, 'Should receive events object');
  assert.ok(body.events[0], 'Should receive at least on event');
  const event = body.events[0];
  assert.strictEqual(event.id, ':dummy:dummyevent0');
}

function checkDummyStreamsStructure (body) {
  assert.ok(body.error == null);
  assert.ok(body.streams);
  const streams = body.streams;
  assert.strictEqual(streams.length, 1, 'Should find one stream');
  assert.strictEqual(streams[0].id, ':dummy:myself', 'Should find myself stream');
  assert.strictEqual(streams[0].children.length, 2, 'myself stream should have two children');
  assert.strictEqual(streams[0].children[0].id, ':dummy:mariana', 'myself stream should have mariana children');
  assert.strictEqual(streams[0].children[1].id, ':dummy:antonia', 'myself stream should have antonia children');
}
