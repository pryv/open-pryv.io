/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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

const cuid = require('cuid');
const chai = require('chai');
const assert = chai.assert;
const charlatan = require('charlatan');
const _ = require('lodash');

const helpers = require('./helpers');
const testData = helpers.data;
const settings = _.cloneDeep(helpers.dependencies.settings);

const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('./test-helpers');
const { getConfig } = require('@pryv/boiler');
let isAuditActive = true;

describe('permissions create-only level', () => {
  let mongoFixtures;
  before(async function () {
    mongoFixtures = databaseFixture(await produceMongoConnection());
    const config = await getConfig();
    isAuditActive = (!config.get('openSource:isActive')) && config.get('audit:active');
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

  let server;
  before(async () => {
    server = await context.spawn();
  });
  after(() => {
    server.stop();
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

  describe('Permissions - create-only level', function () {
    let basePath;
    before(() => {
      basePath = `/${username}/accesses`;
    });

    function reqPath (id) {
      return `${basePath}/${id}`;
    }

    describe('Accesses', function () {
      describe('GET /', function () {
        describe('when using an access with a "create-only" permissions', function () {
          let accesses;
          before(async function () {
            const res = await server.request()
              .get(basePath)
              .set('Authorization', createOnlyToken);
            accesses = res.body.accesses;
          });
          it('[HOTO] should return an empty list', async function () {
            assert.exists(accesses);
            assert.equal(accesses.length, 0);
          });
        });
      });

      describe('POST /', function () {
        describe('when using an access with a "create-only" permission', function () {
          it('[X4Z1] a masterToken should allow to create an access with a "create-only" permissions', async function () {
            const res = await server.request()
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
            assert.equal(res.status, 201);
            const access = res.body.access;
            assert.exists(access);
          });

          it('[ATCO] an appToken with managed rights should allow to create an access with a "create-only" permissions', async function () {
            const res = await server.request()
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
            assert.equal(res.status, 201);
            const access = res.body.access;
            assert.exists(access);
          });

          it('[ATCY] an appToken with managed rights should allow to create an access with a "create-only" permissions and selfRevoke forbidden', async function () {
            const res = await server.request()
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
            assert.equal(res.status, 201);
            const access = res.body.access;
            assert.exists(access);
          });

          it('[ATCR] an appToken with read rights should be forbidden to create an access with a "create-only" permissions', async function () {
            const res = await server.request()
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
            assert.equal(res.status, 403);
            const error = res.body.error;
            assert.exists(error);
          });

          it('[ATCC] an appToken with contribute rights should be allowed to create an access with a "create-only" permissions', async function () {
            const res = await server.request()
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
            assert.equal(res.status, 201);
            const access = res.body.access;
            assert.exists(access);
          });

          it('[FEGI] a createOnlyToken should forbid to create an access with a "read" level permission permission', async function () {
            const res = await server
              .request()
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
            assert.exists(error);
            assert.equal(res.status, 403);
            assert.notExists(res.body.access);
          });
          it('[SL4P] should forbid to create an access with a "contribute" level permission', async function () {
            const res = await server
              .request()
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
            assert.exists(error);
            assert.equal(res.status, 403);
            assert.notExists(res.body.access);
          });
          it('[ZX1M] should forbid to create an access with a "manage" level permission', async function () {
            const res = await server
              .request()
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
            assert.exists(error);
            assert.equal(res.status, 403);
            assert.notExists(res.body.access);
          });
        });
      });

      describe('PUT /', function () {
        it('[1WXJ] should forbid updating accesses', async function () {
          const res = await server.request()
            .put(reqPath(readAccessId))
            .set('Authorization', createOnlyToken)
            .send({
              clientData: {
                a: 'b'
              }
            });
          assert.equal(res.status, 410);
        });
      });

      describe('DELETE /', function () {
        it('[G6IP] should forbid deleting accesses', async function () {
          const res = await server.request()
            .del(reqPath(readAccessId))
            .set('Authorization', createOnlyToken);
          assert.equal(res.status, 403);
        });
      });
    });
  });

  describe('Events', function () {
    let basePath;
    before(() => {
      basePath = `/${username}/events`;
    });

    function reqPath (id) {
      return `${basePath}/${id}`;
    }

    describe('GET /', function () {
      it('[CKF3] should return an error list when fetching explicitly "create-only" streams', async function () {
        const query = {
          streams: [streamCreateOnlyId]
        };

        const res = await server
          .request()
          .get(basePath)
          .set('Authorization', createOnlyToken)
          .query(query);
        assert.equal(res.status, 403);
        assert.equal(res.body.error.id, 'forbidden');
      });

      it('[V4KJ] should not return events when fetching "create-only" streams that are children of "read" streams', async function () {
        const res = await server
          .request()
          .get(basePath)
          .set('Authorization', coWithReadParentToken);
        const events = res.body.events;
        assert.equal(events.length, 1);
        for (const event of events) {
          assert.include(event.streamIds, streamParentId, 'Should only include "readable" streamId');
        }
      });

      it('[SYRW] should not return events when fetching "create-only" streams that are children of "contribute" streams', async function () {
        const res = await server
          .request()
          .get(basePath)
          .set('Authorization', coWithContributeParentToken);
        const events = res.body.events;
        assert.equal(events.length, 1);
        for (const event of events) {
          assert.include(event.streamIds, streamParentId, 'Should only include "readable" streamId');
        }
      });
    });

    describe('GET /:id', function () {
      it('[N61I] should forbid fetching an event when using a "create-only" permission', async function () {
        const res = await server
          .request()
          .get(reqPath(createOnlyEventId))
          .set('Authorization', createOnlyToken);
        assert.equal(res.status, 403); // recieve unexistant to avoid discovery
      });
    });

    describe('POST /', function () {
      it('[0G8I] should forbid creating events for out of scope streams', async function () {
        const params = {
          type: 'test/test',
          streamId: streamOutId
        };

        const res = await server
          .request()
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .send(params);
        assert.equal(res.status, 403);
      });

      it('[F406] should allow creating events for "create-only" streams', async function () {
        const params = {
          type: 'test/test',
          streamId: streamCreateOnlyId
        };
        const res = await server
          .request()
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .send(params);
        assert.equal(res.status, 201);
      });
    });

    describe('PUT /', function () {
      it('[V0UO] should forbid updating events for "create-only" streams', async function () {
        const params = {
          content: 12
        };
        const res = await server
          .request()
          .put(reqPath(createOnlyEventId))
          .set('Authorization', createOnlyToken)
          .send(params);
        assert.equal(res.status, 403);
      });
      // skipping cases "... streams that are children of "read" streams" & "... streams that are children of "contribute" streams"
      // because they are covered by the GET above
    });

    describe('DELETE /', function () {
      it('[5OUT] should forbid deleting events for "create-only" streams', async function () {
        const res = await server
          .request()
          .del(reqPath(createOnlyEventId))
          .set('Authorization', createOnlyToken);
        assert.equal(res.status, 403);
      });
      // skipping cases "... streams that are children of "read" streams" & "... streams that are children of "contribute" streams"
      // because they are covered by the GET above
    });

    describe('attachments', function () {
      let eventId, fileId;
      before(async function () {
        const res = await server.request()
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .field('event', JSON.stringify({
            streamId: streamCreateOnlyId,
            type: 'picture/attached'
          }))
          .attach('document', testData.attachments.document.path,
            testData.attachments.document.filename);
        assert.equal(res.status, 201);
        eventId = res.body.event.id;
        fileId = res.body.event.fileId;
      });

      // cleaning up explicitly as we are not using fixtures
      after(async function () {
        await server.request()
          .delete(reqPath(eventId))
          .set('Authorization', masterToken);
        await server.request()
          .delete(reqPath(eventId))
          .set('Authorization', masterToken);
      });
      // not covering addAttachment as it calls events.update

      describe('GET /events/{id}/{fileId}[/{fileName}]', function () {
        it('[VTU4] should be forbidden', async function () {
          const res = await server
            .request()
            .get(reqPath(eventId) + `/${fileId}`)
            .set('Authorization', createOnlyToken);
          assert.equal(res.status, 403);
        });
      });

      describe('POST /events/{id}', function () {
        it('[8J8O] should be forbidden', async function () {
          const res = await server.request()
            .post(reqPath(eventId))
            .set('Authorization', createOnlyToken)
            .attach('document', testData.attachments.document.path,
              testData.attachments.document.filename + '-2');
          assert.equal(res.status, 403);
        });
      });

      describe('DELETE /events/{id}/{fileId}', function () {
        it('[GY6M] should be forbidden', async function () {
          const res = await server
            .request()
            .delete(reqPath(eventId) + `/${fileId}`)
            .set('Authorization', createOnlyToken);
          assert.equal(res.status, 403);
        });
      });
    });
  });

  describe('Streams', function () {
    let basePath;
    before(() => {
      basePath = `/${username}/streams`;
    });

    function reqPath (id) {
      return `${basePath}/${id}`;
    }

    describe('GET /', function () {
      it('[J12F] should only return streams for which permissions are defined', async function () {
        const res = await server
          .request()
          .get(basePath)
          .set('Authorization', createOnlyToken)
          .query({ state: 'all' });
        const streams = res.body.streams;
        assert.equal(streams.length, isAuditActive ? 2 : 1);
        const stream = streams[0];
        assert.equal(stream.id, streamCreateOnlyId);
      });
    });

    describe('POST /', function () {
      it('[TFWF] should forbid creating child streams in "create-only" streams', async function () {
        const data = {
          name: charlatan.Lorem.word(),
          parentId: streamCreateOnlyId
        };
        const res = await server
          .request()
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .send(data);
        assert.equal(res.status, 403);
      });
    });

    describe('PUT /', function () {
      it('[PCO8] should forbid updating "create-only" streams', async function () {
        const res = await server
          .request()
          .put(reqPath(streamCreateOnlyId))
          .set('Authorization', createOnlyToken)
          .send({ name: charlatan.Lorem.word() });
        assert.equal(res.status, 403);
      });
    });

    describe('DELETE /', function () {
      it('[PCO9] should forbid deleting "create-only" streams', async function () {
        const res = await server
          .request()
          .del(reqPath(streamCreateOnlyId))
          .set('Authorization', createOnlyToken);
        assert.equal(res.status, 403);
      });
    });
  });

  describe('Webhooks', function () {
    let basePath;
    before(function () {
      if (settings.openSource.isActive) this.skip();
      basePath = `/${username}/webhooks`;
    });

    describe('CREATE /', function () {
      it('[3AE9] should allow creating webhooks', async function () {
        const res = await server
          .request()
          .post(basePath)
          .set('Authorization', createOnlyToken)
          .send({
            url: charlatan.Internet.url()
          });
        assert.equal(res.status, 201);
      });
    });

    // skipping GET, UPDATE & DELETE as they use the same code check.
  });
});
