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

const cuid = require('cuid');
const path = require('path');
const bluebird = require('bluebird');
const nock = require('nock');
const assert = require('chai').assert;
const supertest = require('supertest');
const charlatan = require('charlatan');

const ErrorIds = require('errors').ErrorIds;
const ErrorMessages = require('errors/src/ErrorMessages');
const { getApplication } = require('api-server/src/application');

const { pubsub } = require('messages');
const AccessLogic = require('business/src/accesses/AccessLogic');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');

const { databaseFixture } = require('test-helpers');
const { produceMongoConnection } = require('api-server/test/test-helpers');

const { getConfig } = require('@pryv/boiler');

describe('Accesses with account streams', function () {
  let config;
  let app;
  let request;
  let res;
  let createAccessResponse;
  let accountAccessData;
  let mongoFixtures;
  let basePath;
  let eventsBasePath;
  let access;
  let user;
  let validation;

  async function createUser () {
    user = await mongoFixtures.user(charlatan.Lorem.characters(7), {
      insurancenumber: charlatan.Number.number(4),
      phoneNumber: charlatan.Lorem.characters(3)
    });
    basePath = '/' + user.attrs.username + '/accesses';
    eventsBasePath = '/' + user.attrs.username + '/events';
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    access = access.attrs;
    await user.session(access.token);
    return user;
  }

  async function createUserAndAccess (permissionLevel, streamId) {
    await createUser();
    createAccessResponse = await request.post(basePath)
      .send({
        name: charlatan.Lorem.characters(7),
        permissions: [
          {
            streamId,
            level: permissionLevel
          }
        ]
      })
      .set('authorization', access.token);
    accountAccessData = createAccessResponse.body.access;
  }

  async function getAccessInDb (id) {
    return await bluebird.fromCallback(
      (cb) => user.storage.accesses.findOne({ id: user.attrs.id }, { _id: id }, null, cb));
  }

  before(async function () {
    const helpers = require('api-server/test/helpers');
    config = await getConfig();
    validation = helpers.validation;
    mongoFixtures = databaseFixture(await produceMongoConnection());

    app = getApplication(true);
    await app.initiate();

    // Initialize notifyTests dependency
    const axonMsgs = [];
    const axonSocket = {
      emit: (...args) => axonMsgs.push(args)
    };
    pubsub.setTestNotifier(axonSocket);
    pubsub.status.emit(pubsub.SERVER_READY);
    await require('api-server/src/methods/accesses')(app.api);

    await require('api-server/src/methods/events')(app.api);
    request = supertest(app.expressApp);
  });

  describe('POST /accesses', () => {
    describe('When using a personal access', () => {
      describe('to create an access for visible account streams', () => {
        describe('with a read-level permission', () => {
          let systemEmailStreamId;
          const permissionLevel = AccessLogic.PERMISSION_LEVEL_READ;
          before(async function () {
            systemEmailStreamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
            await createUserAndAccess(permissionLevel, systemEmailStreamId);
          });
          it('[UE9G] should return 201', async () => {
            assert.equal(createAccessResponse.status, 201);
          });
          it('[BUYP] should create access in the database', async () => {
            assert.deepEqual(accountAccessData.permissions, [{ streamId: systemEmailStreamId, level: permissionLevel }]);
          });
          it('[S3IQ] should enable user to read visible stream event with this access', async () => {
            res = await request.get(eventsBasePath).set('authorization', accountAccessData.token);
            assert.equal(res.body.events.length, 1);
            assert.equal(res.body.events[0].streamId, systemEmailStreamId);
          });

          describe('for the “account” stream', () => {
            let streamId;
            const permissionLevel = AccessLogic.PERMISSION_LEVEL_READ;
            before(async function () {
              streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('account');
              await createUserAndAccess(permissionLevel, streamId);
            });
            it('[XEAK] should return 201', async () => {
              assert.equal(createAccessResponse.status, 201);
            });
            it('[65I4] should create access in the database', async () => {
              assert.deepEqual(accountAccessData.permissions, [{ streamId, level: permissionLevel }]);
            });
            it('[L99L] should allow to access visible events in storageUsed', async () => {
              res = await request.get(eventsBasePath).set('authorization', accountAccessData.token);
              assert.equal(res.body.events.length, 6);
              validation.validateAccountEvents(res.body.events);
            });
          });
          describe('for the “storageUsed” stream', () => {
            let streamId;
            const permissionLevel = AccessLogic.PERMISSION_LEVEL_READ;
            before(async function () {
              streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('storageUsed');
              await createUserAndAccess(permissionLevel, streamId);
            });
            it('[EPEP] should return 201', async () => {
              assert.equal(createAccessResponse.status, 201);
            });
            it('[U3UM] should create access in the database', async () => {
              assert.deepEqual(accountAccessData.permissions, [{ streamId, level: permissionLevel }]);
            });
            it('[A4UP] should allow to access visible events in storageUsed', async () => {
              res = await request.get(eventsBasePath).set('authorization', accountAccessData.token);
              assert.equal(res.body.events.length, 2);
              assert.isTrue([
                SystemStreamsSerializer.addPrivatePrefixToStreamId('attachedFiles'),
                SystemStreamsSerializer.addPrivatePrefixToStreamId('dbDocuments')
              ].includes(res.body.events[0].streamId));
              assert.isTrue([
                SystemStreamsSerializer.addPrivatePrefixToStreamId('attachedFiles'),
                SystemStreamsSerializer.addPrivatePrefixToStreamId('dbDocuments')
              ].includes(res.body.events[1].streamId));
            });
          });
        });
        describe('with a create-only-level permission', () => {
          let streamId;
          const permissionLevel = AccessLogic.PERMISSION_LEVEL_CREATE_ONLY;
          before(async function () {
            streamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
            await createUserAndAccess(permissionLevel, streamId);
          });
          it('[IWMQ] should return 201', async () => {
            assert.equal(createAccessResponse.status, 201);
          });
          it('[APYN] should create access in the database', async () => {
            assert.deepEqual(accountAccessData.permissions, [{ streamId, level: permissionLevel }]);
          });
        });
        describe('with a contribute-level permission', () => {
          let streamId;
          const permissionLevel = AccessLogic.PERMISSION_LEVEL_CONTRIBUTE;
          before(async function () {
            streamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
            await createUserAndAccess(permissionLevel, streamId);
          });
          it('[R0M1] should return 201', async () => {
            assert.equal(createAccessResponse.status, 201);
          });
          it('[Q8R8] should create access in the database', async () => {
            assert.deepEqual(accountAccessData.permissions, [{ streamId, level: permissionLevel }]);
          });
          it('[TI1X] should allow to create visible stream events', async () => {
            const scope = nock(config.get('services:register:url'));
            scope.put('/users',
              (body) => {
                return true;
              }).reply(200, { errors: [] });

            const response = await request.post(eventsBasePath)
              .send({
                streamIds: [streamId],
                content: charlatan.Lorem.characters(7),
                type: 'string/pryv'
              })
              .set('authorization', accountAccessData.token);

            assert.equal(response.status, 201);
            assert.exists(response.body.event);
            assert.equal(response.body.event.streamId, streamId);
          });
        });

        describe('with a manage-level permission', () => {
          let streamId;
          before(async function () {
            streamId = SystemStreamsSerializer.addCustomerPrefixToStreamId('email');
            await createUserAndAccess(AccessLogic.PERMISSION_LEVEL_MANAGE, streamId);
          });
          it('[93HO] should return 400', async () => {
            assert.equal(createAccessResponse.status, 400);
          });
          it('[YPHX] should return the correct error', async () => {
            assert.deepEqual(createAccessResponse.body.error, {
              id: ErrorIds.InvalidOperation,
              message: ErrorMessages[ErrorIds.TooHighAccessForSystemStreams],
              data: { param: streamId }
            });
          });
        });
      });
      describe('to create an access for not visible account streams', () => {
        let streamId;
        before(async function () {
          streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('invitationToken');
          await createUserAndAccess('read', streamId);
        });
        it('[ATGU] should return 400', async () => {
          assert.equal(createAccessResponse.status, 400);
        });
        it('[Q2KZ] should return the correct error', async () => {
          assert.deepEqual(createAccessResponse.body.error, {
            id: ErrorIds.InvalidOperation,
            message: ErrorMessages[ErrorIds.DeniedStreamAccess],
            data: { param: streamId }
          });
        });
      });
      describe('to create an access for unexisting system streams', () => {
        before(async function () {
          const streamId = ':system:' + charlatan.Lorem.characters(10);
          await createUserAndAccess('read', streamId);
        });
        it('[KKKS] should return 403 forbidden', async () => {
          assert.equal(createAccessResponse.status, 403);
          assert.equal(createAccessResponse.body.error.id, ErrorIds.Forbidden);
        });
      });
    });
  });

  describe('DELETE /accesses', () => {
    describe('When using a personal access', () => {
      describe('to delete an account stream access', () => {
        let streamId;
        const permissionLevel = AccessLogic.PERMISSION_LEVEL_READ;
        before(async function () {
          streamId = SystemStreamsSerializer.addPrivatePrefixToStreamId('storageUsed');
          await createUserAndAccess(permissionLevel, streamId);
          res = await request.delete(path.join(basePath, createAccessResponse.body.access.id))
            .set('authorization', access.token);
        });
        it('[Z40J] should return 200', async () => {
          assert.equal(res.status, 200);
        });
        it('[MP9T] should delete the access in the database', async () => {
          const deletedAccess = await getAccessInDb(createAccessResponse.body.access.id);
          assert.equal(deletedAccess, null);
        });
      });
    });
  });
});
