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

const { getConfig } = require('@pryv/boiler');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('api-server/test/test-helpers');
const charlatan = require('charlatan');
const cuid = require('cuid');
const assert = require('chai').assert;
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { TAG_PREFIX, TAG_ROOT_STREAMID } = require('api-server/src/methods/helpers/backwardCompatibility');
const { findById } = require('utils/src/treeUtils');

describe('backward-compatibility', () => {
  describe('Tags as prefixed streams', () => {
    let config;
    let mongoFixtures;
    let server;
    let username;
    let token;
    let streamId;
    before(async () => {
      config = await getConfig();

      mongoFixtures = databaseFixture(await produceMongoConnection());

      username = cuid();
      token = cuid();
      const user = await mongoFixtures.user(username);
      streamId = cuid();
      await user.stream({ id: streamId });
      await user.stream({
        id: TAG_ROOT_STREAMID
      });
      await user.access({ token, type: 'personal' });
      await user.session(token);

      server = await context.spawn({
        backwardCompatibility: { systemStreams: { prefix: { isActive: true } } },
        dnsLess: { isActive: true }, // so updating account streams does not notify register
        versioning: {
          deletionMode: 'keep-everything',
          forceKeepHistory: true
        }
      });
    });
    after(async () => {
      await server.stop();
      await mongoFixtures.clean();
      config.injectTestConfig({});
    });

    function post (methodsPath, payload) {
      return server
        .request()
        .post(`/${username}/${methodsPath}`)
        .set('Authorization', token)
        .send(payload);
    }
    function put (methodsPath, payload) {
      return server
        .request()
        .put(`/${username}/${methodsPath}`)
        .set('Authorization', token)
        .send(payload);
    }
    function get (methodsPath, payload) {
      return server
        .request()
        .get(`/${username}/${methodsPath}`)
        .set('Authorization', token);
    }

    describe('when the stream associated to the tag exists', () => {
      describe('when creating an event', () => {
        let tag;
        before(async () => {
          tag = charlatan.Lorem.characters(15);
          await post('streams', {
            id: TAG_PREFIX + tag,
            parentId: TAG_ROOT_STREAMID
          });
        });
        it('[V39L] must create the event with the streamIds translated from tags', async () => {
          const res = await post('events', {
            type: 'activity/plain',
            streamIds: [streamId],
            tags: [tag]
          });
          assert.equal(res.status, 201);
          const event = res.body.event;
          assert.deepEqual({
            tags: event.tags,
            streamIds: event.streamIds
          }, {
            tags: [tag],
            streamIds: [streamId, TAG_PREFIX + tag]
          }, 'event does not have tags or prefixed streamIds');
        });
      });
    });
    describe('when the stream associated to the tag does not exist', () => {
      describe('when creating an event', () => {
        let tag;
        before(() => {
          tag = charlatan.Lorem.characters(15);
        });
        it('[OMGX] must create the streams with the streamId translated from tags and adapt the event as accordingly', async () => {
          const res = await post('events', {
            type: 'activity/plain',
            streamIds: [streamId],
            tags: [tag]
          });
          assert.equal(res.status, 201);
          const res2 = await get('streams');
          assert.equal(res2.status, 200);
          const streams = res2.body.streams;
          const stream = findById(streams, TAG_PREFIX + tag);
          assert.exists(stream);
          assert.equal(stream.parentId, TAG_ROOT_STREAMID);
        });
      });
      describe('when updating an event', () => {
        let tag;
        let eventId;
        before(async () => {
          tag = charlatan.Lorem.characters(15);
          const res = await post('events', {
            type: 'activity/plain',
            streamIds: [streamId]
          });
          eventId = res.body.event.id;
        });
        it('[NWQ6] must create the streams with the streamId translated from tags and adapt the event as accordingly', async () => {
          const res = await put(`events/${eventId}`, { tags: [tag] });
          assert.equal(res.status, 200);
          const res2 = await get('streams');
          assert.equal(res2.status, 200);
          const streams = res2.body.streams;
          const stream = findById(streams, TAG_PREFIX + tag);
          assert.exists(stream);
          assert.equal(stream.parentId, TAG_ROOT_STREAMID);
        });
      });
    });
    describe('when fetching events', () => {
      before(async () => {
        await post('events', {
          streamIds: [streamId],
          type: 'activity/plain',
          tags: ['hello']
        });
      });
      it('[R3NU] should return the event with its tags', async () => {
        const res = await get('events');
        assert.equal(res.status, 200);
        const events = res.body.events;
        const eventWithTags = events.filter(e => e.tags.includes('hello'));
        assert.exists(eventWithTags);
      });
    });
  });

  describe('System stream id prefx', () => {
    const DISABLE_BACKWARD_COMPATIBILITY_PARAM = 'disable-backward-compatibility-prefix';

    const DOT = '.';
    const PRYV_PREFIX = ':_system:';
    const CUSTOMER_PREFIX = ':system:';

    let config;
    let mongoFixtures;
    let server;
    let username;
    let token;
    let systemEventId;
    before(async () => {
      config = await getConfig();

      mongoFixtures = databaseFixture(await produceMongoConnection());

      username = cuid();
      token = cuid();
      const user = await mongoFixtures.user(username);
      const stream = await user.stream();
      await stream.event({
        type: 'language/iso-639-1',
        content: charlatan.Lorem.characters(2)
      });
      await user.access({
        permissions: [{
          streamId: SystemStreamsSerializer.addPrivatePrefixToStreamId('account'),
          level: 'read'
        }]
      });
      const access = await user.access({
        permissions: [{
          streamId: SystemStreamsSerializer.addPrivatePrefixToStreamId('account'),
          level: 'read'
        }]
      });
      const accessId = access.attrs.id;

      await user.access({ token, type: 'personal' });
      await user.session(token);

      server = await context.spawn({
        backwardCompatibility: { systemStreams: { prefix: { isActive: true } } },
        dnsLess: { isActive: true }, // so updating account streams does not notify register
        versioning: {
          deletionMode: 'keep-everything',
          forceKeepHistory: true
        }
      });

      await del(`/${username}/accesses/${accessId}`);

      const res = await get(`/${username}/events`);
      const systemEvent = res.body.events.find(e => e.streamIds.includes('.language'));
      systemEventId = systemEvent.id;
      await put(`/${username}/events/${systemEventId}`, {
        content: charlatan.Lorem.characters(2)
      });
      await post(`/${username}/events`, {
        streamIds: ['.language'],
        type: 'language/iso-639-1',
        content: charlatan.Lorem.characters(2)
      });
    });

    after(async () => {
      await server.stop();
      await mongoFixtures.clean();
      config.injectTestConfig({});
    });

    function checkOldPrefixes (streamIds) {
      for (const streamId of streamIds) {
        checkOldPrefix(streamId);
      }
    }
    /**
     * if old prefix, must be system stream
     * if not, and not system stream, fine
     * if not, and systemStream, not fine
     */
    function checkOldPrefix (streamId) {
      if (streamId.startsWith(DOT)) {
        const streamIdWithoutPrefix = removeDot(streamId);
        let customStreamIdVariant, privateStreamIdVariant;
        try { customStreamIdVariant = SystemStreamsSerializer.addCustomerPrefixToStreamId(streamIdWithoutPrefix); } catch (e) {}
        try { privateStreamIdVariant = SystemStreamsSerializer.addPrivatePrefixToStreamId(streamIdWithoutPrefix); } catch (e) {}
        assert.isTrue(customStreamIdVariant != null || privateStreamIdVariant != null, 'streamId starting with dot but neither custom nor private: ' + streamId);
      } else {
        if (!SystemStreamsSerializer.isSystemStreamId(streamId)) return;
        assert.isFalse(streamId.startsWith(PRYV_PREFIX), `streamId "${streamId}" starts with "${PRYV_PREFIX}"`);
        assert.isFalse(streamId.startsWith(CUSTOMER_PREFIX), `streamId "${streamId}" starts with "${CUSTOMER_PREFIX}"`);
      }
      function removeDot (streamId) {
        return streamId.substring(1);
      }
    }
    async function post (path, payload, query) {
      return await server.request()
        .post(path)
        .set('Authorization', token)
        .set('Content-Type', 'application/json')
        .send(payload);
    }
    async function get (path, query) {
      return await server.request()
        .get(path)
        .set('Authorization', token)
        .query(query);
    }
    async function put (path, payload, query) {
      return await server.request()
        .put(path)
        .set('Authorization', token)
        .query(query)
        .send(payload);
    }
    async function del (path, query) {
      return await server.request()
        .del(path)
        .set('Authorization', token)
        .query(query);
    }

    describe(' Account streams reserved words', () => {
      it('[4L48] Can create an "account" stream, and add event to it', async () => {
        const batchOps = [
          {
            method: 'streams.create',
            params: {
              id: 'account',
              name: 'account'
            }
          },
          {
            method: 'events.create',
            params: {
              type: 'note/txt',
              content: 'hello',
              streamId: 'account'
            }
          },
          {
            method: 'events.get',
            params: {
              streams: ['account']
            }
          }
        ];
        const res = await post(`/${username}/`, batchOps);
        const results = res.body.results;
        assert.equal(results?.length, 3);
        assert.equal(results[0]?.stream?.id, 'account', 'stream should have been created');
        assert.equal(results[1]?.event?.streamId, 'account', 'event should have been created in account stream');
        assert.isArray(results[2]?.events, 'events should have been returned');
        assert.equal(results[2]?.events?.length, 1, 'events should have been returned');
        assert.equal(results[2]?.events?.[0]?.streamId, 'account', 'event should have been returned in account stream');
      });
    });

    describe('events', () => {
      it('[Q40I] must return old prefixes in events.get', async () => {
        const res = await get(`/${username}/events`);
        assert.isNotEmpty(res.body.events);
        for (const event of res.body.events) {
          checkOldPrefixes(event.streamIds);
        }
      });
      it('[4YCD] must accept old prefixes in events.get', async () => {
        const res = await get(`/${username}/events`, { streams: ['.email'] });
        assert.equal(res.status, 200);
        assert.isNotEmpty(res.body.events);
        for (const event of res.body.events) {
          checkOldPrefixes(event.streamIds);
        }
      });
      it('[CF3N] must return old prefixes in events.getOne (including history)', async () => {
        const res = await get(`/${username}/events/${systemEventId}`, { includeHistory: true });
        checkOldPrefixes(res.body.event.streamIds);
        assert.isNotEmpty(res.body.history);
        for (const event of res.body.history) {
          checkOldPrefixes(event.streamIds);
        }
      });
      it('[U28C] must accept old prefixes in events.create', async () => {
        const res = await post(`/${username}/events/`, {
          streamIds: ['.language'],
          type: 'language/iso-639-1',
          content: charlatan.Lorem.characters(2)
        });
        assert.equal(res.status, 201);
        checkOldPrefixes(res.body.event.streamIds);
      });
      it('[YIWX] must return old prefixes in events.update', async () => {
        const res = await put(`/${username}/events/${systemEventId}`, {
          content: charlatan.Lorem.characters(2)
        });
        checkOldPrefixes(res.body.event.streamIds);
      });
      it('[75DN] must return old prefixes in events.delete', async () => {
        const res = await del(`/${username}/events/${systemEventId}`);
        checkOldPrefixes(res.body.event.streamIds);
      });
    });

    describe('streams', () => {
      it('[WY07] must return old prefixes in streams.get', async () => {
        const res = await get(`/${username}/streams/`);
        assert.isNotEmpty(res.body.streams);

        for (const stream of res.body.streams) {
          checkStream(stream);
        }

        function checkStream (stream) {
          checkOldPrefix(stream.id);
          if (stream.parentId != null) checkOldPrefix(stream.parentId);
          for (const child of stream.children) {
            checkStream(child);
          }
        }
      });
      it('[YJS6] must accept old prefixes in streams.get', async () => {
        const res = await get(`/${username}/streams/`, { parentId: '.account' });
        assert.isNotEmpty(res.body.streams);
        for (const stream of res.body.streams) {
          checkOldPrefix(stream.id);
          if (stream.parentId != null) checkOldPrefix(stream.parentId);
        }
      });
      it('[CCE8] must handle old prefixes in streams.create', async () => {
        const res = await post(`/${username}/streams/`, {
          id: charlatan.Lorem.word(),
          name: charlatan.Lorem.word(),
          parentId: '.language'
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.id, 'invalid-operation'); // not unknown referenced streamId
      });
      it('[4DP2] must accept old prefixes in streams.update', async () => {
        const res = await put(`/${username}/streams/.language`, {
          content: charlatan.Lorem.characters(2)
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.id, 'invalid-operation'); // not unknown referenced streamId
      });
      it('[LQ5X] must return old prefixes in streams.delete', async () => {
        const res = await del(`/${username}/streams/.language`);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.id, 'invalid-operation'); // not unknown referenced streamId
      });
    });

    describe('accesses', () => {
      it('[UDJF] must return old prefixes in accesses.get', async () => {
        const res = await get(`/${username}/accesses/`, {
          includeExpired: true,
          includeDeletions: true
        });
        const accesses = res.body.accesses;
        assert.isNotEmpty(accesses);
        for (const access of accesses) {
          if (access.permissions == null) continue;
          for (const permission of access.permissions) {
            checkOldPrefix(permission.streamId);
          }
        }
        const deletions = res.body.accessDeletions;
        assert.isNotEmpty(deletions);
        for (const access of deletions) {
          if (access.permissions == null) continue;
          for (const permission of access.permissions) {
            checkOldPrefix(permission.streamId);
          }
        }
      });
      it('[DWWD] must accept old prefixes in accesses.create', async () => {
        const res = await post(`/${username}/accesses/`, {
          name: charlatan.Lorem.characters(10),
          permissions: [{
            streamId: '.invitationToken',
            level: 'read'
          }, {
            feature: 'selfRevoke',
            setting: 'forbidden'
          }],
          clientData: {
            something: 'hi'
          }
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.id, 'invalid-operation'); // not unknown referenced streamId
      });
    });

    describe('when disabling backward compatibility using the header param to use new prefixes', () => {
      before(async () => {
        const res = await get(`/${username}/events`);
        const systemEvent = res.body.events.find(e => e.streamIds.includes(SystemStreamsSerializer.addPrivatePrefixToStreamId('language')));
        systemEventId = systemEvent.id;
        await put(`/${username}/events/${systemEventId}`, {
          content: charlatan.Lorem.characters(2)
        });
        await post(`/${username}/events`, {
          streamIds: [SystemStreamsSerializer.addPrivatePrefixToStreamId('language')],
          type: 'language/iso-639-1',
          content: charlatan.Lorem.characters(2)
        });
      });

      async function post (path, payload, query) {
        return await server.request()
          .post(path)
          .set(DISABLE_BACKWARD_COMPATIBILITY_PARAM, 'true')
          .set('Authorization', token)
          .set('Content-Type', 'application/json')
          .send(payload);
      }
      async function get (path, query) {
        return await server.request()
          .get(path)
          .set(DISABLE_BACKWARD_COMPATIBILITY_PARAM, 'true')
          .set('Authorization', token)
          .query(query);
      }
      async function put (path, payload, query) {
        return await server.request()
          .put(path)
          .set(DISABLE_BACKWARD_COMPATIBILITY_PARAM, true)
          .set('Authorization', token)
          .query(query)
          .send(payload);
      }
      async function del (path, query) {
        return await server.request()
          .del(path)
          .set(DISABLE_BACKWARD_COMPATIBILITY_PARAM, true)
          .set('Authorization', token)
          .query(query);
      }

      function checkNewPrefixes (streamIds) {
        for (const streamId of streamIds) {
          checkNewPrefix(streamId);
        }
      }
      function checkNewPrefix (streamId) {
        assert.isFalse(streamId.startsWith(DOT), `streamId "${streamId}" starts with "${DOT}"`);
        if (!SystemStreamsSerializer.isSystemStreamId(streamId)) return;
        if (SystemStreamsSerializer.isPrivateSystemStreamId(streamId)) { assert.isTrue(streamId.startsWith(PRYV_PREFIX), `streamId "${streamId}" does not start with "${PRYV_PREFIX}"`); }
        if (SystemStreamsSerializer.isCustomerSystemStreamId(streamId)) { assert.isTrue(streamId.startsWith(CUSTOMER_PREFIX), `streamId "${streamId}" does not start with "${CUSTOMER_PREFIX}"`); }
      }

      describe('events', () => {
        it('[CZN1] must return new prefixes in events.get', async () => {
          const res = await get(`/${username}/events`);
          assert.isNotEmpty(res.body.events);
          for (const event of res.body.events) {
            checkNewPrefixes(event.streamIds);
          }
        });
        it('[SHW1] must accept new prefixes in events.get', async () => {
          const res = await get(`/${username}/events`, { streams: [SystemStreamsSerializer.addCustomerPrefixToStreamId('email')] });
          assert.equal(res.status, 200);
          assert.isNotEmpty(res.body.events);
          for (const event of res.body.events) {
            checkNewPrefixes(event.streamIds);
          }
        });
        it('[6N5B] must return new prefixes in events.getOne (including history)', async () => {
          const res = await get(`/${username}/events/${systemEventId}`, { includeHistory: true });
          checkNewPrefixes(res.body.event.streamIds);
          assert.isNotEmpty(res.body.history);
          for (const event of res.body.history) {
            checkNewPrefixes(event.streamIds);
          }
        });
        it('[65U8] must accept new prefixes in events.create', async () => {
          const res = await post(`/${username}/events/`, {
            streamIds: [SystemStreamsSerializer.addPrivatePrefixToStreamId('language')],
            type: 'language/iso-639-1',
            content: charlatan.Lorem.characters(2)
          });
          assert.equal(res.status, 201);
          checkNewPrefixes(res.body.event.streamIds);
        });
        it('[CSKF] must return new prefixes in events.update', async () => {
          const res = await put(`/${username}/events/${systemEventId}`, {
            content: charlatan.Lorem.characters(2)
          });
          checkNewPrefixes(res.body.event.streamIds);
        });
        it('[4IEX] must return new prefixes in events.delete', async () => {
          const res = await del(`/${username}/events/${systemEventId}`);
          checkNewPrefixes(res.body.event.streamIds);
        });
      });
      describe('streams', () => {
        it('[O7RD] must return new prefixes in streams.get', async () => {
          const res = await get(`/${username}/streams/`);
          assert.isNotEmpty(res.body.streams);
          for (const stream of res.body.streams) {
            checkNewPrefix(stream.id);
            if (stream.parentId != null) checkNewPrefix(stream.parentId);
          }
        });
        it('[VMH7] must accept new prefixes in streams.get', async () => {
          const res = await get(`/${username}/streams/`, { parentId: SystemStreamsSerializer.addPrivatePrefixToStreamId('account') });
          assert.isNotEmpty(res.body.streams);
          for (const stream of res.body.streams) {
            checkNewPrefix(stream.id);
            if (stream.parentId != null) checkNewPrefix(stream.parentId);
          }
        });
        it('[6EFG] must handle new prefixes in streams.create', async () => {
          const res = await post(`/${username}/streams/`, {
            id: charlatan.Lorem.word(),
            name: charlatan.Lorem.word(),
            parentId: SystemStreamsSerializer.addPrivatePrefixToStreamId('language')
          });
          assert.equal(res.status, 400);
          assert.equal(res.body.error.id, 'invalid-operation'); // not unknown referenced streamId
        });
        it('[LVOF] must accept new prefixes in streams.update', async () => {
          const res = await put(`/${username}/streams/${SystemStreamsSerializer.addPrivatePrefixToStreamId('language')}`, {
            content: charlatan.Lorem.characters(2)
          });
          assert.equal(res.status, 400);
          assert.equal(res.body.error.id, 'invalid-operation'); // not unknown referenced streamId
        });
        it('[C73R] must return new prefixes in streams.delete', async () => {
          const res = await del(`/${username}/streams/${SystemStreamsSerializer.addPrivatePrefixToStreamId('language')}`);
          assert.equal(res.status, 400);
          assert.equal(res.body.error.id, 'invalid-operation'); // not unknown referenced streamId
        });
      });
      describe('accesses', () => {
        it('[O9OH] must return new prefixes in accesses.get', async () => {
          const res = await get(`/${username}/accesses/`, {
            includeExpired: true,
            includeDeletions: true
          });
          const accesses = res.body.accesses;
          assert.isNotEmpty(accesses);
          for (const access of accesses) {
            if (access.permissions == null) continue;
            for (const permission of access.permissions) {
              checkNewPrefix(permission.streamId);
            }
          }
          const deletions = res.body.accessDeletions;
          assert.isNotEmpty(deletions);
          for (const access of deletions) {
            if (access.permissions == null) continue;
            for (const permission of access.permissions) {
              checkNewPrefix(permission.streamId);
            }
          }
        });
        it('[GFRT] must accept new prefixes in accesses.create', async () => {
          const res = await post(`/${username}/accesses/`, {
            name: charlatan.Lorem.characters(10),
            permissions: [{
              streamId: SystemStreamsSerializer.addPrivatePrefixToStreamId('invitationToken'),
              level: 'read'
            }],
            clientData: {
              something: 'hi'
            }
          });
          assert.equal(res.status, 400);
          assert.equal(res.body.error.id, 'invalid-operation'); // not unknown referenced streamId
        });
      });
    });
  });
});
