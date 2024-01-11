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

const { assert } = require('chai');
const cuid = require('cuid');
const charlatan = require('charlatan');
const nock = require('nock');
const supertest = require('supertest');

const { ErrorIds } = require('errors');
const { getApplication } = require('api-server/src/application');

const { pubsub } = require('messages');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');

const { getUserAccountStorage } = require('storage');
const { getConfig } = require('@pryv/boiler');

const { databaseFixture } = require('test-helpers');
const { produceMongoConnection } = require('api-server/test/test-helpers');

const { getMall } = require('mall');

describe('[ACCO] Account with system streams', function () {
  let helpers;
  let app;
  let request;
  let res;
  let mongoFixtures;
  let basePath;
  let access;
  let user;
  let serviceRegisterRequest;
  let config;
  let isDnsLess;
  let mall;
  let userAccountStorage;

  before(async () => {
    userAccountStorage = await getUserAccountStorage();
  });

  async function createUser () {
    user = await mongoFixtures.user(charlatan.Lorem.characters(7), {
      insurancenumber: charlatan.Number.number(4),
      phoneNumber: charlatan.Lorem.characters(3)
    });

    basePath = '/' + user.attrs.username + '/account';
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    access = access.attrs;
    await user.session(access.token);

    return user;
  }

  async function getActiveEvent (streamId, isPrivate = true) {
    const streamIdWithPrefix = isPrivate ? SystemStreamsSerializer.addPrivatePrefixToStreamId(streamId) : SystemStreamsSerializer.addCustomerPrefixToStreamId(streamId);
    const streamQuery = [{ any: [streamIdWithPrefix], and: [{ any: [SystemStreamsSerializer.options.STREAM_ID_ACTIVE] }] }];
    const res = await mall.events.get(user.attrs.id, { streams: streamQuery });
    if (res.length === 0) return null;
    return res[0];
  }

  async function getNotActiveEvent (streamId, isPrivate = true) {
    const streamIdWithPrefix = isPrivate ? SystemStreamsSerializer.addPrivatePrefixToStreamId(streamId) : SystemStreamsSerializer.addCustomerPrefixToStreamId(streamId);
    const streamQuery = [{ any: [streamIdWithPrefix], and: [{ not: [SystemStreamsSerializer.options.STREAM_ID_ACTIVE] }] }];
    const res = await mall.events.get(user.attrs.id, { streams: streamQuery });
    if (res.length === 0) return null;
    return res[0];
  }
  /**
   * Create additional event
   * @param string streamId
   */
  async function createAdditionalEvent (streamIdWithPrefix, content) {
    const eventDataForadditionalEvent = {
      streamIds: [streamIdWithPrefix],
      content: content || charlatan.Lorem.characters(7),
      type: 'string/pryv'
    };
    return await request.post('/' + user.attrs.username + '/events')
      .send(eventDataForadditionalEvent)
      .set('authorization', access.token);
  }

  before(async function () {
    config = await getConfig();
    config.injectTestConfig({ testsSkipForwardToRegister: false });
    isDnsLess = config.get('dnsLess:isActive');
    helpers = require('api-server/test/helpers');
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
    await require('api-server/src/methods/account')(app.api);
    await require('api-server/src/methods/events')(app.api);
    request = supertest(app.expressApp);
    mall = await getMall();
  });

  after(async function () {
    config.injectTestConfig({});
  });

  describe('GET /account', () => {
    describe('and when user has multiple events per stream and additional streams events', () => {
      let allVisibleAccountEvents;
      let scope;
      before(async function () {
        await createUser();
        // create additional events for all editable streams
        const settings = structuredClone(helpers.dependencies.settings);
        scope = nock(settings.services.register.url);

        scope.put('/users',
          (body) => {
            serviceRegisterRequest = body;
            return true;
          }).times(3).reply(200, { errors: [] });
        const editableStreamsIds = ['email', 'phoneNumber', 'insurancenumber']
          .map(SystemStreamsSerializer.addCustomerPrefixToStreamId)
          .concat([SystemStreamsSerializer.addPrivatePrefixToStreamId('language')]);
        const visibleStreamsIds = ['language', 'dbDocuments', 'attachedFiles']
          .map(SystemStreamsSerializer.addPrivatePrefixToStreamId)
          .concat(['email', 'phoneNumber', 'insurancenumber'].map(SystemStreamsSerializer.addCustomerPrefixToStreamId));

        for (const editableStreamsId of editableStreamsIds) {
          await createAdditionalEvent(editableStreamsId);
        }

        allVisibleAccountEvents = await mall.events.get(user.attrs.id,
          {
            streams: [
              { any: visibleStreamsIds },
              { and: [{ any: [SystemStreamsSerializer.options.STREAM_ID_ACTIVE] }] }
            ]
          });

        // get account info
        res = await request.get(basePath).set('authorization', access.token);
      });
      it('[XRKX] should return 200', async () => {
        assert.equal(res.status, 200);
      });
      it('[JUHR] should return account information in the structure that is defined in system streams and only active values', async () => {
        const emailAccountEvent = allVisibleAccountEvents.find(event =>
          event.streamIds.includes(SystemStreamsSerializer.addCustomerPrefixToStreamId('email')));
        const languageAccountEvent = allVisibleAccountEvents.find(event =>
          event.streamIds.includes(SystemStreamsSerializer.addPrivatePrefixToStreamId('language')));
        const dbDocumentsAccountEvent = allVisibleAccountEvents.find(event =>
          event.streamIds.includes(SystemStreamsSerializer.addPrivatePrefixToStreamId('dbDocuments')));
        const attachedFilesAccountEvent = allVisibleAccountEvents.find(event =>
          event.streamIds.includes(SystemStreamsSerializer.addPrivatePrefixToStreamId('attachedFiles')));
        // TODO: verify the following data or remove those lines
        // const insurancenumberAccountEvent = allVisibleAccountEvents.find(event =>
        //   event.streamIds.includes(SystemStreamsSerializer.addCustomerPrefixToStreamId('insurancenumber')));
        // const phoneNumberAccountEvent = allVisibleAccountEvents.find(event =>
        //   event.streamIds.includes(SystemStreamsSerializer.addCustomerPrefixToStreamId('phoneNumber')));
        assert.equal(res.body.account.email, emailAccountEvent.content);
        assert.equal(res.body.account.language, languageAccountEvent.content);
        assert.equal(res.body.account.storageUsed.dbDocuments, dbDocumentsAccountEvent.content);
        assert.equal(res.body.account.storageUsed.attachedFiles, attachedFilesAccountEvent.content);
      });
      it('[R5S0] should return only visible default stream events', async () => {
        assert.equal(Object.keys(res.body.account).length, 4);
      });
    });
  });

  describe('POST /change-password', () => {
    describe('and when valid data is provided', () => {
      let passwordBefore;
      const passwordAfter = charlatan.Lorem.characters(7);
      let user;
      before(async function () {
        user = await createUser();
        basePath += '/change-password';
        // modify account info
        passwordBefore = user.attrs.password;
        res = await request.post(basePath)
          .send({
            newPassword: passwordAfter,
            oldPassword: passwordBefore
          })
          .set('authorization', access.token);
      });
      it('[X9VQ] should return 200', async () => {
        assert.equal(res.status, 200);
      });
      it('[ACNE] should find password in password history', async () => {
        assert.isTrue(await userAccountStorage.passwordExistsInHistory(user.attrs.id, passwordBefore, 2), 'missing previous password in history');
        assert.isTrue(await userAccountStorage.passwordExistsInHistory(user.attrs.id, passwordAfter, 1), 'missing new password in history');
      });
    });
  });

  describe('PUT /account', () => {
    describe('when updating the username', () => {
      before(async function () {
        await createUser();
        // modify account info
        res = await request.put(basePath)
          .send({ username: charlatan.Lorem.characters(7) })
          .set('authorization', access.token);
      });
      it('[P69J] should return 400', async () => {
        assert.equal(res.status, 400);
      });
      it('[DBM6] should return the correct error', async () => {
        // currently stupid z-schema error is thrown, so let like this because the method will be deprecated
        assert.equal(res.body.error.data.length, 1);
        assert.equal(res.body.error.data[0].code, 'OBJECT_ADDITIONAL_PROPERTIES');
      });
    });
    describe('when updating non editable fields', () => {
      before(async function () {
        await createUser();
        // modify account info
        res = await request.put(basePath)
          .send({ attachedFiles: 2 })
          .set('authorization', access.token);
      });
      it('[90N3] should return 400', async () => {
        assert.equal(res.status, 400);
      });
      it('[QHZ4] should return the correct error', async () => {
        // currently stupid z-schema error is thrown, so let like this because the method will be deprecated
        assert.equal(res.body.error.data.length, 1);
        assert.equal(res.body.error.data[0].code, 'OBJECT_ADDITIONAL_PROPERTIES');
      });
    });
    describe('when updating a unique field that is already taken', () => {
      describe('and the field is not unique in mongodb', () => {
        let scope;
        let user2;
        before(async function () {
          user2 = await createUser();
          await createUser();
          const settings = structuredClone(helpers.dependencies.settings);
          scope = nock(settings.services.register.url);
          scope.put('/users')
            .reply(400, {
              error: {
                id: ErrorIds.ItemAlreadyExists,
                data: { email: user2.attrs.email }
              }
            });

          // modify account info
          res = await request.put(basePath)
            .send({ email: user2.attrs.email })
            .set('authorization', access.token);
        });
        it('[K3X9] should return a 409 error', async () => {
          assert.equal(res.status, 409);
        });
        it('[8TRP] should return the correct error', async () => {
          assert.equal(res.body.error.id, ErrorIds.ItemAlreadyExists);
          assert.deepEqual(res.body.error.data, { email: user2.attrs.email });
        });
      });
    });

    describe('when updating email and language and non-active fields exists', () => {
      const newEmail = charlatan.Internet.email();
      const newLanguage = charlatan.Lorem.characters(2);
      let activeEmailBefore;
      let notActiveEmailBefore;
      let activeLanguageBefore;
      let notActiveLanguageBefore;

      let activeEmailAfter;
      let notActiveEmailAfter;
      let activeLanguageAfter;
      let notActiveLanguageAfter;

      let scope;
      before(async function () {
        await createUser();
        const settings = structuredClone(helpers.dependencies.settings);
        nock.cleanAll();
        scope = nock(settings.services.register.url);
        scope.put('/users')
          .reply(200, {});
        scope.put('/users',
          (body) => {
            serviceRegisterRequest = body;
            return true;
          }).times(3).reply(200, {});

        // create additional events
        await createAdditionalEvent(SystemStreamsSerializer.addCustomerPrefixToStreamId('email'), charlatan.Internet.email());
        await createAdditionalEvent(SystemStreamsSerializer.addPrivatePrefixToStreamId('language'));

        activeEmailBefore = await getActiveEvent('email', false);
        notActiveEmailBefore = await getNotActiveEvent('email', false);
        activeLanguageBefore = await getActiveEvent('language');
        notActiveLanguageBefore = await getNotActiveEvent('language');

        // modify account info
        res = await request.put(basePath)
          .send({
            email: newEmail,
            language: newLanguage
          })
          .set('authorization', access.token);

        activeEmailAfter = await getActiveEvent('email', false);
        notActiveEmailAfter = await getNotActiveEvent('email', false);
        activeLanguageAfter = await getActiveEvent('language');
        notActiveLanguageAfter = await getNotActiveEvent('language');
      });
      it('[JJ81] should return 200', async () => {
        assert.equal(res.status, 200);
      });
      it('[K9IC] should returned updated account data', async () => {
        assert.deepEqual(res.body.account, {
          username: user.attrs.username,
          email: newEmail,
          language: newLanguage,
          storageUsed: { dbDocuments: 0, attachedFiles: 0 }
        });
      });
      it('[JQHX] should update only active events in the database', async () => {
        assert.deepEqual(notActiveEmailBefore, notActiveEmailAfter);
        assert.deepEqual(notActiveLanguageBefore, notActiveLanguageAfter);
        assert.notEqual(activeEmailBefore.content, activeEmailAfter.content);
        assert.notEqual(activeLanguageBefore.content, activeLanguageAfter.content);
        assert.equal(activeEmailAfter.content, newEmail);
        assert.equal(activeLanguageAfter.content, newLanguage);
      });
      it('[Y6MC] Should send a request to service-register to update its user main information and unique fields', async function () {
        if (isDnsLess) this.skip();
        // email is already skipped
        assert.deepEqual(serviceRegisterRequest, {
          username: user.attrs.username,
          user: {
            email: [
              {
                creation: false,
                isActive: true,
                isUnique: true,
                value: newEmail
              }
            ],
            language: [
              {
                value: newLanguage,
                isUnique: false,
                isActive: true,
                creation: false
              }
            ]
          },
          fieldsToDelete: {}
        });
      });
    });
  });
});
