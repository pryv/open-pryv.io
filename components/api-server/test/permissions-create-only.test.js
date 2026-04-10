/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, charlatan */

const path = require('path');

// Test attachment for upload tests
const attachmentPath = path.resolve(__dirname, '../../test-helpers/src/data/attachments/document.pdf');
const attachmentFilename = 'document.pdf';

const { getConfig } = require('@pryv/boiler');
let isAuditActive = true;

describe('[PCRO] permissions create-only level', () => {
  let mongoFixtures;
  before(async function () {
    await initTests();
    await initCore();
    mongoFixtures = getNewFixture();
    const config = await getConfig();
    isAuditActive = config.get('audit:active');
  });
  after(async () => {
    await mongoFixtures.clean();
  });

  let user,
    username,
    streamParentId,
    streamCreateOnlyId,
    streamOutId,
    readAccessId,
    readAccessToken,
    createOnlyToken,
    coWithReadParentToken,
    coWithContributeParentToken,
    masterToken,
    manageAccessToken,
    contributeAccessToken,
    createOnlyEventId,
    streamParentIdAndCreateOnlyEventId,
    eventOutId;

  before(() => {
    username = cuid();
    readAccessId = cuid();
    readAccessToken = cuid();
    createOnlyToken = cuid();
    coWithReadParentToken = cuid();
    coWithContributeParentToken = cuid();
    masterToken = cuid();
    manageAccessToken = cuid();
    contributeAccessToken = cuid();
    streamParentId = cuid();
    streamCreateOnlyId = cuid();
    streamOutId = cuid();
    createOnlyEventId = cuid();
    streamParentIdAndCreateOnlyEventId = cuid();
    eventOutId = cuid();
  });

  before(async () => {
    user = await mongoFixtures.user(username, {});
    const streamParent = await user.stream({
      id: streamParentId,
      name: 'Does not matter at all'
    });
    const streamCreateOnly = await user.stream({
      parentId: streamParentId,
      id: streamCreateOnlyId,
      name: 'Does not matter',
      singleActivity: true
    });
    const streamOut = await user.stream({
      id: streamOutId,
      name: 'Does not matter either'
    });
    await user.access({
      type: 'app',
      id: readAccessId,
      token: readAccessToken,
      permissions: [
        {
          streamId: streamCreateOnlyId,
          level: 'read'
        }
      ]
    });
    await user.access({
      type: 'app',
      token: createOnlyToken,
      permissions: [
        {
          streamId: streamCreateOnlyId,
          level: 'create-only'
        }
      ]
    });
    await user.access({
      type: 'app',
      token: coWithReadParentToken,
      permissions: [
        {
          streamId: streamCreateOnlyId,
          level: 'create-only'
        },
        {
          streamId: streamParentId,
          level: 'read'
        }
      ]
    });
    await user.access({
      type: 'app',
      token: coWithContributeParentToken,
      permissions: [
        {
          streamId: streamCreateOnlyId,
          level: 'create-only'
        },
        {
          streamId: streamParentId,
          level: 'contribute'
        }
      ]
    });
    await user.access({
      type: 'app',
      token: masterToken,
      permissions: [
        {
          streamId: '*',
          level: 'manage'
        }
      ]
    });
    await user.access({
      type: 'app',
      token: manageAccessToken,
      permissions: [
        {
          streamId: streamCreateOnlyId,
          level: 'manage'
        }
      ]
    });
    await user.access({
      type: 'app',
      token: contributeAccessToken,
      permissions: [
        {
          streamId: streamCreateOnlyId,
          level: 'contribute'
        }
      ]
    });
    await streamParent.event();
    await user.event({
      id: streamParentIdAndCreateOnlyEventId,
      streamIds: [streamParentId, streamCreateOnlyId]
    });
    await streamCreateOnly.event({
      id: createOnlyEventId,
      duration: null
    });
    await streamOut.event({
      id: eventOutId
    });
  });

  describe('[PC01] Permissions - create-only level', function () {
    let basePath;
    before(() => {
      basePath = `/${username}/accesses`;
    });

    function reqPath (id) {
      return `${basePath}/${id}`;
    }

    describe('[PC02] Accesses', function () {
      describe('[PC07] GET /', function () {
        describe('[PC08] when using an access with a "create-only" permissions', function () {
          let accesses;
          before(async function () {
            const res = await coreRequest
              .get(basePath)
              .set('Authorization', createOnlyToken);
            accesses = res.body.accesses;
          });
          it('[HOTO] should return an empty list', async function () {
            assert.ok(accesses);
            assert.strictEqual(accesses.length, 0);
          });
        });
      });

      describe('[PC09] POST /', function () {
        describe('[PC10] when using an access with a "create-only" permission', function () {
          it('[X4Z1] a masterToken should allow to create an access with a "create-only" permissions', async function () {
            const res = await coreRequest
              .post(basePath)
              .set('Authorization', masterToken)
              .send({
                type: 'shared',
                name: 'whatever',
                permissions: [{
                  streamId: streamCreateOnlyId,
                  level: 'create-only'
                }]
              });
            assert.strictEqual(res.status, 201);
            const access = res.body.access;
            assert.ok(access);
          });

          it('[ATCO] an appToken with managed rights should allow to create an access with a "create-only" permissions', async function () {
            const res = await coreRequest
              .post(basePath)
              .set('Authorization', manageAccessToken)
              .send({
                type: 'shared',
                name: 'whatever2nd',
                permissions: [{
                  streamId: streamCreateOnlyId,
                  level: 'create-only'
                }]
              });
            assert.strictEqual(res.status, 201);
            const access = res.body.access;
            assert.ok(access);
          });

          it('[ATCY] an appToken with managed rights should allow to create an access with a "create-only" permissions and selfRevoke forbidden', async function () {
            const res = await coreRequest
              .post(basePath)
              .set('Authorization', manageAccessToken)
              .send({
                type: 'shared',
                name: 'whatever2nd2nd',
                permissions: [{
                  streamId: streamCreateOnlyId,
                  level: 'create-only'
                }, {
                  feature: 'selfRevoke',
                  setting: 'forbidden'
                }]
              });
            assert.strictEqual(res.status, 201);
            const access = res.body.access;
            assert.ok(access);
          });

          it('[ATCR] an appToken with read rights should be forbidden to create an access with a "create-only" permissions', async function () {
            const res = await coreRequest
              .post(basePath)
              .set('Authorization', readAccessToken)
              .send({
                type: 'shared',
                name: 'whatever3rd',
                permissions: [{
                  streamId: streamCreateOnlyId,
                  level: 'create-only'
                }]
              });
            assert.strictEqual(res.status, 403);
            const error = res.body.error;
            assert.ok(error);
          });

          it('[ATCC] an appToken with contribute rights should be allowed to create an access with a "create-only" permissions', async function () {
            const res = await coreRequest
              .post(basePath)
              .set('Authorization', contributeAccessToken)
              .send({
                type: 'shared',
                name: 'whatever4th',
                permissions: [{
                  streamId: streamCreateOnlyId,
                  level: 'create-only'
                }]
              });
            assert.strictEqual(res.status, 201);
            const access = res.body.access;
            assert.ok(access);
          });

          it('[FEGI] a createOnlyToken should forbid to create an access with a "read" level permission permission', async function () {
            const res = await coreRequest
              .post(basePath)
              .set('Authorization', coWithContributeParentToken)
              .send({
                name: charlatan.App.name(),
                permissions: [
                  {
                    streamId: streamCreateOnlyId,
                    level: 'read'
                  }
                ]
              });
            const error = res.body.error;
            assert.ok(error);
            assert.strictEqual(res.status, 403);
            assert.ok(res.body.access == null);
          });
          it('[SL4P] should forbid to create an access with a "contribute" level permission', async function () {
            const res = await coreRequest
              .post(basePath)
              .set('Authorization', coWithContributeParentToken)
              .send({
                name: charlatan.App.name(),
                permissions: [
                  {
                    streamId: streamCreateOnlyId,
                    level: 'contribute'
                  }
                ]
              });
            const error = res.body.error;
            assert.ok(error);
            assert.strictEqual(res.status, 403);
            assert.ok(res.body.access == null);
          });
          it('[ZX1M] should forbid to create an access with a "manage" level permission', async function () {
            const res = await coreRequest
              .post(basePath)
              .set('Authorization', coWithContributeParentToken)
              .send({
                name: charlatan.App.name(),
                permissions: [
                  {
                    streamId: streamCreateOnlyId,
                    level: 'manage'
                  }
                ]
              });
            const error = res.body.error;
            assert.ok(error);
            assert.strictEqual(res.status, 403);
            assert.ok(res.body.access == null);
          });
        });
      });

      describe('[PC11] PUT /', function () {
        it('[1WXJ] should forbid updating accesses', async function () {
          const res = await coreRequest
            .put(reqPath(readAccessId))
            .set('Authorization', createOnlyToken)
            .send({
              clientData: {
                a: 'b'
              }
            });
          assert.strictEqual(res.status, 410);
        });
      });

      describe('[PC12] DELETE /', function () {
        it('[G6IP] should forbid deleting accesses', async function () {
          const res = await coreRequest
            .del(reqPath(readAccessId))
            .set('Authorization', createOnlyToken);
          assert.strictEqual(res.status, 403);
        });
      });
    });
  });

  describe('[PC03] Events', function () {
    let basePath;
    before(() => {
      basePath = `/${username}/events`;
    });

    function reqPath (id) {
      return `${basePath}/${id}`;
    }

    describe('[PC13] GET /', function () {
      it('[CKF3] should return an error list when fetching explicitly "create-only" streams', async function () {
        const query = {
          streams: [streamCreateOnlyId]
        };

        const res = await coreRequest
          .get(basePath)
          .set('Authorization', createOnlyToken)
          .query(query);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.error.id, 'forbidden');
      });

      it('[V4KJ] should not return events when fetching "create-only" streams that are children of "read" streams', async function () {
        const res = await coreRequest
          .get(basePath)
          .set('Authorization', coWithReadParentToken);
        const events = res.body.events;
        assert.strictEqual(events.length, 1);
        for (const event of events) {
          assert.ok(event.streamIds.includes(streamParentId), 'Should only include "readable" streamId');
        }
      });

      it('[SYRW] should not return events when fetching "create-only" streams that are children of "contribute" streams', async function () {
        const res = await coreRequest
          .get(basePath)
          .set('Authorization', coWithContributeParentToken);
        const events = res.body.events;
        assert.strictEqual(events.length, 1);
        for (const event of events) {
          assert.ok(event.streamIds.includes(streamParentId), 'Should only include "readable" streamId');
        }
      });
    });

    describe('[PC14] GET /:id', function () {
      it('[N61I] should forbid fetching an event when using a "create-only" permission', async function () {
        const res = await coreRequest
          .get(reqPath(createOnlyEventId))
          .set('Authorization', createOnlyToken);
        assert.strictEqual(res.status, 403); // recieve unexistant to avoid discovery
      });
    });

    describe('[PC15] POST /', function () {
      it('[0G8I] should forbid creating events for out of scope streams', async function () {
        const params = {
          type: 'test/test',
          streamIds: [streamOutId]
        };

        const res = await coreRequest
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .send(params);
        assert.strictEqual(res.status, 403);
      });

      it('[F406] should allow creating events for "create-only" streams', async function () {
        const params = {
          type: 'test/test',
          streamIds: [streamCreateOnlyId]
        };
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .send(params);
        assert.strictEqual(res.status, 201);
      });
    });

    describe('[PC16] PUT /', function () {
      it('[V0UO] should forbid updating events for "create-only" streams', async function () {
        const params = {
          content: 12
        };
        const res = await coreRequest
          .put(reqPath(createOnlyEventId))
          .set('Authorization', createOnlyToken)
          .send(params);
        assert.strictEqual(res.status, 403);
      });
      // skipping cases "... streams that are children of "read" streams" & "... streams that are children of "contribute" streams"
      // because they are covered by the GET above
    });

    describe('[PC17] DELETE /', function () {
      it('[5OUT] should forbid deleting events for "create-only" streams', async function () {
        const res = await coreRequest
          .del(reqPath(createOnlyEventId))
          .set('Authorization', createOnlyToken);
        assert.strictEqual(res.status, 403);
      });
      // skipping cases "... streams that are children of "read" streams" & "... streams that are children of "contribute" streams"
      // because they are covered by the GET above
    });

    describe('[PC04] attachments', function () {
      let eventId, fileId;
      before(async function () {
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .field('event', JSON.stringify({
            streamIds: [streamCreateOnlyId],
            type: 'picture/attached'
          }))
          .attach('document', attachmentPath, attachmentFilename);
        assert.strictEqual(res.status, 201);
        eventId = res.body.event.id;
        fileId = res.body.event.fileId;
      });

      // cleaning up explicitly as we are not using fixtures
      after(async function () {
        await coreRequest
          .delete(reqPath(eventId))
          .set('Authorization', masterToken);
        await coreRequest
          .delete(reqPath(eventId))
          .set('Authorization', masterToken);
      });
      // not covering addAttachment as it calls events.update

      describe('[PC18] GET /events/{id}/{fileId}[/{fileName}]', function () {
        it('[VTU4] should be forbidden', async function () {
          const res = await coreRequest
            .get(reqPath(eventId) + `/${fileId}`)
            .set('Authorization', createOnlyToken);
          assert.strictEqual(res.status, 403);
        });
      });

      describe('[PC19] POST /events/{id}', function () {
        it('[8J8O] should be forbidden', async function () {
          const res = await coreRequest
            .post(reqPath(eventId))
            .set('Authorization', createOnlyToken)
            .attach('document', attachmentPath, attachmentFilename + '-2');
          assert.strictEqual(res.status, 403);
        });
      });

      describe('[PC20] DELETE /events/{id}/{fileId}', function () {
        it('[GY6M] should be forbidden', async function () {
          const res = await coreRequest
            .delete(reqPath(eventId) + `/${fileId}`)
            .set('Authorization', createOnlyToken);
          assert.strictEqual(res.status, 403);
        });
      });
    });
  });

  describe('[PC05] Streams', function () {
    let basePath;
    before(() => {
      basePath = `/${username}/streams`;
    });

    function reqPath (id) {
      return `${basePath}/${id}`;
    }

    describe('[PC21] GET /', function () {
      it('[J12F] should only return streams for which permissions are defined', async function () {
        const res = await coreRequest
          .get(basePath)
          .set('Authorization', createOnlyToken)
          .query({ state: 'all' });
        const streams = res.body.streams;
        assert.strictEqual(streams.length, isAuditActive ? 2 : 1);
        const stream = streams[0];
        assert.strictEqual(stream.id, streamCreateOnlyId);
      });
    });

    describe('[PC22] POST /', function () {
      it('[TFWF] should forbid creating child streams in "create-only" streams', async function () {
        const data = {
          name: charlatan.Lorem.word(),
          parentId: streamCreateOnlyId
        };
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .send(data);
        assert.strictEqual(res.status, 403);
      });
    });

    describe('[PC23] PUT /', function () {
      it('[PCO8] should forbid updating "create-only" streams', async function () {
        const res = await coreRequest
          .put(reqPath(streamCreateOnlyId))
          .set('Authorization', createOnlyToken)
          .send({ name: charlatan.Lorem.word() });
        assert.strictEqual(res.status, 403);
      });
    });

    describe('[PC24] DELETE /', function () {
      it('[PCO9] should forbid deleting "create-only" streams', async function () {
        const res = await coreRequest
          .del(reqPath(streamCreateOnlyId))
          .set('Authorization', createOnlyToken);
        assert.strictEqual(res.status, 403);
      });
    });
  });

  describe('[PC06] Webhooks', function () {
    let basePath;
    before(function () {
      basePath = `/${username}/webhooks`;
    });

    describe('[PC25] CREATE /', function () {
      it('[3AE9] should allow creating webhooks', async function () {
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .send({
            url: charlatan.Internet.url()
          });
        assert.strictEqual(res.status, 201);
      });
    });

    // skipping GET, UPDATE & DELETE as they use the same code check.
  });
});
