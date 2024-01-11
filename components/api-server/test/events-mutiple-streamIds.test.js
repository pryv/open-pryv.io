/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

require('./test-helpers');

const ErrorIds = require('errors').ErrorIds;
const _ = require('lodash');
const cuid = require('cuid');
const chai = require('chai');
const assert = chai.assert;
const charlatan = require('charlatan');
const { integrity } = require('business');
const timestamp = require('unix-timestamp');

const { fixturePath } = require('./unit/test-helper');

const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('./test-helpers');

require('date-utils');

describe('events.streamIds', function () {
  describe('events', function () {
    let server;
    before(async () => {
      server = await context.spawn();
    });
    after(() => {
      server.stop();
    });

    let mongoFixtures;
    before(async function () {
      mongoFixtures = databaseFixture(await produceMongoConnection());
    });

    let user,
      username,
      streamAId,
      streamBId,
      eventIdA,
      eventIdAB,
      trashedEventIdAB,
      eventA,
      eventAB,
      tokenReadA,
      tokenContributeA,
      tokenContributeAReadB,
      tokenContributeB,
      tokenContributeAB,
      basePathEvent;

    beforeEach(async function () {
      username = cuid();
      streamAId = 'streamA';
      streamBId = 'streamB';
      eventIdA = cuid();
      eventIdAB = cuid();
      trashedEventIdAB = cuid();
      tokenReadA = cuid();
      tokenContributeA = cuid();
      tokenContributeAReadB = cuid();
      tokenContributeB = cuid();
      tokenContributeAB = cuid();
      basePathEvent = `/${username}/events/`;

      user = await mongoFixtures.user(username, {});
      await user.stream({
        id: streamAId,
        name: 'streamA'
      });
      await user.stream({
        id: streamBId,
        name: 'streamB'
      });
      await user.access({
        type: 'app',
        token: tokenReadA,
        permissions: [
          {
            streamId: 'streamA',
            level: 'read'
          }
        ]
      });
      await user.access({
        type: 'app',
        token: tokenContributeA,
        permissions: [
          {
            streamId: 'streamA',
            level: 'contribute'
          }
        ]
      });
      await user.access({
        type: 'app',
        token: tokenContributeAReadB,
        permissions: [
          {
            streamId: 'streamA',
            level: 'contribute'
          },
          {
            streamId: 'streamB',
            level: 'read'
          }
        ]
      });
      await user.access({
        type: 'app',
        token: tokenContributeB,
        permissions: [
          {
            streamId: 'streamB',
            level: 'contribute'
          }
        ]
      });
      await user.access({
        type: 'app',
        token: tokenContributeAB,
        permissions: [
          {
            streamId: 'streamA',
            level: 'contribute'
          },
          {
            streamId: 'streamB',
            level: 'contribute'
          }
        ]
      });
      eventA = await user.event({
        type: 'note/txt',
        content: 'In A',
        id: eventIdA,
        streamIds: [streamAId]
      });
      eventA = eventA.attrs;
      eventAB = await user.event({
        type: 'note/txt',
        content: 'In A and B',
        id: eventIdAB,
        streamIds: [streamAId, streamBId]
      });
      eventAB = eventAB.attrs;
      await user.event({
        type: 'note/txt',
        content: 'In A and B',
        id: trashedEventIdAB,
        streamIds: [streamAId, streamBId],
        trashed: true
      });
    });
    afterEach(async () => {
      await mongoFixtures.clean();
    });

    function eventPath (eventId) {
      return basePathEvent + eventId;
    }

    describe('GET /events', function () {
      it('[WJ0S] must return streamIds & streamId containing the first one (if many)', async function () {
        const res = await server.request()
          .get(basePathEvent)
          .set('Authorization', tokenContributeA);
        const events = res.body.events;
        events.forEach(e => {
          assert.exists(e.streamId);
          assert.exists(e.streamIds);
        });
      });
    });

    describe('GET /events/:id', function () {
      it('[IJQZ] must return streamIds & streamId containing the first one (if many)', async function () {
        const res = await server.request()
          .get(eventPath(eventIdAB))
          .set('Authorization', tokenContributeAReadB);
        const event = res.body.event;
        assert.equal(event.streamId, streamAId);
        assert.deepEqual(event.streamIds, [streamAId, streamBId]);
      });
    });

    describe('POST /events', function () {
      it('[X4PX] must forbid to provide both streamId and streamIds', async function () {
        const res = await server.request()
          .post(basePathEvent)
          .set('Authorization', tokenContributeA)
          .send({
            streamId: streamAId,
            streamIds: [streamAId, streamBId],
            type: 'count/generic',
            content: 12
          });
        assert.equal(res.status, 400);
        const err = res.body.error;
        assert.equal(err.id, ErrorIds.InvalidOperation);
      });

      describe('when using "streamId"', function () {
        it('[1YUV] must return streamIds & streamId', async function () {
          const res = await server.request()
            .post(basePathEvent)
            .set('Authorization', tokenContributeA)
            .send({
              streamId: streamAId,
              type: 'count/generic',
              content: 12
            });
          assert.equal(res.status, 201);
          const event = res.body.event;
          assert.equal(event.streamId, streamAId);
          assert.deepEqual(event.streamIds, [streamAId]);
        });
      });

      describe('when using "streamIds"', function () {
        it('[VXMG] must return streamIds & streamId containing the first one', async function () {
          const res = await server.request()
            .post(basePathEvent)
            .set('Authorization', tokenContributeAB)
            .send({
              streamIds: [streamAId, streamBId],
              type: 'count/generic',
              content: 12
            });
          assert.equal(res.status, 201);
          const event = res.body.event;
          assert.equal(event.streamId, streamAId);
          assert.deepEqual(event.streamIds, [streamAId, streamBId]);
        });

        it('[2QZF] must clean duplicate streamIds', async function () {
          const res = await server.request()
            .post(basePathEvent)
            .set('Authorization', tokenContributeAB)
            .send({
              streamIds: [streamAId, streamBId, streamBId],
              type: 'count/generic',
              content: 12
            });
          assert.equal(res.status, 201);
          const event = res.body.event;
          assert.deepEqual(event.streamIds, [streamAId, streamBId]);
        });

        it('[NY0E] must forbid providing an unknown streamId', async function () {
          const unknownStreamId = 'does-not-exist';
          const res = await server.request()
            .post(basePathEvent)
            .set('Authorization', tokenContributeA)
            .send({
              streamIds: [unknownStreamId],
              type: 'count/generic',
              content: 12
            });
          assert.equal(res.status, 400);
          const err = res.body.error;
          assert.equal(err.id, ErrorIds.UnknownReferencedResource);
          assert.deepEqual(err.data, { streamIds: [unknownStreamId] });
        });

        it('[6Z2D] must forbid creating an event in multiple streams, if a contribute permission is missing on at least one stream', async function () {
          const res = await server.request()
            .post(basePathEvent)
            .set('Authorization', tokenContributeA)
            .send({
              streamIds: [streamAId, streamBId],
              type: 'count/generic',
              content: 12
            });
          assert.equal(res.status, 403);
          const err = res.body.error;
          assert.equal(err.id, ErrorIds.Forbidden);
        });
      });
    });

    describe('PUT /events/:id', function () {
      it('[BBBX] must return streamIds & streamId containing the first one (if many)', async function () {
        const res = await server.request()
          .put(eventPath(eventIdA))
          .set('Authorization', tokenContributeA)
          .send({
            content: 'Now I am updated, still in A though.'
          });
        assert.equal(res.status, 200);
        const event = res.body.event;
        assert.equal(event.streamId, eventA.streamIds[0]);
        assert.deepEqual(event.streamIds, eventA.streamIds);
      });

      it('[42KZ] must allow modification, if you have a contribute permission on at least 1 streamId', async function () {
        const res = await server.request()
          .put(eventPath(eventIdAB))
          .set('Authorization', tokenContributeA)
          .send({
            content: 'Now I am updated, still in AB though.'
          });
        assert.equal(res.status, 200);
      });

      it('[Q5P7] must forbid to provide both streamId and streamIds', async function () {
        const res = await server.request()
          .put(eventPath(eventIdA))
          .set('Authorization', tokenContributeA)
          .send({
            streamId: streamBId,
            streamIds: [streamBId]
          });
        assert.equal(res.status, 400);
        const err = res.body.error;
        assert.equal(err.id, ErrorIds.InvalidOperation);
      });

      describe('when modifying streamIds', function () {
        it('[TQHG] must forbid providing an unknown streamId', async function () {
          const unknownStreamId = 'does-not-exist';
          const res = await server.request()
            .put(eventPath(eventIdA))
            .set('Authorization', tokenContributeA)
            .send({
              streamIds: [unknownStreamId]
            });
          assert.equal(res.status, 400);
          const err = res.body.error;
          assert.equal(err.id, ErrorIds.UnknownReferencedResource);
          assert.deepEqual(err.data, { streamIds: [unknownStreamId] });
        });

        it('[6Q8B] must allow streamId addition, if you have a contribute permission for it', async function () {
          const res = await server.request()
            .put(eventPath(eventIdA))
            .set('Authorization', tokenContributeAB)
            .send({
              streamIds: [streamAId, streamBId]
            });
          assert.equal(res.status, 200);
          const event = res.body.event;
          assert.equal(event.streamId, streamAId);
          assert.deepEqual(event.streamIds, [streamAId, streamBId]);
        });

        it('[MFF7] must forbid streamId addition, if you don\'t have a contribute permission for it', async function () {
          const res = await server.request()
            .put(eventPath(eventIdA))
            .set('Authorization', tokenContributeA)
            .send({
              streamIds: [streamAId, streamBId]
            });
          assert.equal(res.status, 403);
          const err = res.body.error;
          assert.equal(err.id, ErrorIds.Forbidden);
        });

        it('[83N6] must allow streamId deletion, if you have a contribute permission for it', async function () {
          const res = await server.request()
            .put(eventPath(eventIdAB))
            .set('Authorization', tokenContributeAB)
            .send({
              streamIds: [streamAId]
            });
          assert.equal(res.status, 200);
          const event = res.body.event;
          assert.deepEqual(event.streamIds, [streamAId]);
        });

        it('[JLS5] must forbid streamId deletion, if you have read but no contribute permission for it', async function () {
          const res = await server.request()
            .put(eventPath(eventIdAB))
            .set('Authorization', tokenContributeAReadB)
            .send({
              streamIds: [streamAId]
            });
          assert.equal(res.status, 403);
          const error = res.body.error;
          assert.equal(error.id, ErrorIds.Forbidden);
        });
      });
    });

    describe('POST /event/start', function () {
      function path () {
        return basePathEvent + 'start';
      }

      it('[FOM3] must return a 410 (Gone)', async function () {
        const res = await server.request()
          .post(path())
          .set('Authorization', tokenContributeA)
          .send({
            streamIds: [streamAId],
            type: 'activity/plain'
          });
        assert.equal(res.status, 410);
        const error = res.body.error;
        assert.equal(error.id, ErrorIds.Gone);
      });
    });

    describe('POST /event/stop', function () {
      function path () {
        return basePathEvent + 'stop';
      }

      it('[BR33] must return a 410 (Gone)', async function () {
        const res = await server.request()
          .post(path())
          .set('Authorization', tokenContributeA)
          .send({
            streamId: streamAId,
            type: 'activity/plain'
          });
        assert.equal(res.status, 410);
        const error = res.body.error;
        assert.equal(error.id, ErrorIds.Gone);
      });
    });

    describe('DELETE /events/:id', function () {
      function eventPath (eventId) {
        return basePathEvent + eventId;
      }

      it('[BPL0] must return streamIds & streamId containing the first one (if many)', async function () {
        const res = await server.request()
          .delete(eventPath(eventIdAB))
          .set('Authorization', tokenContributeAB);
        assert.equal(res.status, 200);
        const event = res.body.event;
        assert.equal(event.streamId, streamAId);
        assert.deepEqual(event.streamIds, [streamAId, streamBId]);
      });

      it('[T5ZY] must allow trashing, if you have a contribute permission on at least 1 streamId', async function () {
        const res = await server.request()
          .delete(eventPath(eventIdAB))
          .set('Authorization', tokenContributeA);
        assert.equal(res.status, 200);
        const event = res.body.event;
        assert.equal(event.trashed, true);
      });

      it('[2G32] must allow deletion, if you have a contribute permission on at least 1 streamId', async function () {
        const res = await server.request()
          .delete(eventPath(trashedEventIdAB))
          .set('Authorization', tokenContributeA);
        assert.equal(res.status, 200);
        const deletion = res.body.eventDeletion;
        assert.equal(deletion.id, trashedEventIdAB);
      });

      it('[6W5Y] must forbid trashing, if you don\'t have a contribute permission on at least 1 streamId', async function () {
        const res = await server.request()
          .delete(eventPath(eventIdA))
          .set('Authorization', tokenContributeB);
        assert.equal(res.status, 403);
        const error = res.body.error;
        assert.equal(error.id, ErrorIds.Forbidden);
      });
    });

    describe('GET /events/:id/:fileId -- attachments', () => {
      let userId, streamId, event,
        appToken, appReadToken,
        sharedToken, sharedReadToken;

      beforeEach(() => {
        userId = cuid();
        streamId = cuid();
        appToken = cuid();
        sharedToken = cuid();
      });

      beforeEach(async () => {
        const user = await mongoFixtures.user(userId);
        await user.stream({
          id: streamId,
          name: streamId.toUpperCase()
        });
        await user.access({
          type: 'app',
          token: appToken,
          name: charlatan.Lorem.word(),
          permissions: [{
            streamId,
            level: 'manage'
          }]
        });
        await user.access({
          type: 'shared',
          token: sharedToken,
          name: charlatan.Lorem.word(),
          permissions: [{
            streamId,
            level: 'read'
          }]
        });
      });

      beforeEach(async () => {
        const res = await server.request()
          .post(path('events'))
          .set('Authorization', appToken)
          .field('event', JSON.stringify({
            streamId,
            type: 'picture/attached'
          }))
          .attach('file', fixturePath('somefile'));
        event = res.body.event;
        appReadToken = event.attachments[0].readToken;
        const res2 = await server.request()
          .get(path(`events/${event.id}`))
          .set('Authorization', sharedToken);
        event = res2.body.event;
        sharedReadToken = event.attachments[0].readToken;
      });

      function path (resource) {
        return `/${userId}/${resource}`;
      }

      it('[JNS8] should retrieve the attachment with the app token', async () => {
        const res = await server.request()
          .get(path(`events/${event.id}/${event.attachments[0].id}`))
          .set('Authorization', appToken);
        const status = res.status;
        assert.equal(status, 200);
        const retrievedAttachment = res.body;
        assert.exists(retrievedAttachment);
      });

      it('[6YFZ] should retrieve the attachment with the app token correct headers', async () => {
        const res = await server.request()
          .get(path(`events/${event.id}/${event.attachments[0].id}`))
          .set('Authorization', appToken);
        if (integrity.attachments.isActive) {
          assert.equal(res.headers.digest, 'SHA-256=' + event.attachments[0].integrity.split('-')[1]);
        }
        assert.equal(res.headers['content-disposition'], 'attachment; filename*=UTF-8\'\'' + event.attachments[0].fileName);
        assert.equal(res.headers['content-length'], event.attachments[0].size);
        assert.equal(res.headers['content-type'], event.attachments[0].type);
      });

      it('[NH1O] should retrieve the attachment with the shared access readToken', async () => {
        const res = await server.request()
          .get(path(`events/${event.id}/${event.attachments[0].id}?readToken=${appReadToken}`));
        const status = res.status;
        assert.equal(status, 200);
        const retrievedAttachment = res.body;
        assert.exists(retrievedAttachment);
      });
      it('[9KAF] should retrieve the attachment with the shared access token', async () => {
        const res = await server.request()
          .get(path(`events/${event.id}/${event.attachments[0].id}`))
          .set('Authorization', sharedToken);
        const status = res.status;
        assert.equal(status, 200);
        const retrievedAttachment = res.body;
        assert.exists(retrievedAttachment);
      });
      it('[9MEL] should retrieve the attachment with the shared access readToken', async () => {
        const res = await server.request()
          .get(path(`events/${event.id}/${event.attachments[0].id}?readToken=${sharedReadToken}`));
        const status = res.status;
        assert.equal(status, 200);
        const retrievedAttachment = res.body;
        assert.exists(retrievedAttachment);
      });
    });
  });

  describe('streams', function () {
    let server;
    before(async () => {
      server = await context.spawn();
    });
    after(() => {
      server.stop();
    });

    let mongoFixtures;
    before(async function () {
      mongoFixtures = databaseFixture(await produceMongoConnection());
    });

    let user,
      username,
      streamAId,
      streamBId,
      streamAxAId,
      streamAxAxAId,
      eventIdAxAandB,
      eventIdAandAxA,
      eventIdAxAandAxAxA,
      manageAccessToken,
      basePathEvent,
      basePathStream;

    beforeEach(async function () {
      username = cuid();
      streamAId = 'streamAId';
      streamBId = 'streamBId';
      streamAxAId = 'streamA_AId';
      streamAxAxAId = 'streamA_A_AId';
      eventIdAandAxA = cuid();
      eventIdAxAandB = cuid();
      eventIdAxAandAxAxA = cuid();
      manageAccessToken = cuid();
      basePathStream = `/${username}/streams/`;
      basePathEvent = `/${username}/events/`;

      user = await mongoFixtures.user(username, {});
      await user.stream({
        id: streamAId,
        name: 'streamA'
      });
      await user.stream({
        id: streamBId,
        name: 'streamB'
      });
      await user.stream({
        parentId: streamAId,
        id: streamAxAId,
        name: 'stream son of A'
      });
      await user.stream({
        parentId: streamAxAId,
        id: streamAxAxAId,
        name: 'stream son of son of A'
      });
      await user.access({
        type: 'app',
        token: manageAccessToken,
        permissions: [
          {
            streamId: '*',
            level: 'manage'
          }
        ]
      });
      await user.event({
        type: 'note/txt',
        time: (timestamp.now()) - 2,
        content: 'In B and Son of A',
        id: eventIdAxAandB,
        streamIds: [streamBId, streamAxAId]
      });
      await user.event({
        type: 'note/txt',
        time: (timestamp.now()) - 1,
        content: 'In A and Son of A',
        id: eventIdAandAxA,
        streamIds: [streamAId, streamAxAId]
      });
      await user.event({
        type: 'note/txt',
        time: (timestamp.now()),
        content: 'In Son of A and Son of Son of A',
        id: eventIdAxAandAxAxA,
        streamIds: [streamAxAId, streamAxAxAId]
      });
    });
    afterEach(async () => {
      await mongoFixtures.clean();
    });

    /**
     * Stream structure
     A          B
      \
       AA
        \
         AAA
     */

    function pathStreamId (streamId) {
      return basePathStream + streamId;
    }
    function pathEventId (eventId) {
      return basePathEvent + eventId;
    }

    describe('POST /streams', function () {
      it('[EGW2] must forbid setting the "singleActivity" field', async function () {
        const res = await server.request()
          .post(basePathStream)
          .set('Authorization', manageAccessToken)
          .send({
            name: 'something',
            singleActivity: true
          });
        assert.equal(res.status, 400);
      });
    });

    describe('PUT /streams/:id', function () {
      it('[EY79] must forbid setting the "singleActivity" field', async function () {
        const res = await server.request()
          .put(pathStreamId(streamAId))
          .set('Authorization', manageAccessToken)
          .send({
            singleActivity: true
          });
        assert.equal(res.status, 400);
      });
    });

    describe('DELETE /streams', function () {
      describe('When the stream\'s event is part of at least another stream outside of its descendants', function () {
        describe('when mergeEventsWithParent=false', function () {
          it('[TWDG] must not delete events, but remove the deleted streamId from their streamIds', async function () {
            for (let i = 0; i < 2; i++) {
              await server.request()
                .delete(pathStreamId(streamBId))
                .set('Authorization', manageAccessToken)
                .query({ mergeEventsWithParent: false });
            }
            const res = await server.request()
              .get(pathEventId(eventIdAxAandB))
              .set('Authorization', manageAccessToken);
            const event = res.body.event;
            assert.deepEqual(event.streamIds, [streamAxAId]);
          });
        });
      });

      describe('When the event is part of the stream and its children', function () {
        describe('when mergeEventsWithParent=false', function () {
          it('[6SBU] must delete the events', async function () {
            for (let i = 0; i < 2; i++) {
              await server.request()
                .delete(pathStreamId(streamAId))
                .set('Authorization', manageAccessToken)
                .query({ mergeEventsWithParent: false });
            }

            const res = await server.request()
              .get(basePathEvent)
              .set('Authorization', manageAccessToken)
              .query({ includeDeletions: true, modifiedSince: 0 });
            const deletions = res.body.eventDeletions;
            assert.exists(deletions, 'deleted events are not found');
            let foundAandAxA = false;
            let foundAxAandAxAxA = false;
            deletions.forEach(d => {
              if (d.id === eventIdAandAxA) foundAandAxA = true;
              if (d.id === eventIdAxAandAxAxA) foundAxAandAxAxA = true;
            });
            assert.isTrue(foundAandAxA);
            assert.isTrue(foundAxAandAxAxA);
          });
        });

        describe('when mergeEventsWithParent=true', function () {
          it('[2FRR] must not delete events, but remove all streamIds and add its parentId', async function () {
            for (let i = 0; i < 2; i++) {
              await server.request()
                .delete(basePathStream + streamAxAId)
                .set('Authorization', manageAccessToken)
                .query({ mergeEventsWithParent: true });
            }

            const res = await server.request()
              .get(basePathEvent)
              .set('Authorization', manageAccessToken);
            assert.equal(res.body.events.length, 3);

            let foundAandAxA = false;
            let foundAxAandAxAxA = false;
            let foundAxAandB = false;
            res.body.events.forEach(e => {
              if (e.id === eventIdAandAxA) {
                foundAandAxA = true;
                assert.deepEqual(e.streamIds, [streamAId]);
              }
              if (e.id === eventIdAxAandAxAxA) {
                foundAxAandAxAxA = true;
                assert.deepEqual(e.streamIds, [streamAId]);
              }
              if (e.id === eventIdAxAandB) {
                foundAxAandB = true;
                assert.isTrue(_.includes(e.streamIds, streamAId));
                assert.isTrue(_.includes(e.streamIds, streamBId));
              }
            });
            assert.isTrue(foundAandAxA);
            assert.isTrue(foundAxAandAxAxA);
            assert.isTrue(foundAxAandB);
          });
        });
      });
    });
  });
});
