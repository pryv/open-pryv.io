/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const { promisify } = require('util');
const charlatan = require('charlatan');
const cuid = require('cuid');
const supertest = require('supertest');

const helpers = require('./helpers');
const { getConfig } = require('@pryv/boiler');
const { getApplication } = require('api-server/src/application');
const ErrorIds = require('errors/src/ErrorIds');
const ErrorMessages = require('errors/src/ErrorMessages');
const { getUsersRepository, User } = require('business/src/users');
const { getUserAccountStorage } = require('storage');
const { databaseFixture } = require('test-helpers');
const { produceStorageConnection } = require('./test-helpers');
const { ApiEndpoint } = require('utils');

function defaults () {
  return {
    appId: 'pryv-test',
    username: 'regc' + cuid.slug().toLowerCase(),
    email: charlatan.Internet.email(),
    password: 'abcdefgh',
    invitationToken: 'enjoy',
    referer: 'pryv',
    insurancenumber: charlatan.Number.number(3)
  };
}

describe('[REGC] registration: cluster', function () {
  let app;
  let request;
  let res;
  let config;
  let userData;
  let mongoFixtures;
  let usersRepository;
  let userAccountStorage;

  before(async function () {
    mongoFixtures = databaseFixture(await produceStorageConnection());
    await mongoFixtures.context.cleanEverything();
    userAccountStorage = await getUserAccountStorage();
  });

  before(async function () {
    config = await getConfig();
    config.injectTestConfig({
      dnsLess: { isActive: false }
    });
    app = getApplication();
    await app.initiate();
    await require('../src/methods/auth/register')(app.api);
    request = supertest(app.expressApp);
    usersRepository = await getUsersRepository();
  });

  after(async function () {
    config.injectTestConfig({});
    mongoFixtures = databaseFixture(await produceStorageConnection());
    await mongoFixtures.context.cleanEverything();
  });

  const methodPath = '/users';

  describe('[RC01] POST /users (create user)', function () {
    describe('[RC01A] successful registration', () => {
      before(async () => {
        userData = defaults();
        res = await request.post(methodPath).send(userData);
      });

      it('[QV8Z] should respond with status 201', () => {
        assert.strictEqual(res.status, 201);
      });

      it('[TCOM] should respond with the username and apiEndpoint', async () => {
        const body = res.body;
        assert.strictEqual(body.username, userData.username);
        const user = await usersRepository.getUserByUsername(userData.username);
        const findOneAsync = promisify((query, opts, extra, cb) => app.storageLayer.accesses.findOne(query, opts, extra, cb));
        const personalAccess = await findOneAsync({ id: user.id }, {}, null);
        const initUser = new User(userData);
        assert.strictEqual(body.apiEndpoint, ApiEndpoint.build(initUser.username, personalAccess.token));
      });
    });

    describe('[RC03] when the username already exists', () => {
      before(async () => {
        const firstUser = defaults();
        res = await request.post(methodPath).send(firstUser);
        assert.strictEqual(res.status, 201);
        userData = defaults();
        userData.username = firstUser.username;
        res = await request.post(methodPath).send(userData);
      });

      it('[NUC9] should respond with status 409', () => {
        assert.strictEqual(res.status, 409);
      });

      it('[X1IA] should respond with the correct error', () => {
        const error = res.body.error;
        assert.strictEqual(error.id, ErrorIds.ItemAlreadyExists);
        assert.ok(error.data.username);
      });
    });

    describe('[RC04] when the email already exists', () => {
      before(async () => {
        const firstUser = defaults();
        res = await request.post(methodPath).send(firstUser);
        assert.strictEqual(res.status, 201);
        userData = defaults();
        userData.email = firstUser.email;
        res = await request.post(methodPath).send(userData);
      });

      it('[SJXN] should respond with status 409', () => {
        assert.strictEqual(res.status, 409);
      });

      it('[U0ZN] should respond with the correct error', () => {
        const error = res.body.error;
        assert.strictEqual(error.id, ErrorIds.ItemAlreadyExists);
        assert.ok(error.data.email);
      });
    });

    describe('[RC05] when the username and email both exist', () => {
      before(async () => {
        const user1 = defaults();
        res = await request.post(methodPath).send(user1);
        assert.strictEqual(res.status, 201);
        const user2 = defaults();
        res = await request.post(methodPath).send(user2);
        assert.strictEqual(res.status, 201);
        userData = defaults();
        userData.username = user1.username;
        userData.email = user2.email;
        res = await request.post(methodPath).send(userData);
      });

      it('[LUC6] should respond with status 409', () => {
        assert.strictEqual(res.status, 409);
      });

      it('[XIN8] should respond with the correct error', () => {
        const error = res.body.error;
        assert.strictEqual(error.id, ErrorIds.ItemAlreadyExists);
        assert.ok(error.data.username);
        assert.ok(error.data.email);
      });
    });

    describe('[RC07] when invitationTokens are undefined (null)', () => {
      describe('[RC08] and a random string is provided as "invitationToken"', () => {
        before(async () => {
          userData = defaults();
          userData.invitationToken = charlatan.Lorem.characters(25);
          res = await request.post(methodPath).send(userData);
        });

        it('[CMOV] should respond with status 201', () => {
          assert.strictEqual(res.status, 201);
        });
      });

      describe('[RC09] and "invitationToken" is missing', () => {
        before(async () => {
          userData = defaults();
          delete userData.invitationToken;
          res = await request.post(methodPath).send(userData);
        });

        it('[LOIB] should respond with status 201', () => {
          assert.strictEqual(res.status, 201);
        });
      });
    });

    describe('[RC10] when invitationTokens are defined', () => {
      before(function () {
        config.injectTestConfig({
          dnsLess: { isActive: false },
          invitationTokens: ['enjoy']
        });
      });
      after(function () {
        config.injectTestConfig({
          dnsLess: { isActive: false }
        });
      });

      describe('[RC11] when a valid one is provided', () => {
        before(async () => {
          userData = defaults();
          userData.invitationToken = 'enjoy';
          res = await request.post(methodPath).send(userData);
        });

        it('[Z2ZY] should respond with status 201', () => {
          assert.strictEqual(res.status, 201);
        });

        it('[1BF3] should find password in password history', async () => {
          const user = await usersRepository.getUserByUsername(userData.username);
          assert.strictEqual(await userAccountStorage.passwordExistsInHistory(user.id, userData.password, 1), true, 'missing password in history');
        });
      });

      describe('[RC12] when an invalid one is provided', () => {
        before(async () => {
          userData = defaults();
          userData.invitationToken = 'wrong-token';
          res = await request.post(methodPath).send(userData);
        });

        it('[4GON] should respond with status 400', () => {
          assert.strictEqual(res.status, 400);
        });

        it('[P4GT] should respond with the correct error message', () => {
          const error = res.body.error;
          assert.strictEqual(error.id, ErrorIds.InvalidOperation);
          assert.ok(error.message.includes(ErrorMessages[ErrorIds.InvalidInvitationToken]));
        });
      });
    });

    describe('[RC13] when invitationTokens are set to [] (forbidden creation)', () => {
      before(function () {
        config.injectTestConfig({
          dnsLess: { isActive: false },
          invitationTokens: []
        });
      });
      after(function () {
        config.injectTestConfig({
          dnsLess: { isActive: false }
        });
      });

      describe('[RC14] when any string is provided', () => {
        before(async () => {
          userData = defaults();
          res = await request.post(methodPath).send(userData);
        });

        it('[CX9N] should respond with status 400', () => {
          assert.strictEqual(res.status, 400);
        });
      });
    });

    describe('[RC15] when custom account streams validation exists', () => {
      describe('[RC16] when email is set as required and it is not set in the request', () => {
        before(async () => {
          userData = defaults();
          delete userData.email;
          res = await request.post(methodPath).send(userData);
        });

        it('[UMWB] should respond with status 400', () => {
          assert.strictEqual(res.status, 400);
        });

        it('[8RDA] should respond with the correct error', () => {
          const error = res.body.error;
          assert.strictEqual(error.id, ErrorIds.InvalidParametersFormat);
          assert.deepEqual(error.data, [
            {
              code: ErrorIds.EmailRequired,
              message: ErrorMessages[ErrorIds.EmailRequired],
              path: '#/',
              param: 'email'
            }
          ]);
        });
      });

      describe('[RC17] when field does not match custom validation settings', () => {
        before(async () => {
          userData = defaults();
          userData.insurancenumber = 'abc';
          res = await request.post(methodPath).send(userData);
        });

        it('[8W22] should respond with status 400', () => {
          assert.strictEqual(res.status, 400);
        });

        it('[GBKD] should respond with the correct error', () => {
          const error = res.body.error;
          assert.strictEqual(error.id, ErrorIds.InvalidParametersFormat);
          assert.deepEqual(error.data, [
            {
              code: 'cool-error',
              message: 'Cool error',
              path: '#/insurancenumber',
              param: 'insurancenumber'
            }
          ]);
        });
      });
    });

    describe('[RCPW] When password rules are enabled', function () {
      const validation = helpers.validation;

      before(async () => {
        config.injectTestConfig(Object.assign(
          { dnsLess: { isActive: false } },
          helpers.passwordRules.settingsOverride
        ));
        userData = defaults();
      });

      after(function () {
        config.injectTestConfig({
          dnsLess: { isActive: false }
        });
      });

      it('[0OBL] must fail if the new password does not comply', async () => {
        userData.password = helpers.passwordRules.passwords.badTooShort;
        const res = await request.post(methodPath).send(userData);
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidParametersFormat
        });
      });

      it('[5BQL] must succeed if the new password complies', async () => {
        userData.password = helpers.passwordRules.passwords.good4CharCats;
        const res = await request.post(methodPath).send(userData);
        validation.check(res, { status: 201 });
      });
    });
  });
});
