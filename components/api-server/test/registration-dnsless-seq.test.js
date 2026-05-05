/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const assert = require('node:assert');
const supertest = require('supertest');
const charlatan = require('charlatan');
const { promisify } = require('util');
const cuid = require('cuid');

const { getApplication } = require('api-server/src/application');
const { getConfig } = require('@pryv/boiler');
const { getUsersRepository, User } = require('business/src/users');
const { databaseFixture } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');
const { pubsub } = require('messages');
const { USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH } = require('api-server/src/schema/helpers');
const { ErrorIds } = require('errors/src/ErrorIds');
const { ApiEndpoint } = require('utils');

describe('[BMM2] registration: DNS-less', () => {
  let config;
  let mongoFixtures;
  let app;
  let request;

  before(async function () {
    config = await getConfig();
    config.injectTestConfig({
      dnsLess: { isActive: true },
      custom: { systemStreams: null }
    });
  });

  after(async function () {
    config.injectTestConfig({});
  });

  before(async function () {
    mongoFixtures = databaseFixture(await produceStorageConnection());
    app = getApplication(true);
    await app.initiate();

    await require('api-server/src/methods/auth/register')(app.api);

    // get events for a small test of valid token
    // Initialize notifyTests dependency
    const testMsgs = [];
    const testNotifier = {
      emit: (...args) => testMsgs.push(args)
    };
    pubsub.setTestNotifier(testNotifier);
    await require('api-server/src/methods/events')(app.api);

    request = supertest(app.expressApp);
  });

  describe('[RD01] POST /users', () => {
    function generateRegisterBody () {
      return {
        username: 'regd' + cuid.slug().toLowerCase(),
        password: charlatan.Lorem.characters(7),
        email: charlatan.Internet.email(),
        appId: charlatan.Lorem.characters(7),
        insurancenumber: charlatan.Number.number(3),
        phoneNumber: charlatan.Number.number(3)
      };
    }

    it('[KB3T] should respond with status 201 when given valid input', async function () {
      const registerData = generateRegisterBody();
      const res = await request.post('/users').send(registerData);
      assert.strictEqual(res.status, 201, '[KB3T] should respond with status 201');
      assert.strictEqual(res.body.username, registerData.username, '[VDA8] should respond with username');
    });

    it('[VDA8] should respond with correct apiEndpoint for valid registration', async function () {
      const registerData = generateRegisterBody();
      const res = await request.post('/users').send(registerData);
      assert.strictEqual(res.body.username, registerData.username);
      const usersRepository = await getUsersRepository();
      const user = await usersRepository.getUserByUsername(registerData.username);
      const findOneAsync = promisify((query, opts, extra, cb) =>
        app.storageLayer.accesses.findOne(query, opts, extra, cb));
      const personalAccess = await findOneAsync({ id: user.id }, {}, null);
      const initUser = new User(user);
      assert.strictEqual(res.body.apiEndpoint, ApiEndpoint.build(initUser.username, personalAccess.token));
    });

    it('[LPLP] Valid access token exists in the response', async function () {
      const registerData = generateRegisterBody();
      const res = await request.post('/users').send(registerData);
      assert.ok(res.body.apiEndpoint);
      const token = res.body.apiEndpoint.split('//')[1].split('@')[0];

      // check that I can get events with this token
      const res2 = await request.get(`/${res.body.username}/events`)
        .set('authorization', token);
      assert.strictEqual(res2.status, 200);
      assert.ok(res2.body.events.length > 0);
    });

    describe('[RD02] Schema validation', function () {
      describe(
        '[RD03] when given an invalid username parameter',
        testInvalidParameterValidation(
          'username',
          {
            minLength: USERNAME_MIN_LENGTH,
            maxLength: USERNAME_MAX_LENGTH,
            lettersAndDashesOnly: true,
            type: 'string'
          },
          ['G81N', 'JQ7V', 'EIKE', 'XTD0', 'TSC6', 'TL2W', 'MST7', 'WG46', 'M6CD', '3Q1H']
        )
      );

      describe(
        '[RD04] when given an invalid password parameter',
        testInvalidParameterValidation(
          'password',
          {
            minLength: 4,
            maxLength: 100,
            type: 'string'
          },
          ['MP5F', 'T56V', 'XFG4', 'SBCX', 'LQWX', 'KJGF', 'OYZM', 'FSE9']
        )
      );

      describe(
        '[RD05] when given an invalid email parameter',
        testInvalidParameterValidation(
          'email', {
            maxLength: 300,
            type: 'string'
          },
          ['PJY5', '6SID', '6OX5', 'GV6I', '1JN8', 'S8U8']
        )
      );

      describe(
        '[RD06] when given an invalid appId parameter',
        testInvalidParameterValidation(
          'appId',
          {
            minLength: 6,
            maxLength: 99,
            type: 'string'
          },
          ['NZ4J', 'K4LE', '8G9V', '4XCV', 'HI9V', 'AQFL', 'I9QE', '5P2E']
        )
      );

      describe(
        '[RD07] when given an invalid invitationToken parameter',
        testInvalidParameterValidation(
          'invitationToken',
          {
            type: 'string'
          },
          ['FJ51', 'UEKC', '79A5', 'CYW6']
        )
      );

      describe(
        '[RD08] when given an invalid referer parameter',
        testInvalidParameterValidation(
          'referer',
          {
            maxLength: 99,
            type: 'string',
            allowNull: true
          },
          ['DUQN', 'VTN5', 'C4PK', 'AFUH', 'J1DW', 'V51E', '5BNJ']
        )
      );

      describe(
        '[RD09] when given an invalid language parameter',
        testInvalidParameterValidation(
          'language',
          {
            minLength: 1,
            maxLength: 5,
            type: 'string'
          },
          ['0QGW', 'RHT6', 'E95A', 'R1LT', 'LP4S', 'GDMW', 'QYT8', 'UPWY']
        )
      );
    });

    describe('[RD10] Property values uniqueness', function () {
      it('[LZ1K] should respond with status 409 and correct error for duplicate username/email', async function () {
        const registerData1ReuseUsername = generateRegisterBody();
        let res = await request.post('/users').send(registerData1ReuseUsername);
        assert.strictEqual(res.status, 201);

        const registerData1ReuseEmail = generateRegisterBody();
        res = await request.post('/users').send(registerData1ReuseEmail);
        assert.strictEqual(res.status, 201);

        // create a user with the same username and email from two other users
        const registerData = generateRegisterBody();
        registerData.username = registerData1ReuseUsername.username;
        registerData.email = registerData1ReuseEmail.email;
        res = await request.post('/users').send(registerData);

        assert.strictEqual(res.status, 409, '[LZ1K] should respond with status 409');
        assert.ok(res.error, '[M2HD] should have error');
        assert.ok(res.error.text, '[M2HD] should have error text');

        const error = JSON.parse(res.error.text);
        assert.deepEqual(error.error.data, { username: registerData.username, email: registerData.email }, '[M2HD] should respond with the correct error data');
      });
    });

    describe('[RD11] When providing an indexed value that is neither a number nor a string', () => {
      function generateInvalidBodyWith (incorrectValue) {
        return {
          username: 'regdi' + cuid.slug().toLowerCase(),
          password: charlatan.Lorem.characters(7),
          appId: charlatan.Lorem.characters(7),
          email: charlatan.Internet.email(),
          insurancenumber: incorrectValue
        };
      }

      it('[S6PS] must return an error when providing an object', async () => {
        const res = await request.post('/users').send(generateInvalidBodyWith({
          [charlatan.Lorem.characters(5)]: charlatan.Lorem.words(10).join(' ')
        }));
        assert.strictEqual(res.status, 400);
      });
    });

    function verifyInvalidInputResponse (
      registerBodyModification,
      expectedErrorParam,
      testTags
    ) {
      return () => {
        it(`[${testTags[0]}] should respond with status 400 and correct error message`, async function () {
          const invalidRegisterBody = Object.assign(
            {},
            generateRegisterBody(),
            registerBodyModification
          );
          const res = await request.post('/users').send(invalidRegisterBody);
          assert.strictEqual(res.status, 400, `[${testTags[0]}] should respond with status 400`);
          assert.ok(res.error, `[${testTags[1]}] should have error`);
          assert.ok(res.error.text, `[${testTags[1]}] should have error text`);
          const error = JSON.parse(res.error.text);
          assert.ok(error.error.data[0].param.includes(expectedErrorParam), `[${testTags[1]}] should respond with the correct error message`);
        });
      };
    }

    function testInvalidParameterValidation (parameterName, constraints, testTags) {
      return () => {
        if (constraints.minLength) {
          describe(
            `[${testTags.pop()}] that is too short`,
            verifyInvalidInputResponse(
              {
                [parameterName]: charlatan.Lorem.characters(
                  constraints.minLength - 1
                )
              },
              parameterName,
              [testTags.pop(), testTags.pop()]
            )
          );
        }
        if (constraints.maxLength) {
          describe(
            `[${testTags.pop()}] that is too long`,
            verifyInvalidInputResponse(
              {
                [parameterName]: charlatan.Lorem.characters(
                  constraints.maxLength + 1
                )
              },
              parameterName,
              [testTags.pop(), testTags.pop()]
            )
          );
        }
        if (constraints.lettersAndDashesOnly) {
          describe(
            `[${testTags.pop()}] that has invalid characters`,
            verifyInvalidInputResponse(
              {
                [parameterName]: "/#+]\\'"
              },
              parameterName,
              [testTags.pop(), testTags.pop()]
            )
          );
        }
        if (constraints.type) {
          let val;
          if (constraints.type === 'string') {
            val = true;
          }
          if (val) {
            describe(
              `[${testTags.pop()}] that has an invalid type`,
              verifyInvalidInputResponse(
                {
                  [parameterName]: val
                },
                parameterName,
                [testTags.pop(), testTags.pop()]
              )
            );
          }
        }
        if (!constraints.allowNull) {
          describe(
            `[${testTags.pop()}] that is null`,
            verifyInvalidInputResponse(
              {
                [parameterName]: null
              },
              parameterName,
              [testTags.pop(), testTags.pop()]
            )
          );
        }
      };
    }
  });

  describe('[RD12] GET /reg/:username/check', function () {
    const existingUsername = 'exist-' + cuid();
    before(async function () {
      await mongoFixtures.user(existingUsername);
    });

    function path (username) {
      return `/reg/${username}/check_username`;
    }

    it('[7T9L] when checking a valid available username, it should respond with status 200 and {reserved:false}', async () => {
      const res = await request.get(path('unexisting-username'));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.reserved, false);
    });

    it('[153Q] when checking a valid taken username, it should respond with status 200 and reserved:true', async () => {
      const res = await request.get(path(existingUsername));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.reserved, true);
    });

    it('[H09H] when checking a too short username, it should respond with status 400 and the correct error', async () => {
      const res = await request.get(path('a'.repeat(USERNAME_MIN_LENGTH - 1)));
      const body = res.body;
      assert.strictEqual(res.status, 400);
      assert.strictEqual(body.error.id, ErrorIds.InvalidParametersFormat);
      assert.ok(body.error.data[0].code.includes('username'));
    });

    it('[VFE1] when checking a too long username, it should respond with status 400 and the correct error', async () => {
      const res = await request.get(path('a'.repeat(USERNAME_MAX_LENGTH + 1)));

      const body = res.body;
      assert.strictEqual(res.status, 400);
      assert.strictEqual(body.error.id, ErrorIds.InvalidParametersFormat);
      assert.ok(body.error.data[0].code.includes('username'));
    });

    it('[FDTC] when checking a username with invalid characters, it should respond with status 400 and the correct error', async () => {
      const res = await request.get(path('abc:def'));

      const body = res.body;
      assert.strictEqual(res.status, 400);
      assert.strictEqual(body.error.id, ErrorIds.InvalidParametersFormat);
      assert.ok(body.error.data[0].code.includes('username'));
    });
  });
});
