/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const cuid = require('cuid');
const charlatan = require('charlatan');
const supertest = require('supertest');

const { ErrorIds } = require('errors');
const { getApplication } = require('api-server/src/application');

const { pubsub } = require('messages');
const { addPrivatePrefixToStreamId, addCustomerPrefixToStreamId } = require('test-helpers/src/systemStreamFilters');

const { getUserAccountStorage } = require('storage');

const { databaseFixture } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');

const { getMall } = require('mall');

describe('[ACCO] Account with system streams', function () {
  let app;
  let request;
  let res;
  let mongoFixtures;
  let basePath;
  let access;
  let user;
  let mall;
  let userAccountStorage;
  let savedIntegrityCheck;

  before(async () => {
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    userAccountStorage = await getUserAccountStorage();
  });

  async function createUser () {
    // Use cuid for unique username to avoid parallel test conflicts
    user = await mongoFixtures.user('accds' + cuid.slug().toLowerCase(), {
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

  async function getAccountEvent (streamId, isPrivate = true) {
    const streamIdWithPrefix = isPrivate ? addPrivatePrefixToStreamId(streamId) : addCustomerPrefixToStreamId(streamId);
    const res = await mall.events.get(user.attrs.id, { streams: [{ any: [streamIdWithPrefix] }] });
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
    mongoFixtures = databaseFixture(await produceStorageConnection());
    app = getApplication(true);
    await app.initiate();
    // Initialize notifications dependency
    const testMsgs = [];
    const testNotifier = {
      emit: (...args) => testMsgs.push(args)
    };
    pubsub.setTestNotifier(testNotifier);
    pubsub.status.emit(pubsub.SERVER_READY);
    await require('api-server/src/methods/account')(app.api);
    await require('api-server/src/methods/events')(app.api);
    request = supertest(app.expressApp);
    mall = await getMall();
  });

  after(async function () {
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  describe('[DA01] GET /account', () => {
    describe('[DA02] and when user has multiple events per stream and additional streams events', () => {
      let allVisibleAccountEvents;
      before(async function () {
        await createUser();
        // create additional events for all editable streams
        const editableStreamsIds = ['email', 'phoneNumber', 'insurancenumber']
          .map(addCustomerPrefixToStreamId)
          .concat([addPrivatePrefixToStreamId('language')]);
        const visibleStreamsIds = ['language', 'dbDocuments', 'attachedFiles']
          .map(addPrivatePrefixToStreamId)
          .concat(['email', 'phoneNumber', 'insurancenumber'].map(addCustomerPrefixToStreamId));

        for (const editableStreamsId of editableStreamsIds) {
          await createAdditionalEvent(editableStreamsId);
        }

        allVisibleAccountEvents = await mall.events.get(user.attrs.id,
          {
            streams: [{ any: visibleStreamsIds }]
          });

        // get account info
        res = await request.get(basePath).set('authorization', access.token);
      });
      it('[XRKX] should return 200', async () => {
        assert.strictEqual(res.status, 200);
      });
      it('[JUHR] should return account information in the structure that is defined in system streams and only active values', async () => {
        const emailAccountEvent = allVisibleAccountEvents.find(event =>
          event.streamIds.includes(addCustomerPrefixToStreamId('email')));
        const languageAccountEvent = allVisibleAccountEvents.find(event =>
          event.streamIds.includes(addPrivatePrefixToStreamId('language')));
        const dbDocumentsAccountEvent = allVisibleAccountEvents.find(event =>
          event.streamIds.includes(addPrivatePrefixToStreamId('dbDocuments')));
        const attachedFilesAccountEvent = allVisibleAccountEvents.find(event =>
          event.streamIds.includes(addPrivatePrefixToStreamId('attachedFiles')));
        // TODO: verify the following data or remove those lines
        // const insurancenumberAccountEvent = allVisibleAccountEvents.find(event =>
        //   event.streamIds.includes(addCustomerPrefixToStreamId('insurancenumber')));
        // const phoneNumberAccountEvent = allVisibleAccountEvents.find(event =>
        //   event.streamIds.includes(addCustomerPrefixToStreamId('phoneNumber')));
        assert.strictEqual(res.body.account.email, emailAccountEvent.content);
        assert.strictEqual(res.body.account.language, languageAccountEvent.content);
        assert.strictEqual(res.body.account.storageUsed.dbDocuments, dbDocumentsAccountEvent.content);
        assert.strictEqual(res.body.account.storageUsed.attachedFiles, attachedFilesAccountEvent.content);
      });
      it('[R5S0] should return only visible default stream events', async () => {
        assert.strictEqual(Object.keys(res.body.account).length, 4);
      });
    });
  });

  describe('[DA03] POST /change-password', () => {
    describe('[DA04] and when valid data is provided', () => {
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
        assert.strictEqual(res.status, 200);
      });
      it('[ACNE] should find password in password history', async () => {
        assert.strictEqual(await userAccountStorage.passwordExistsInHistory(user.attrs.id, passwordBefore, 2), true, 'missing previous password in history');
        assert.strictEqual(await userAccountStorage.passwordExistsInHistory(user.attrs.id, passwordAfter, 1), true, 'missing new password in history');
      });
    });
  });

  describe('[DA05] PUT /account', () => {
    describe('[DA06] when updating the username', () => {
      before(async function () {
        await createUser();
        // modify account info
        res = await request.put(basePath)
          .send({ username: charlatan.Lorem.characters(7) })
          .set('authorization', access.token);
      });
      it('[P69J] should return 400', async () => {
        assert.strictEqual(res.status, 400);
      });
      it('[DBM6] should return the correct error', async () => {
        // currently stupid z-schema error is thrown, so let like this because the method will be deprecated
        assert.strictEqual(res.body.error.data.length, 1);
        assert.strictEqual(res.body.error.data[0].code, 'OBJECT_ADDITIONAL_PROPERTIES');
      });
    });
    describe('[DA07] when updating non editable fields', () => {
      before(async function () {
        await createUser();
        // modify account info
        res = await request.put(basePath)
          .send({ attachedFiles: 2 })
          .set('authorization', access.token);
      });
      it('[90N3] should return 400', async () => {
        assert.strictEqual(res.status, 400);
      });
      it('[QHZ4] should return the correct error', async () => {
        // currently stupid z-schema error is thrown, so let like this because the method will be deprecated
        assert.strictEqual(res.body.error.data.length, 1);
        assert.strictEqual(res.body.error.data[0].code, 'OBJECT_ADDITIONAL_PROPERTIES');
      });
    });
    describe('[DA08] when updating a unique field that is already taken', () => {
      describe('[DA09] and the field is not unique in PlatformDB', () => {
        let user2;
        before(async function () {
          user2 = await createUser();
          await createUser();

          // modify account info — PlatformDB should reject the duplicate email
          res = await request.put(basePath)
            .send({ email: user2.attrs.email })
            .set('authorization', access.token);
        });
        it('[K3X9] should return a 409 error', async () => {
          assert.strictEqual(res.status, 409);
        });
        it('[8TRP] should return the correct error', async () => {
          assert.strictEqual(res.body.error.id, ErrorIds.ItemAlreadyExists);
          assert.deepStrictEqual(res.body.error.data, { email: user2.attrs.email });
        });
      });
    });

    describe('[DA10] when updating email and language', () => {
      const newEmail = charlatan.Internet.email();
      const newLanguage = charlatan.Lorem.characters(2);
      let emailBefore;
      let languageBefore;
      let emailAfter;
      let languageAfter;

      before(async function () {
        await createUser();

        emailBefore = await getAccountEvent('email', false);
        languageBefore = await getAccountEvent('language');

        // modify account info
        res = await request.put(basePath)
          .send({
            email: newEmail,
            language: newLanguage
          })
          .set('authorization', access.token);

        emailAfter = await getAccountEvent('email', false);
        languageAfter = await getAccountEvent('language');
      });
      it('[JJ81] should return 200', async () => {
        assert.strictEqual(res.status, 200);
      });
      it('[K9IC] should returned updated account data', async () => {
        assert.deepStrictEqual(res.body.account, {
          username: user.attrs.username,
          email: newEmail,
          language: newLanguage,
          storageUsed: { dbDocuments: 0, attachedFiles: 0 }
        });
      });
      it('[JQHX] should update the field values in the database', async () => {
        assert.notEqual(emailBefore.content, emailAfter.content);
        assert.notEqual(languageBefore.content, languageAfter.content);
        assert.strictEqual(emailAfter.content, newEmail);
        assert.strictEqual(languageAfter.content, newLanguage);
      });
    });
  });
});
