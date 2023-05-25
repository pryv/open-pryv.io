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
const nock = require('nock');
const path = require('path');
const assert = require('chai').assert;
const supertest = require('supertest');
const charlatan = require('charlatan');

const { getConfig } = require('@pryv/boiler');
const ErrorIds = require('errors').ErrorIds;
const ErrorMessages = require('errors/src/ErrorMessages');
const { getApplication } = require('api-server/src/application');

const { pubsub } = require('messages');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection } = require('api-server/test/test-helpers');

const { getMall } = require('mall');

describe('[FG5R] Events of system streams', () => {
  let config;
  let validation;
  let app;
  let request;
  let res;
  let mongoFixtures;
  let basePath;
  let access;
  let user;
  let serviceRegisterRequest;
  let scope;
  let isDnsLess;
  let mall;
  let eventData;

  async function getOneEvent (userId, streamId) {
    const events = await mall.events.get(userId, { streams: [{ any: [streamId] }] });
    if (events != null && events.length > 0) return events[0];
    return null;
  }

  async function createUser () {
    user = await mongoFixtures.user(charlatan.Lorem.characters(7), {
      insurancenumber: charlatan.Number.number(4),
      phoneNumber: charlatan.Lorem.characters(3)
    });
    basePath = '/' + user.attrs.username + '/events';
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    access = access.attrs;
    await user.session(access.token);
    return user;
  }

  /**
   * Create additional event
   * @param string streamId
   */
  async function createAdditionalEvent (streamId) {
    const eventDataForadditionalEvent = {
      streamIds: [streamId],
      content: charlatan.Lorem.characters(7),
      type: 'string/pryv'
    };
    return await request.post(basePath)
      .send(eventDataForadditionalEvent)
      .set('authorization', access.token);
  }

  async function createAdditionalEventAndupdateMainOne (streamId) {
    eventData = {
      streamIds: [streamId, SystemStreamsSerializer.options.STREAM_ID_ACTIVE],
      content: charlatan.Lorem.characters(7),
      type: 'string/pryv'
    };

    const initialEvent = await getOneEvent(user.attrs.id, streamId);

    // create an additional event
    await createAdditionalEvent(streamId);

    const response = await request.put(path.join(basePath, initialEvent.id))
      .send(eventData)
      .set('authorization', access.token);
    return response;
  }

  before(async function () {
    config = await getConfig();
    config.injectTestConfig({ testsSkipForwardToRegister: false });
    isDnsLess = config.get('dnsLess:isActive');
    const helpers = require('api-server/test/helpers');
    validation = helpers.validation;
    mongoFixtures = databaseFixture(await produceMongoConnection());

    app = getApplication(true);
    await app.initiate();

    // Initialize notifications dependency

    const axonMsgs = [];
    const axonSocket = {
      emit: (...args) => axonMsgs.push(args)
    };
    pubsub.setTestNotifier(axonSocket);

    pubsub.status.emit(pubsub.SERVER_READY);
    await require('api-server/src/methods/events')(app.api);

    request = supertest(app.expressApp);

    mall = await getMall();
  });

  after(async function () {
    config.injectTestConfig({});
  });

  describe('GET /events', () => {
    describe('When using a personal access', () => {
      before(async function () {
        await createUser();
        res = await request.get(basePath).set('authorization', access.token);
      });
      it('[KS6K] should return visible system events only', () => {
        const separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
        const accountStreams = Object.keys(SystemStreamsSerializer.getReadableAccountMapForTests());
        assert.equal(separatedEvents.accountStreamsEvents.length, accountStreams.length);
        accountStreams.forEach(accountStreamId => {
          let found = false;
          separatedEvents.accountStreamsEvents.forEach(event => {
            if (event.streamId === accountStreamId) found = true;
          });
          assert.isTrue(found);
        });
      });
    });
    describe('When using a shared access with a read-level permission on the .account stream', () => {
      let separatedEvents;
      before(async function () {
        await createUser();
        const sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: SystemStreamsSerializer.addPrivatePrefixToStreamId('account'),
            level: 'read'
          }]
        });
        res = await request.get(basePath).set('authorization', sharedAccess.attrs.token);
        // lets separate core events from all other events and validate them separatelly
        separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
      });

      it('[DRFH] should return visible system events only', () => {
        const accountStreams = Object.keys(SystemStreamsSerializer.getReadableAccountMapForTests());
        assert.equal(separatedEvents.accountStreamsEvents.length, accountStreams.length);
        accountStreams.forEach(accountStreamId => {
          let found = false;
          separatedEvents.accountStreamsEvents.forEach(event => {
            if (event.streamId === accountStreamId) found = true;
          });
          assert.isTrue(found);
        });
      });
    });

    describe('When using a shared access with a read-level permission on all streams (star) and a visible system stream', () => {
      let sharedAccess;
      let systemStreamId;
      before(async function () {
        systemStreamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
        await createUser();
        sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'read'
          },
          {
            streamId: systemStreamId,
            level: 'read'
          }]
        });
      });

      it('[GF3A] should return only the account event for which a permission was explicitely provided', async () => {
        res = await request.get(basePath).query({ streams: [SystemStreamsSerializer.addCustomerPrefixToStreamId('email')] }).set('authorization', sharedAccess.attrs.token);
        assert.equal(res.body.events.length, 1);
        assert.isTrue(res.body.events[0].streamIds.includes(systemStreamId));
      });
    });

    describe('When using a shared access with a read-level permission on all streams (star)', () => {
      let sharedAccess;
      before(async function () {
        await createUser();
        sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'read'
          }]
        });
        res = await request.get(basePath).set('authorization', sharedAccess.attrs.token);
      });

      it('[RM74] should not return any system events', () => {
        assert.equal(res.body.events.length, 0);
      });
    });
  });

  describe('GET /events/<id>', () => {
    async function findDefaultCoreEvent (streamId) {
      return await getOneEvent(user.attrs.id, streamId);
    }
    describe('When using a personal access', () => {
      describe('to retrieve a visible system event', () => {
        let defaultEvent;
        const streamId = 'language';
        let systemStreamId;
        before(async function () {
          systemStreamId = SystemStreamsSerializer.addPrivatePrefixToStreamId(streamId);
          await createUser();
          defaultEvent = await findDefaultCoreEvent(systemStreamId);
          res = await request.get(path.join(basePath, defaultEvent.id)).set('authorization', access.token);
        });
        it('[9IEX] should return 200', () => {
          assert.equal(res.status, 200);
        });
        it('[IYE6] should return the event', () => {
          assert.equal(res.body.event.id, defaultEvent.id);
          assert.equal(res.body.event.streamId, systemStreamId);
        });
      });
      describe('to retrieve a non visible system event', () => {
        before(async function () {
          await createUser();
          const defaultEvent = await findDefaultCoreEvent(SystemStreamsSerializer.addPrivatePrefixToStreamId('invitationToken'));
          res = await request.get(path.join(basePath, defaultEvent.id)).set('authorization', access.token);
        });
        it('[Y2OA] should return 403', () => {
          assert.equal(res.status, 403);
        });

        it('[DHZE] should return the right error message', () => {
          assert.equal(res.body.error.id, ErrorIds.Forbidden);
        });
      });
    });

    describe('When using a shared access with a read-level permission on all streams (star) and a visible system stream', () => {
      let defaultEvent;
      let systemStreamId;
      before(async () => {
        systemStreamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('language');
        await createUser();
        const sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'read'
          },
          {
            streamId: systemStreamId,
            level: 'read'
          }]
        });

        defaultEvent = await findDefaultCoreEvent(systemStreamId);
        res = await request.get(path.join(basePath, defaultEvent.id))
          .set('authorization', sharedAccess.attrs.token);
      });
      it('[YPZX] should return 200', () => {
        assert.equal(res.status, 200);
      });
      it('[1NRM] should return the event', () => {
        assert.exists(res.body.event);
        assert.isTrue(res.body.event.streamIds.includes(systemStreamId));
      });
    });
  });

  describe('POST /events', () => {
    let eventData;
    describe('When using a personal access', () => {
      describe('to create an editable system event', () => {
        describe('which is non indexed and non unique', () => {
          before(async function () {
            await createUser();
            eventData = {
              streamIds: [SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber')],
              content: charlatan.Lorem.characters(7),
              type: 'string/pryv'
            };

            res = await request.post(basePath)
              .send(eventData)
              .set('authorization', access.token);
          });
          it('[F308] should return 201', () => {
            assert.equal(res.status, 201);
          });
          it('[9C2D] should return the created event', () => {
            assert.equal(res.body.event.content, eventData.content);
            assert.equal(res.body.event.type, eventData.type);
            assert.deepEqual(res.body.event.streamIds, [SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'), SystemStreamsSerializer.options.STREAM_ID_ACTIVE]);
          });
          it('[A9DC] should add the ‘active’ streamId to the new event which should be removed from other events of the same stream', async () => {
            assert.equal(res.body.event.streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_ACTIVE), true);

            const allEvents = await mall.events.get(user.attrs.id,
              { streams: [{ any: [SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber')] }] });

            assert.equal(allEvents.length, 2);
            // check the order
            assert.deepEqual(allEvents[0].id, res.body.event.id);
            // verify streamIds
            assert.deepEqual(allEvents[0].streamIds, [SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'), SystemStreamsSerializer.options.STREAM_ID_ACTIVE]);
            assert.deepEqual(allEvents[1].streamIds, [SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber')]);
          });
        });
        describe('which is indexed', function () {
          describe('when the new value is valid', () => {
            before(async function () {
              await createUser();
              eventData = {
                streamIds: [SystemStreamsSerializer.addPrivatePrefixToStreamId('language')],
                content: charlatan.Lorem.characters(7),
                type: 'string/pryv'
              };

              nock.cleanAll();
              scope = nock(config.get('services:register:url'));
              scope.put('/users',
                (body) => {
                  serviceRegisterRequest = body;
                  return true;
                }).reply(200, { errors: [] });

              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
            });

            it('[8C80] should return 201', () => {
              assert.equal(res.status, 201);
            });
            it('[67F7] should return the created event', () => {
              assert.equal(res.body.event.content, eventData.content);
              assert.equal(res.body.event.type, eventData.type);
              assert.deepEqual(res.body.event.streamIds, [SystemStreamsSerializer.addPrivatePrefixToStreamId('language'), SystemStreamsSerializer.options.STREAM_ID_ACTIVE]);
            });
            it('[467D] should add the ‘active’ streamId to the new event which should be removed from other events of the same stream', async () => {
              const allEvents = await mall.events.get(user.attrs.id,
                { streams: [{ any: [SystemStreamsSerializer.addPrivatePrefixToStreamId('language')] }] });

              assert.equal(allEvents[0].streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_ACTIVE), true);
              assert.equal(allEvents[0].streamIds.includes(SystemStreamsSerializer.addPrivatePrefixToStreamId('language')), true);
              assert.equal(allEvents[1].streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_ACTIVE), false);
              assert.equal(allEvents[1].streamIds.includes(SystemStreamsSerializer.addPrivatePrefixToStreamId('language')), true);
            });
            it('[199D] should notify register with the new data', function () {
              if (isDnsLess) this.skip();
              assert.equal(scope.isDone(), true);

              assert.deepEqual(serviceRegisterRequest, {
                username: user.attrs.username,
                user: {
                  language: [{
                    value: eventData.content,
                    isUnique: false,
                    isActive: true,
                    creation: true
                  }]
                },
                fieldsToDelete: {}
              });
            });
          });

          describe('when the new value is invalid', () => {
            before(async function () {
              await createUser();
              eventData = {
                streamIds: [SystemStreamsSerializer.addPrivatePrefixToStreamId('language')],
                content: [charlatan.Lorem.characters(7)],
                type: 'string/pryv'
              };

              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
            });

            it('[PQHR] should return 400', () => {
              assert.equal(res.status, 400);
            });
          });
        });
        describe('which is indexed and unique', () => {
          describe('[WCIU] whose content is unique', () => {
            let allEventsInDb;
            let streamId;
            let newEventFromDB;
            let oldEventFromDB;
            before(async function () {
              streamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
              await createUser();
              eventData = {
                streamIds: [streamId],
                content: charlatan.Lorem.characters(7),
                type: 'string/pryv'
              };

              nock.cleanAll();
              scope = nock(config.get('services:register:url'));
              scope.put('/users',
                (body) => {
                  serviceRegisterRequest = body;
                  return true;
                }).reply(200, { errors: [] });

              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
              allEventsInDb = await mall.events.get(user.attrs.id, { streams: [{ any: [streamId] }], state: 'all' });
              newEventFromDB = allEventsInDb.find(event => event.id === res.body.event.id);
              oldEventFromDB = allEventsInDb.find(event => event.id !== res.body.event.id);
            });
            it('[SQZ2] should return 201', () => {
              assert.equal(res.status, 201);
            });
            it('[YS79] should return the created event', () => {
              assert.equal(res.body.event.content, eventData.content);
              assert.equal(res.body.event.type, eventData.type);
            });
            it('[DA23] should add the ‘active’ streamId to the new event which should be removed from other events of the same stream', async () => {
              assert.deepEqual(res.body.event.streamIds, [streamId, SystemStreamsSerializer.options.STREAM_ID_ACTIVE, SystemStreamsSerializer.options.STREAM_ID_UNIQUE]);
              assert.deepEqual(oldEventFromDB.streamIds, [streamId, SystemStreamsSerializer.options.STREAM_ID_UNIQUE]);
              // check that second event is our new event and that it contains active streamId
              assert.deepEqual(newEventFromDB.id, res.body.event.id);
              assert.deepEqual(newEventFromDB.streamIds, [streamId, SystemStreamsSerializer.options.STREAM_ID_ACTIVE, SystemStreamsSerializer.options.STREAM_ID_UNIQUE]);
            });
            it('[D316] should notify register with the new data', function () {
              if (isDnsLess) this.skip();
              assert.equal(scope.isDone(), true);

              assert.deepEqual(serviceRegisterRequest, {
                username: user.attrs.username,
                user: {
                  email: [{
                    value: eventData.content,
                    isUnique: true,
                    isActive: true,
                    creation: true
                  }]
                },
                fieldsToDelete: {}
              });
            });
          });
          describe('whose content is already taken in register', () => {
            before(async function () {
              if (isDnsLess) this.skip();
              await createUser();
              eventData = {
                streamIds: [SystemStreamsSerializer.addCustomerPrefixToStreamId('email')],
                content: charlatan.Lorem.characters(7),
                type: 'string/pryv'
              };

              nock.cleanAll();
              nock(config.get('services:register:url')).put('/users')
                .reply(409, {
                  error: {
                    id: ErrorIds.ItemAlreadyExists,
                    data: {
                      email: eventData.content
                    }
                  }
                });

              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
            });

            it('[89BC] should return 409', () => {
              assert.equal(res.status, 409);
            });
            it('[10BC] should return the correct error', () => {
              assert.equal(res.body.error.id, ErrorIds.ItemAlreadyExists);
              assert.deepEqual(res.body.error.data, { email: eventData.content });
            });
          });
          describe('[6B8D] When creating an event that is already taken only on core', () => {
            // simulating dnsLess behaviour for non-unique event error
            let streamId;
            const email = charlatan.Internet.email();
            before(async function () {
              streamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
              await createUser();
              eventData = {
                streamIds: [streamId],
                content: email,
                type: 'string/pryv'
              };

              nock.cleanAll();
              nock(config.get('services:register:url')).put('/users',
                (body) => {
                  serviceRegisterRequest = body;
                  return true;
                }).times(2).reply(200, { errors: [] });

              await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
            });

            it('[2021] should return a 409 error', () => {
              assert.equal(res.status, 409);
            });
            it('[121E] should return the correct error', () => {
              assert.equal(res.body.error.id, ErrorIds.ItemAlreadyExists);
              assert.deepEqual(res.body.error.data, { email });
            });
          });
        });
      });

      describe('to create a non editable system event', () => {
        before(async () => {
          await createUser();
          eventData = {
            streamIds: [':_system:dbDocuments'],
            content: charlatan.Lorem.characters(7),
            type: 'password-hash/string'
          };

          res = await request.post(basePath)
            .send(eventData)
            .set('authorization', access.token);
        });
        it('[6CE0] should return a 400 error', () => {
          assert.equal(res.status, 400);
        });
        it('[90E6] should return the correct error', () => {
          assert.equal(res.body.error.id, ErrorIds.InvalidOperation);
          assert.deepEqual(res.body.error.data, { streamId: ':_system:dbDocuments' });
          assert.equal(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenAccountEventModification]);
        });
      });
    });

    describe('when using a shared access with a contribute-level permission on a system stream', () => {
      let sharedAccess;
      const streamId = 'email';
      let systemStreamId;
      before(async function () {
        systemStreamId = SystemStreamsSerializer.addCustomerPrefixToStreamId(streamId);
        const user2 = await createUser();
        sharedAccess = await user2.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: systemStreamId,
            level: 'contribute'
          }]
        });

        nock.cleanAll();
        scope = nock(config.get('services:register:url'));
        scope.put('/users',
          (body) => {
            serviceRegisterRequest = body;
            return true;
          }).reply(200, { errors: [] });

        eventData = {
          streamIds: [systemStreamId],
          content: charlatan.Lorem.characters(7),
          type: 'string/pryv'
        };

        res = await request.post(basePath)
          .send(eventData)
          .set('authorization', sharedAccess.attrs.token);
      });

      it('[X49R] should return 201', () => {
        assert.equal(res.status, 201);
      });
      it('[764A] should return the created event', () => {
        assert.equal(res.body.event.createdBy, sharedAccess.attrs.id);
        assert.deepEqual(res.body.event.streamIds, [systemStreamId, SystemStreamsSerializer.options.STREAM_ID_ACTIVE, SystemStreamsSerializer.options.STREAM_ID_UNIQUE]);
      });
      it('[765A] should notify register with the new data', function () {
        if (isDnsLess) this.skip();
        assert.equal(scope.isDone(), true);
        assert.deepEqual(serviceRegisterRequest, {
          username: user.attrs.username,
          user: {
            [streamId]: [{
              value: res.body.event.content,
              isUnique: true,
              isActive: true,
              creation: true
            }]
          },
          fieldsToDelete: {}
        });
      });
    });

    describe('when using a shared access with a manage-level permission on all streams (star)', () => {
      let sharedAccess;
      let systemStreamId;
      before(async function () {
        systemStreamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
        await createUser();
        sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'manage'
          }]
        });

        eventData = {
          streamIds: [systemStreamId],
          content: charlatan.Lorem.characters(7),
          type: 'string/pryv'
        };

        res = await request.post(basePath)
          .send(eventData)
          .set('authorization', sharedAccess.attrs.token);
      });

      it('[YX07] should return 403', () => {
        assert.equal(res.status, 403);
      });
      it('[YYU1] should return correct error id', () => {
        assert.equal(res.body.error.id, ErrorIds.Forbidden);
      });
    });
  });

  describe('PUT /events/<id>', () => {
    describe('when using a personal access', () => {
      describe('to update an editable system event', () => {
        let scope;
        let serviceRegisterRequest;
        async function editEvent (streamId, isFaulty = false) {
          eventData = {
            streamIds: [streamId, SystemStreamsSerializer.options.STREAM_ID_ACTIVE],
            content: isFaulty ? { someProp: 123 } : charlatan.Lorem.characters(7),
            type: 'string/pryv'
          };
          const initialEvent = await getOneEvent(user.attrs.id, streamId);

          res = await request.put(path.join(basePath, initialEvent.id))
            .send(eventData)
            .set('authorization', access.token);
          return res;
        }

        describe('which is non indexed and non unique', () => {
          before(async function () {
            await createUser();
            eventData = {
              content: charlatan.Lorem.characters(7),
              type: 'string/pryv'
            };
            const initialEvent = await getOneEvent(user.attrs.id, SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'));

            res = await request.put(path.join(basePath, initialEvent.id))
              .send(eventData)
              .set('authorization', access.token);
          });
          it('[2FA2] should return 200', () => {
            assert.equal(res.status, 200);
          });
          it('[763A] should return the updated event', () => {
            assert.equal(res.body.event.content, eventData.content);
            assert.equal(res.body.event.type, eventData.type);
            assert.deepEqual(res.body.event.streamIds, [
              SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'),
              SystemStreamsSerializer.options.STREAM_ID_ACTIVE]);
          });

          describe('by adding the “active” streamId', () => {
            let streamId;
            before(async function () {
              streamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber');
              await createUser();
              res = await createAdditionalEventAndupdateMainOne(streamId);
            });
            it('[562A] should return 200', () => {
              assert.equal(res.status, 200);
            });
            it('[5622] should return the updated event', () => {
              assert.equal(res.body.event.content, eventData.content);
              assert.equal(res.body.event.type, eventData.type);
              assert.deepEqual(res.body.event.streamIds, [streamId, SystemStreamsSerializer.options.STREAM_ID_ACTIVE]);
            });
            it('[CF70] should remove the "active" streamId for events of the same stream', async () => {
              const allEvents = await mall.events.get(user.attrs.id, { streams: [{ any: [streamId] }] });

              assert.equal(allEvents.length, 2);
              // check the order
              assert.deepEqual(allEvents[1].id, res.body.event.id);
              // verify streamIds
              assert.deepEqual(allEvents[0].streamIds, [streamId]);
              assert.deepEqual(allEvents[1].streamIds, [streamId, SystemStreamsSerializer.options.STREAM_ID_ACTIVE]);
            });
          });
          describe('by changing its steamIds', () => {
            describe('when editing with 2 streamIds at the time', () => {
              let streamIds;
              before(async function () {
                streamIds = [
                  SystemStreamsSerializer.addCustomerPrefixToStreamId('email'),
                  SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber')
                ];
                await createUser();
                eventData = {
                  streamIds,
                  content: charlatan.Lorem.characters(7),
                  type: 'string/pryv'
                };
                const initialEvent = await getOneEvent(user.attrs.id, SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'));
                res = await request.put(path.join(basePath, initialEvent.id))
                  .send(eventData)
                  .set('authorization', access.token);
              });
              it('[8BFK] should return 400', () => {
                assert.equal(res.status, 400);
              });
              it('[E3KE] should return the correct error', () => {
                assert.equal(res.body.error.id, ErrorIds.InvalidOperation);
                assert.equal(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenMultipleAccountStreams]);
                assert.includeMembers(res.body.error.data.streamIds, streamIds);
              });
            });
            describe('when substituting a system stream with another one', () => {
              before(async function () {
                await createUser();
                eventData = {
                  streamIds: [SystemStreamsSerializer.addCustomerPrefixToStreamId('email')],
                  content: charlatan.Lorem.characters(7),
                  type: 'string/pryv'
                };
                const initialEvent = await await getOneEvent(user.attrs.id, SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'));

                res = await request.put(path.join(basePath, initialEvent.id))
                  .send(eventData)
                  .set('authorization', access.token);
              });
              it('[9004] should return 400', () => {
                assert.equal(res.status, 400);
              });
              it('[E3AE] should return the correct error', () => {
                assert.equal(res.body.error.id, ErrorIds.InvalidOperation);
                assert.equal(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenToChangeAccountStreamId]);
              });
            });
          });
        });

        describe('which is indexed', function () {
          before(function () {
            if (isDnsLess) this.skip();
          });
          describe('as register is working', () => {
            describe('when the new value is valid', () => {
              const streamId = 'language';
              let systemStreamId;
              before(async function () {
                systemStreamId = SystemStreamsSerializer.addPrivatePrefixToStreamId(streamId);
                await createUser();
                nock.cleanAll();
                scope = nock(config.get('services:register:url'));
                scope.put('/users',
                  (body) => {
                    serviceRegisterRequest = body;
                    return true;
                  }).reply(200, { errors: [] });
                await editEvent(systemStreamId);
              });
              it('[0RUK] should return 200', () => {
                assert.equal(res.status, 200);
              });
              it('[E43M] should notify register with the updated data', () => {
                assert.equal(scope.isDone(), true);

                assert.deepEqual(serviceRegisterRequest, {
                  username: user.attrs.username,
                  user: {
                    [streamId]: [{
                      value: eventData.content,
                      isUnique: false,
                      isActive: true,
                      creation: false
                    }]
                  },
                  fieldsToDelete: {}
                });
              });
              describe('by adding the “active” streamId', () => {
                before(async function () {
                  await createUser();
                  const streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('language');
                  nock.cleanAll();
                  scope = nock(config.get('services:register:url'));
                  scope.put('/users',
                    (body) => {
                      serviceRegisterRequest = body;
                      return true;
                    }).times(2).reply(200, { errors: [] });
                  res = await createAdditionalEventAndupdateMainOne(streamId);
                });
                it('[0D18] should notify register with the updated data', () => {
                  assert.equal(scope.isDone(), true);
                  assert.deepEqual(serviceRegisterRequest, {
                    username: user.attrs.username,
                    user: {
                      language: [{
                        value: eventData.content,
                        isUnique: false,
                        isActive: true,
                        creation: false
                      }]
                    },
                    fieldsToDelete: {}
                  });
                });
              });
            });
            describe('when the new value is invalid', () => {
              const streamId = 'language';
              let systemStreamId;
              before(async function () {
                systemStreamId = SystemStreamsSerializer.addPrivatePrefixToStreamId(streamId);
                await createUser();
                await editEvent(systemStreamId, true);
              });
              it('[RDZF] should return 400', () => {
                assert.equal(res.status, 400);
              });
            });
          });
          describe('as register is out', () => {
            const streamId = 'language';
            let systemStreamId;
            before(async function () {
              systemStreamId = SystemStreamsSerializer.addPrivatePrefixToStreamId(streamId);
              await createUser();
              nock.cleanAll();
              scope = nock(config.get('services:register:url'));
              scope.put('/users',
                (body) => {
                  serviceRegisterRequest = body;
                  return true;
                }).replyWithError({
                message: 'something awful happened',
                code: '500'
              });
              await editEvent(systemStreamId);
            });
            it('[AA92] should return 500', () => {
              assert.equal(res.status, 500);
            });
            it('[645C] should notify register with the updated data', () => {
              assert.equal(scope.isDone(), true);
              assert.deepEqual(serviceRegisterRequest, {
                username: user.attrs.username,
                user: {
                  [streamId]: [{
                    value: eventData.content,
                    isUnique: false,
                    isActive: true,
                    creation: false
                  }]
                },
                fieldsToDelete: {}
              });
            });
          });
        });

        describe('which is unique', () => {
          describe('by updating a unique field that is valid', () => {
            const streamId = 'email';
            let systemStreamId;
            before(async function () {
              systemStreamId = SystemStreamsSerializer.addCustomerPrefixToStreamId(streamId);
              await createUser();
              scope = nock(config.get('services:register:url'));
              scope.put('/users',
                (body) => {
                  serviceRegisterRequest = body;
                  return true;
                }).reply(200, { errors: [] });
              await editEvent(systemStreamId);
            });
            it('[4BB1] should return 200', () => {
              assert.equal(res.status, 200);
            });
            it('[GWHU] should send a request to service-register to update the unique field', function () {
              if (isDnsLess) this.skip();
              assert.equal(scope.isDone(), true);
              assert.deepEqual(serviceRegisterRequest, {
                username: user.attrs.username,
                user: {
                  email: [{
                    value: eventData.content,
                    isUnique: true,
                    isActive: true,
                    creation: false
                  }]
                },
                fieldsToDelete: {}
              });
            });
            describe('by adding the “active” streamId', () => {
              before(async () => {
                await createUser();
                const streamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
                nock.cleanAll();
                scope = nock(config.get('services:register:url'));
                scope.put('/users',
                  (body) => {
                    serviceRegisterRequest = body;
                    return true;
                  }).times(2).reply(200, { errors: [] });
                res = await createAdditionalEventAndupdateMainOne(streamId);
              });

              it('[HJWE] should return 200', () => {
                assert.equal(res.status, 200);
              });
              it('[6AAT] should notify register with the updated data', function () {
                if (isDnsLess) this.skip();
                assert.equal(scope.isDone(), true);
                assert.deepEqual(serviceRegisterRequest, {
                  username: user.attrs.username,
                  user: {
                    email: [{
                      value: eventData.content,
                      isUnique: true,
                      isActive: true,
                      creation: false
                    }]
                  },
                  fieldsToDelete: {}
                });
              });
            });
          });
          describe('by updating a unique field that is already taken', () => {
            describe('with a field that is not unique in register', () => {
              let systemStreamId;
              before(async function () {
                if (isDnsLess) this.skip();
                const streamId = 'email';
                systemStreamId = SystemStreamsSerializer.addCustomerPrefixToStreamId(streamId);

                await createUser();
                eventData = {
                  streamIds: [systemStreamId],
                  content: charlatan.Lorem.characters(7),
                  type: 'string/pryv'
                };
                nock.cleanAll();
                scope = nock(config.get('services:register:url'));
                scope.put('/users',
                  (body) => {
                    serviceRegisterRequest = body;
                    return true;
                  }).reply(409, {
                  error: {
                    id: ErrorIds.ItemAlreadyExists,
                    data: {
                      [streamId]: eventData.content
                    }
                  }
                });
                const initialEvent = await getOneEvent(user.attrs.id, systemStreamId);

                res = await request.put(path.join(basePath, initialEvent.id))
                  .send(eventData)
                  .set('authorization', access.token);
              });
              it('[F8A8] should return 409', () => {
                assert.equal(res.status, 409);
                assert.equal(res.body.error.id, ErrorIds.ItemAlreadyExists);
                assert.deepEqual(res.body.error.data, { email: eventData.content });
              });
              it('[5A04] should notify register with the updated data', function () {
                if (isDnsLess) this.skip();
                assert.equal(scope.isDone(), true);

                assert.deepEqual(serviceRegisterRequest, {
                  username: user.attrs.username,
                  user: {
                    email: [{
                      value: eventData.content,
                      isUnique: true,
                      isActive: true,
                      creation: false
                    }]
                  },
                  fieldsToDelete: {}
                });
              });
            });
            describe('with a field that is not unique in mongodb', () => {
              before(async function () {
                const streamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
                const user1 = await createUser();
                const user2 = await createUser();
                eventData = {
                  streamIds: [streamId],
                  content: user1.attrs.email,
                  type: 'string/pryv'
                };
                nock.cleanAll();
                scope = nock(config.get('services:register:url'));
                scope.put('/users',
                  (body) => {
                    serviceRegisterRequest = body;
                    return true;
                  }).reply(200, { errors: [] });
                const initialEvent = await getOneEvent(user2.attrs.id, streamId);

                res = await request.put(path.join(basePath, initialEvent.id))
                  .send(eventData)
                  .set('authorization', access.token);
              });
              it('[5782] should return 409', () => {
                assert.equal(res.status, 409);
              });
              it('[B285] should return the correct error', () => {
                const error = res.body.error;
                assert.equal(error.id, ErrorIds.ItemAlreadyExists);
                assert.equal(error.data.email, eventData.content);
              });
            });
          });
        });
      });

      describe('to update a non editable system event', () => {
        before(async function () {
          await createUser();
          eventData = {
            content: charlatan.Lorem.characters(7),
            type: 'password-hash/pryv'
          };
          const initialEvent = await getOneEvent(user.attrs.id, SystemStreamsSerializer.addPrivatePrefixToStreamId('invitationToken'));

          res = await request.put(path.join(basePath, initialEvent.id))
            .send(eventData)
            .set('authorization', access.token);
        });
        it('[034D] should return 400', () => {
          assert.equal(res.status, 400);
        });
        it('[BB5F] should return the correct error', () => {
          assert.equal(res.body.error.id, ErrorIds.InvalidOperation);
          assert.equal(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenAccountEventModification]);
          assert.deepEqual(res.body.error.data, { streamId: SystemStreamsSerializer.addPrivatePrefixToStreamId('invitationToken') });
        });
      });
    });
    describe('when using a shared access with a contribute-level access on a system stream', () => {
      describe('to update an editable system event', () => {
        before(async function () {
          const user2 = await createUser();
          const sharedAccess = await user2.access({
            token: cuid(),
            type: 'shared',
            permissions: [{
              streamId: SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'),
              level: 'contribute'
            }]
          });
          eventData = {
            content: charlatan.Internet.email()
          };
          const initialEvent = await getOneEvent(user.attrs.id, SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'));

          res = await request.put(path.join(basePath, initialEvent.id))
            .send(eventData)
            .set('authorization', sharedAccess.attrs.token);
        });
        it('[W8PQ] should return 200', () => {
          assert.equal(res.status, 200);
        });
        it('[TFOI] should return the updated event', () => {
          assert.equal(res.body.event.content, eventData.content);
          assert.deepEqual(res.body.event.streamIds, [
            SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'),
            SystemStreamsSerializer.options.STREAM_ID_ACTIVE]);
        });
      });
    });
    describe('when using a shared access with a manage-level permission on all streams (star)', () => {
      describe('to update an editable system event', () => {
        before(async function () {
          await createUser();
          const sharedAccess = await user.access({
            token: cuid(),
            type: 'shared',
            permissions: [{
              streamId: '*',
              level: 'manage'
            }]
          });
          eventData = {
            content: charlatan.Lorem.characters(7),
            type: 'string/pryv'
          };
          const initialEvent = await getOneEvent(user.attrs.id, SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber'));

          res = await request.put(path.join(basePath, initialEvent.id))
            .send(eventData)
            .set('authorization', sharedAccess.attrs.token);
        });
        it('[H1XL] should return 403', () => {
          assert.equal(res.status, 403);
        });
        it('[7QA3] should return the correct error', () => {
          assert.equal(res.body.error.id, ErrorIds.Forbidden);
        });
      });
    });
  });

  describe('DELETE /events/<id>', () => {
    describe('When using a personal access', () => {
      describe('to delete an editable streams event', () => {
        describe('that has no ‘active’ streamId', () => {
          describe('which is unique', () => {
            const streamId = 'email';
            let systemStreamId;
            let initialEvent;
            before(async function () {
              systemStreamId = SystemStreamsSerializer.addCustomerPrefixToStreamId(streamId);
              nock.cleanAll();
              scope = nock(config.get('services:register:url'));
              scope.put('/users',
                (body) => {
                  serviceRegisterRequest = body;
                  return true;
                }).times(2).reply(200, { errors: [] });
              await createUser();
              initialEvent = await getOneEvent(user.attrs.id, systemStreamId);
              await createAdditionalEvent(systemStreamId);

              res = await request.delete(path.join(basePath, initialEvent.id))
                .set('authorization', access.token);
            });
            it('[43B1] should return 200', () => {
              assert.equal(res.status, 200);
            });
            it('[3E12] should return the trashed event', () => {
              assert.equal(res.body.event.id, initialEvent.id);
              assert.equal(res.body.event.trashed, true);
            });
            it('[F328] should notify register with the deleted data', function () {
              if (isDnsLess) this.skip();
              assert.equal(scope.isDone(), true);
              assert.deepEqual(serviceRegisterRequest, {
                username: user.attrs.username,
                user: {},
                fieldsToDelete: { [streamId]: initialEvent.content }
              });
            });
          });
          describe('which is indexed', () => {
            let streamId;
            let initialEvent;
            before(async function () {
              streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('language');
              nock.cleanAll();
              scope = nock(config.get('services:register:url'));
              scope.put('/users',
                (body) => {
                  serviceRegisterRequest = body;
                  return true;
                }).times(1).reply(200, { errors: [] });
              await createUser();
              initialEvent = await getOneEvent(user.attrs.id, streamId);

              await createAdditionalEvent(streamId);

              res = await request.delete(path.join(basePath, initialEvent.id))
                .set('authorization', access.token);
            });
            it('[1B70] should return 200', () => {
              assert.equal(res.status, 200);
            });
            it('[CBB9] should return the trashed event', () => {
              assert.equal(res.body.event.id, initialEvent.id);
              assert.equal(res.body.event.trashed, true);
            });
          });
        });
        describe('that has the ‘active’ streamId', () => {
          let streamId;
          let initialEvent;
          before(async function () {
            streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('language');
            await createUser();
            initialEvent = await getOneEvent(user.attrs.id, streamId);
            res = await request.delete(path.join(basePath, initialEvent.id))
              .set('authorization', access.token);
          });
          it('[10EC] should return 400', () => {
            assert.equal(res.status, 400);
          });
          it('[D4CA] should return the correct error', () => {
            assert.equal(res.body.error.id, ErrorIds.InvalidOperation);
            assert.equal(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenAccountEventModification]);
          });
        });
      });
      describe('to delete a non editable system event', () => {
        let streamId;
        let initialEvent;
        before(async function () {
          streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('dbDocuments');
          nock.cleanAll();
          scope = nock(config.get('services:register:url'));
          scope.put('/users',
            (body) => {
              serviceRegisterRequest = body;
              return true;
            }).times(2).reply(200, { errors: [] });
          await createUser();
          initialEvent = await getOneEvent(user.attrs.id, streamId);

          await createAdditionalEvent(streamId);

          res = await request.delete(path.join(basePath, initialEvent.id))
            .set('authorization', access.token);
        });
        it('[8EDB] should return a 400', () => {
          assert.equal(res.status, 400);
        });
        it('[A727] should return the correct error', () => {
          assert.equal(res.body.error.id, ErrorIds.InvalidOperation);
          assert.equal(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenAccountEventModification]);
        });
      });
    });

    describe('when using a shared access with a contribute-level access on a system stream', () => {
      let streamId;
      let initialEvent;
      before(async function () {
        streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('language');
        nock.cleanAll();
        scope = nock(config.get('services:register:url'));
        scope.put('/users',
          (body) => {
            serviceRegisterRequest = body;
            return true;
          }).times(1).reply(200, { errors: [] });
        await createUser();
        initialEvent = await getOneEvent(user.attrs.id, streamId);

        await createAdditionalEvent(streamId);
        res = await request.delete(path.join(basePath, initialEvent.id))
          .set('authorization', access.token);
      });
      it('[I1I1] should return 200', () => {
        assert.equal(res.status, 200);
      });
      it('[UFLT] should return the updated event', () => {
        assert.equal(res.body.event.id, initialEvent.id);
        assert.equal(res.body.event.trashed, true);
      });
    });

    describe('when using a shared access with a manage-level permission on all streams (star)', () => {
      const streamId = 'email';
      let systemStreamId;
      let initialEvent;
      before(async function () {
        systemStreamId = SystemStreamsSerializer.addCustomerPrefixToStreamId(streamId);
        nock.cleanAll();
        scope = nock(config.get('services:register:url'));
        scope.put('/users',
          (body) => {
            serviceRegisterRequest = body;
            return true;
          }).times(2).reply(200, { errors: [] });
        await createUser();
        initialEvent = await getOneEvent(user.attrs.id, systemStreamId);

        await createAdditionalEvent(systemStreamId);
        const sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'manage'
          }]
        });

        res = await request.delete(path.join(basePath, initialEvent.id))
          .set('authorization', sharedAccess.attrs.token);
      });
      it('[AT1E] should return 403', () => {
        assert.equal(res.status, 403);
      });
      it('[FV8W] should return the correct error', () => {
        assert.equal(res.body.error.id, ErrorIds.Forbidden);
      });
    });
  });
});
