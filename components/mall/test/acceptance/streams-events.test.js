/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
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
    assert.exists(appAccessDummy);

    const res2 = await coreRequest.post(accessesPath)
      .set('Authorization', personalToken)
      .send({ type: 'app', name: 'app access master', token: 'app-token-master', permissions: [{ streamId: '*', level: 'manage' }] });
    appAccessMaster = res2.body.access;
    assert.exists(appAccessMaster);
  });

  after(async function () {
    await mongoFixtures.clean();
  });

  describe('Streams', function () {
    describe('GET', function () {
      it('[1Q12] Must retrieve dummy streams when querying parentId', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .set('Authorization', appAccessDummy.token)
          .query({ parentId: ':dummy:' });
        const streams = res.body.streams;
        assert.exists(streams);
        assert.equal(streams.length, 1);
        assert.equal(streams[0].children.length, 2);
        assert.equal(streams[0].name, user.username);
        assert.equal(streams[0].parentId, ':dummy:');
      });

      it('[UVQ2] Must retrieve "yo" streams and ":dummy:" when requesting "*"', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .set('Authorization', appAccessDummy.token)
          .query({});
        const streams = res.body.streams;
        assert.exists(streams);
        assert.equal(streams.length, !isAuditActive ? 2 : 3);
        assert.equal(streams[0].id, streamId);
        assert.equal(streams[0].children.length, 1);
        assert.equal(streams[1].id, ':dummy:');
        if (isAuditActive) { assert.equal(streams[2].id, ':_audit:access-' + appAccessDummy.id); }
      });

      it('[XC20] master token must retrieve "yo" streams and all stores when requesting "*"', async () => {
        const res = await coreRequest
          .get(streamsPath)
          .set('Authorization', appAccessMaster.token)
          .query({});
        const streams = res.body.streams;
        assert.exists(streams);
        // we also get helpers here, because with the current implementation, it is returned.
        assert.equal(streams.length, !isAuditActive ? 4 : 5);
        assert.equal(streams[0].id, ':dummy:');
        assert.equal(streams[1].id, ':faulty:');
        if (isAuditActive) {
          assert.equal(streams[2].id, ':_audit:');
          assert.equal(streams[3].id, streamId);
          assert.equal(streams[3].children.length, 1);
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
          assert.notExists(stream.parentId);
        }
      });
    });

    describe('CREATE', function () {
      it('[2Q12] Create a stream under dummy', async () => {
        const res = await coreRequest
          .post(streamsPath)
          .set('Authorization', appAccessDummy.token)
          .send({ id: ':dummy:fluffy', name: 'Fluffy', parentId: ':dummy:' });
        const stream = res.body.stream;
        assert.equal(stream.id, ':dummy:fluffy');
        assert.equal(stream.parentId, ':dummy:');
        assert.equal(stream.name, 'Bluppy');
      });

      it('[2Q13] Should fail creating outside of store', async () => {
        const res = await coreRequest
          .post(streamsPath)
          .set('Authorization', personalToken)
          .send({ id: ':dummy:fluffy', name: 'Fluffy', parentId: 'yo' });
        assert.equal(res.body.error.id, 'invalid-request-structure');
        assert.equal(res.body.error.message, 'streams cannot have an id different non matching from their parentId store');
      });

      it('[2Q14] Should fail creating outside of store 2', async () => {
        const res = await coreRequest
          .post(streamsPath)
          .set('Authorization', personalToken)
          .send({ id: ':dummy:fluffy', name: 'Fluffy' });
        assert.equal(res.body.error.id, 'invalid-request-structure');
        assert.equal(res.body.error.message, 'streams cannot have an id different non matching from their parentId store');
      });
    });

    describe('UPDATE', function () {
      it('[3Q12] Create a stream under dummy', async () => {
        const res = await coreRequest
          .put(streamsPath + ':dummy:mariana')
          .set('Authorization', personalToken)
          .send({ name: 'Fluffy' });
        const stream = res.body.stream;
        assert.equal(stream.id, ':dummy:mariana');
        assert.equal(stream.parentId, ':dummy:');
        assert.equal(stream.name, 'Bluppy');
      });

      it('[3Q13] Should fail moving a stream outside of store', async () => {
        const res = await coreRequest
          .put(streamsPath + ':dummy:mariana')
          .set('Authorization', personalToken)
          .send({ parentId: 'yo' });
        assert.equal(res.body.error.id, 'invalid-request-structure');
        assert.equal(res.body.error.message, 'streams cannot have an id different non matching from their parentId store');
      });
    });
  });

  describe('Events', function () {
    describe('GET', function () {
      it('[XD21] personal token must retrive :dummy: events', async () => {
        const res = await coreRequest
          .get(eventsPath)
          .query({ streams: [':dummy:'] })
          .set('Authorization', personalToken)
          .query({});
        checkDummyEvent0(res.body);
        assert.exists(res.body.events[1], 'We should also get events from antonia');
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
        assert.exists(res.body.events.length, 1, 'There should be only one event in mariana');
      });
    });

    describe('CREATE', function () {
      it('[YD21] create event on :dummy:', async () => {
        const res = await coreRequest
          .post(eventsPath)
          .send({ type: 'note/txt', content: 'hello', streamIds: [':dummy:mariana'] })
          .set('Authorization', appAccessDummy.token);
        assert.equal(res.body.event.content, 'Received');
      });

      it('[YD22] create with a given id on :dummy:', async () => {
        const res = await coreRequest
          .post(eventsPath)
          .send({ id: ':dummy:fluffy', type: 'note/txt', content: 'hello', streamIds: [':dummy:mariana'] })
          .set('Authorization', appAccessDummy.token);
        assert.equal(res.body.event.id, ':dummy:fluffy');
        assert.equal(res.body.event.content, 'Received');
      });

      it('[YD23] should fail on mismatching stream and id in store', async () => {
        const res = await coreRequest
          .post(eventsPath)
          .send({ id: ':dummy:fluffy', type: 'note/txt', content: 'hello', streamIds: ['yo'] })
          .set('Authorization', appAccessMaster.token);
        assert.equal(res.body.error.id, 'invalid-request-structure');
        assert.equal(res.body.error.message, 'Cannot create or update an event with id and streamIds belonging to different stores');
      });

      it('[YD24] should fail on mismatching stream in store and id', async () => {
        const res = await coreRequest
          .post(eventsPath)
          .send({ id: 'cslpldeicsd0nmkkl7dif1qtk', type: 'note/txt', content: 'hello', streamIds: [':dummy:mariana'] })
          .set('Authorization', appAccessMaster.token);
        assert.equal(res.body.error.id, 'invalid-request-structure');
        assert.equal(res.body.error.message, 'Cannot create or update an event with id and streamIds belonging to different stores');
      });
    });

    describe('UPDATE', function () {
      it('[ZD21] update event :dummy:dummyevent0', async () => {
        const res = await coreRequest
          .put(eventsPath + ':dummy:dummyevent0')
          .send({ content: 'bye' })
          .set('Authorization', appAccessDummy.token);
        assert.equal(res.body.event.content, 'bye');
      });

      it('[ZD22] should fail moving an event to another store', async () => {
        const res = await coreRequest
          .put(eventsPath + ':dummy:dummyevent0')
          .send({ streamIds: ['yo'] })
          .set('Authorization', appAccessDummy.token);
        assert.equal(res.body.error.id, 'invalid-request-structure');
        assert.equal(res.body.error.message, 'Cannot create or update an event with id and streamIds belonging to different stores');
      });
    });
  });
});

function checkDummyEvent0 (body) {
  assert.notExists(body.error);
  assert.exists(body.events, 'Should receive events object');
  assert.exists(body.events[0], 'Should receive at least on event');
  const event = body.events[0];
  assert.equal(event.id, ':dummy:dummyevent0');
}

function checkDummyStreamsStructure (body) {
  assert.notExists(body.error);
  assert.exists(body.streams);
  const streams = body.streams;
  assert.equal(streams.length, 1, 'Should find one stream');
  assert.equal(streams[0].id, ':dummy:myself', 'Should find myself stream');
  assert.equal(streams[0].children.length, 2, 'myself stream should have two children');
  assert.equal(streams[0].children[0].id, ':dummy:mariana', 'myself stream should have mariana children');
  assert.equal(streams[0].children[1].id, ':dummy:antonia', 'myself stream should have antonia children');
}
