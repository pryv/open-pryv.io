/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, charlatan, _ */

const ErrorIds = require('errors').ErrorIds;
const { integrity } = require('business');
const timestamp = require('unix-timestamp');

const { fixturePath } = require('./unit/test-helper');

require('date-utils');

describe('[MSTR] events.streamIds', function () {
  describe('[MS01] events', function () {
    let mongoFixtures;
    before(async function () {
      await initTests();
      await initCore();
      mongoFixtures = getNewFixture();
    });
    after(async () => {
      await mongoFixtures.clean();
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

    describe('[MS02] GET /events', function () {
      it('[WJ0S] must return streamIds (if many)', async function () {
        const res = await coreRequest
          .get(basePathEvent)
          .set('Authorization', tokenContributeA);
        const events = res.body.events;
        events.forEach(e => {
          assert.ok(e.streamIds);
        });
      });
    });

    describe('[MS03] GET /events/:id', function () {
      it('[IJQZ] must return streamIds containing all stream IDs', async function () {
        const res = await coreRequest
          .get(eventPath(eventIdAB))
          .set('Authorization', tokenContributeAReadB);
        const event = res.body.event;
        assert.strictEqual(event.streamIds[0], streamAId);
        assert.deepStrictEqual(event.streamIds, [streamAId, streamBId]);
      });
    });

    describe('[MS04] POST /events', function () {
      describe('[MS06] when using "streamIds"', function () {
        it('[VXMG] must return streamIds containing all stream IDs', async function () {
          const res = await coreRequest
            .post(basePathEvent)
            .set('Authorization', tokenContributeAB)
            .send({
              streamIds: [streamAId, streamBId],
              type: 'count/generic',
              content: 12
            });
          assert.strictEqual(res.status, 201);
          const event = res.body.event;
          assert.strictEqual(event.streamIds[0], streamAId);
          assert.deepStrictEqual(event.streamIds, [streamAId, streamBId]);
        });

        it('[2QZF] must clean duplicate streamIds', async function () {
          const res = await coreRequest
            .post(basePathEvent)
            .set('Authorization', tokenContributeAB)
            .send({
              streamIds: [streamAId, streamBId, streamBId],
              type: 'count/generic',
              content: 12
            });
          assert.strictEqual(res.status, 201);
          const event = res.body.event;
          assert.deepStrictEqual(event.streamIds, [streamAId, streamBId]);
        });

        it('[NY0E] must forbid providing an unknown streamId', async function () {
          const unknownStreamId = 'does-not-exist';
          const res = await coreRequest
            .post(basePathEvent)
            .set('Authorization', tokenContributeA)
            .send({
              streamIds: [unknownStreamId],
              type: 'count/generic',
              content: 12
            });
          assert.strictEqual(res.status, 400);
          const err = res.body.error;
          assert.strictEqual(err.id, ErrorIds.UnknownReferencedResource);
          assert.deepStrictEqual(err.data, { streamIds: [unknownStreamId] });
        });

        it('[6Z2D] must forbid creating an event in multiple streams, if a contribute permission is missing on at least one stream', async function () {
          const res = await coreRequest
            .post(basePathEvent)
            .set('Authorization', tokenContributeA)
            .send({
              streamIds: [streamAId, streamBId],
              type: 'count/generic',
              content: 12
            });
          assert.strictEqual(res.status, 403);
          const err = res.body.error;
          assert.strictEqual(err.id, ErrorIds.Forbidden);
        });
      });
    });

    describe('[MS07] PUT /events/:id', function () {
      it('[BBBX] must return streamIds containing all stream IDs', async function () {
        const res = await coreRequest
          .put(eventPath(eventIdA))
          .set('Authorization', tokenContributeA)
          .send({
            content: 'Now I am updated, still in A though.'
          });
        assert.strictEqual(res.status, 200);
        const event = res.body.event;
        assert.strictEqual(event.streamIds[0], eventA.streamIds[0]);
        assert.deepStrictEqual(event.streamIds, eventA.streamIds);
      });

      it('[42KZ] must allow modification, if you have a contribute permission on at least 1 streamId', async function () {
        const res = await coreRequest
          .put(eventPath(eventIdAB))
          .set('Authorization', tokenContributeA)
          .send({
            content: 'Now I am updated, still in AB though.'
          });
        assert.strictEqual(res.status, 200);
      });

      describe('[MS08] when modifying streamIds', function () {
        it('[TQHG] must forbid providing an unknown streamId', async function () {
          const unknownStreamId = 'does-not-exist';
          const res = await coreRequest
            .put(eventPath(eventIdA))
            .set('Authorization', tokenContributeA)
            .send({
              streamIds: [unknownStreamId]
            });
          assert.strictEqual(res.status, 400);
          const err = res.body.error;
          assert.strictEqual(err.id, ErrorIds.UnknownReferencedResource);
          assert.deepStrictEqual(err.data, { streamIds: [unknownStreamId] });
        });

        it('[6Q8B] must allow streamId addition, if you have a contribute permission for it', async function () {
          const res = await coreRequest
            .put(eventPath(eventIdA))
            .set('Authorization', tokenContributeAB)
            .send({
              streamIds: [streamAId, streamBId]
            });
          assert.strictEqual(res.status, 200);
          const event = res.body.event;
          assert.strictEqual(event.streamIds[0], streamAId);
          assert.deepStrictEqual(event.streamIds, [streamAId, streamBId]);
        });

        it('[MFF7] must forbid streamId addition, if you don\'t have a contribute permission for it', async function () {
          const res = await coreRequest
            .put(eventPath(eventIdA))
            .set('Authorization', tokenContributeA)
            .send({
              streamIds: [streamAId, streamBId]
            });
          assert.strictEqual(res.status, 403);
          const err = res.body.error;
          assert.strictEqual(err.id, ErrorIds.Forbidden);
        });

        it('[83N6] must allow streamId deletion, if you have a contribute permission for it', async function () {
          const res = await coreRequest
            .put(eventPath(eventIdAB))
            .set('Authorization', tokenContributeAB)
            .send({
              streamIds: [streamAId]
            });
          assert.strictEqual(res.status, 200);
          const event = res.body.event;
          assert.deepStrictEqual(event.streamIds, [streamAId]);
        });

        it('[JLS5] must forbid streamId deletion, if you have read but no contribute permission for it', async function () {
          const res = await coreRequest
            .put(eventPath(eventIdAB))
            .set('Authorization', tokenContributeAReadB)
            .send({
              streamIds: [streamAId]
            });
          assert.strictEqual(res.status, 403);
          const error = res.body.error;
          assert.strictEqual(error.id, ErrorIds.Forbidden);
        });
      });
    });

    describe('[MS09] POST /event/start', function () {
      function path () {
        return basePathEvent + 'start';
      }

      it('[FOM3] must return a 410 (Gone)', async function () {
        const res = await coreRequest
          .post(path())
          .set('Authorization', tokenContributeA)
          .send({
            streamIds: [streamAId],
            type: 'activity/plain'
          });
        assert.strictEqual(res.status, 410);
        const error = res.body.error;
        assert.strictEqual(error.id, ErrorIds.Gone);
      });
    });

    describe('[MS10] POST /event/stop', function () {
      function path () {
        return basePathEvent + 'stop';
      }

      it('[BR33] must return a 410 (Gone)', async function () {
        const res = await coreRequest
          .post(path())
          .set('Authorization', tokenContributeA)
          .send({
            streamIds: [streamAId],
            type: 'activity/plain'
          });
        assert.strictEqual(res.status, 410);
        const error = res.body.error;
        assert.strictEqual(error.id, ErrorIds.Gone);
      });
    });

    describe('[MS11] DELETE /events/:id', function () {
      function eventPath (eventId) {
        return basePathEvent + eventId;
      }

      it('[BPL0] must return streamIds containing all stream IDs', async function () {
        const res = await coreRequest
          .delete(eventPath(eventIdAB))
          .set('Authorization', tokenContributeAB);
        assert.strictEqual(res.status, 200);
        const event = res.body.event;
        assert.strictEqual(event.streamIds[0], streamAId);
        assert.deepStrictEqual(event.streamIds, [streamAId, streamBId]);
      });

      it('[T5ZY] must allow trashing, if you have a contribute permission on at least 1 streamId', async function () {
        const res = await coreRequest
          .delete(eventPath(eventIdAB))
          .set('Authorization', tokenContributeA);
        assert.strictEqual(res.status, 200);
        const event = res.body.event;
        assert.strictEqual(event.trashed, true);
      });

      it('[2G32] must allow deletion, if you have a contribute permission on at least 1 streamId', async function () {
        const res = await coreRequest
          .delete(eventPath(trashedEventIdAB))
          .set('Authorization', tokenContributeA);
        assert.strictEqual(res.status, 200);
        const deletion = res.body.eventDeletion;
        assert.strictEqual(deletion.id, trashedEventIdAB);
      });

      it('[6W5Y] must forbid trashing, if you don\'t have a contribute permission on at least 1 streamId', async function () {
        const res = await coreRequest
          .delete(eventPath(eventIdA))
          .set('Authorization', tokenContributeB);
        assert.strictEqual(res.status, 403);
        const error = res.body.error;
        assert.strictEqual(error.id, ErrorIds.Forbidden);
      });
    });

    describe('[MS12] GET /events/:id/:fileId -- attachments', () => {
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
        const res = await coreRequest
          .post(path('events'))
          .set('Authorization', appToken)
          .field('event', JSON.stringify({
            streamIds: [streamId],
            type: 'picture/attached'
          }))
          .attach('file', fixturePath('somefile'));
        assert.strictEqual(res.status, 201,
          'Event creation with attachment failed: ' + JSON.stringify(res.body));
        event = res.body.event;
        appReadToken = event.attachments[0].readToken;
        const res2 = await coreRequest
          .get(path(`events/${event.id}`))
          .set('Authorization', sharedToken);
        assert.strictEqual(res2.status, 200,
          'Event retrieval with shared token failed: ' + JSON.stringify(res2.body));
        event = res2.body.event;
        sharedReadToken = event.attachments[0].readToken;
      });

      function path (resource) {
        return `/${userId}/${resource}`;
      }

      it('[JNS8] should retrieve the attachment with the app token', async () => {
        const res = await coreRequest
          .get(path(`events/${event.id}/${event.attachments[0].id}`))
          .set('Authorization', appToken);
        const status = res.status;
        assert.strictEqual(status, 200);
        const retrievedAttachment = res.body;
        assert.ok(retrievedAttachment);
      });

      it('[6YFZ] should retrieve the attachment with the app token correct headers', async () => {
        const res = await coreRequest
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
        const res = await coreRequest
          .get(path(`events/${event.id}/${event.attachments[0].id}?readToken=${appReadToken}`));
        const status = res.status;
        assert.strictEqual(status, 200);
        const retrievedAttachment = res.body;
        assert.ok(retrievedAttachment);
      });
      it('[9KAF] should retrieve the attachment with the shared access token', async () => {
        const res = await coreRequest
          .get(path(`events/${event.id}/${event.attachments[0].id}`))
          .set('Authorization', sharedToken);
        const status = res.status;
        assert.strictEqual(status, 200);
        const retrievedAttachment = res.body;
        assert.ok(retrievedAttachment);
      });
      it('[9MEL] should retrieve the attachment with the shared access readToken', async () => {
        const res = await coreRequest
          .get(path(`events/${event.id}/${event.attachments[0].id}?readToken=${sharedReadToken}`));
        const status = res.status;
        assert.strictEqual(status, 200);
        const retrievedAttachment = res.body;
        assert.ok(retrievedAttachment);
      });
    });
  });

  describe('[MS13] streams', function () {
    let mongoFixtures;
    before(async function () {
      await initTests();
      await initCore();
      mongoFixtures = getNewFixture();
    });
    after(async () => {
      await mongoFixtures.clean();
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

    describe('[MS14] POST /streams', function () {
      it('[EGW2] must forbid setting the "singleActivity" field', async function () {
        const res = await coreRequest
          .post(basePathStream)
          .set('Authorization', manageAccessToken)
          .send({
            name: 'something',
            singleActivity: true
          });
        assert.strictEqual(res.status, 400);
      });
    });

    describe('[MS15] PUT /streams/:id', function () {
      it('[EY79] must forbid setting the "singleActivity" field', async function () {
        const res = await coreRequest
          .put(pathStreamId(streamAId))
          .set('Authorization', manageAccessToken)
          .send({
            singleActivity: true
          });
        assert.strictEqual(res.status, 400);
      });
    });

    describe('[MS16] DELETE /streams', function () {
      describe('[MS17] When the stream\'s event is part of at least another stream outside of its descendants', function () {
        describe('[MS18] when mergeEventsWithParent=false', function () {
          it('[TWDG] must not delete events, but remove the deleted streamId from their streamIds', async function () {
            for (let i = 0; i < 2; i++) {
              await coreRequest
                .delete(pathStreamId(streamBId))
                .set('Authorization', manageAccessToken)
                .query({ mergeEventsWithParent: false });
            }
            const res = await coreRequest
              .get(pathEventId(eventIdAxAandB))
              .set('Authorization', manageAccessToken);
            const event = res.body.event;
            assert.deepStrictEqual(event.streamIds, [streamAxAId]);
          });
        });
      });

      describe('[MS19] When the event is part of the stream and its children', function () {
        describe('[MS20] when mergeEventsWithParent=false', function () {
          it('[6SBU] must delete the events', async function () {
            for (let i = 0; i < 2; i++) {
              await coreRequest
                .delete(pathStreamId(streamAId))
                .set('Authorization', manageAccessToken)
                .query({ mergeEventsWithParent: false });
            }

            const res = await coreRequest
              .get(basePathEvent)
              .set('Authorization', manageAccessToken)
              .query({ includeDeletions: true, modifiedSince: 0 });
            const deletions = res.body.eventDeletions;
            assert.ok(deletions, 'deleted events are not found');
            let foundAandAxA = false;
            let foundAxAandAxAxA = false;
            deletions.forEach(d => {
              if (d.id === eventIdAandAxA) foundAandAxA = true;
              if (d.id === eventIdAxAandAxAxA) foundAxAandAxAxA = true;
            });
            assert.strictEqual(foundAandAxA, true);
            assert.strictEqual(foundAxAandAxAxA, true);
          });
        });

        describe('[MS21] when mergeEventsWithParent=true', function () {
          it('[2FRR] must not delete events, but remove all streamIds and add its parentId', async function () {
            for (let i = 0; i < 2; i++) {
              await coreRequest
                .delete(basePathStream + streamAxAId)
                .set('Authorization', manageAccessToken)
                .query({ mergeEventsWithParent: true });
            }

            const res = await coreRequest
              .get(basePathEvent)
              .set('Authorization', manageAccessToken);
            assert.strictEqual(res.body.events.length, 3);

            let foundAandAxA = false;
            let foundAxAandAxAxA = false;
            let foundAxAandB = false;
            res.body.events.forEach(e => {
              if (e.id === eventIdAandAxA) {
                foundAandAxA = true;
                assert.deepStrictEqual(e.streamIds, [streamAId]);
              }
              if (e.id === eventIdAxAandAxAxA) {
                foundAxAandAxAxA = true;
                assert.deepStrictEqual(e.streamIds, [streamAId]);
              }
              if (e.id === eventIdAxAandB) {
                foundAxAandB = true;
                assert.strictEqual(_.includes(e.streamIds, streamAId), true);
                assert.strictEqual(_.includes(e.streamIds, streamBId), true);
              }
            });
            assert.strictEqual(foundAandAxA, true);
            assert.strictEqual(foundAxAandAxAxA, true);
            assert.strictEqual(foundAxAandB, true);
          });
        });
      });
    });
  });
});
