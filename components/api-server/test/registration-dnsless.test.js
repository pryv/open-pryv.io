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
const nock = require('nock');
const assert = require('chai').assert;
const supertest = require('supertest');
const charlatan = require('charlatan');
const bluebird = require('bluebird');
const cuid = require('cuid');

const { getApplication } = require('api-server/src/application');
const { getConfig } = require('@pryv/boiler');
const { getUsersRepository, User } = require('business/src/users');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection } = require('api-server/test/test-helpers');
const { pubsub } = require('messages');
const { USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH } = require('api-server/src/schema/helpers');
const ErrorIds = require('errors/src/ErrorIds');
const { ApiEndpoint } = require('utils');

describe('[BMM2] registration: DNS-less', () => {
  let config;
  let mongoFixtures;
  let app;
  let request;
  let res;

  before(async function () {
    nock.cleanAll();
    config = await getConfig();
    config.injectTestConfig({
      dnsLess: { isActive: true },
      openSource: { isActive: false },
      custom: { systemStreams: null }
    });
  });

  after(async function () {
    config.injectTestConfig({});
  });

  before(async function () {
    mongoFixtures = databaseFixture(await produceMongoConnection());
    app = getApplication(true);
    await app.initiate();

    await require('api-server/src/methods/auth/register')(app.api);

    // get events for a small test of valid token
    // Initialize notifyTests dependency
    const axonMsgs = [];
    const axonSocket = {
      emit: (...args) => axonMsgs.push(args)
    };
    pubsub.setTestNotifier(axonSocket);
    await require('api-server/src/methods/events')(app.api);

    request = supertest(app.expressApp);
  });

  describe('POST /users', () => {
    function generateRegisterBody () {
      return {
        username: charlatan.Lorem.characters(7),
        password: charlatan.Lorem.characters(7),
        email: charlatan.Internet.email(),
        appId: charlatan.Lorem.characters(7),
        insurancenumber: charlatan.Number.number(3),
        phoneNumber: charlatan.Number.number(3)
      };
    }

    describe('when given valid input', function () {
      let registerData;
      before(async function () {
        registerData = generateRegisterBody();
        nock(config.get('services:register:url')).put('/users', (body) => { return true; }).reply(200, { errors: [] });
        res = await request.post('/users').send(registerData);
      });
      it('[KB3T] should respond with status 201', function () {
        assert.equal(res.status, 201);
      });
      it('[VDA8] should respond with a username and apiEndpoint in the request body', async () => {
        assert.equal(res.body.username, registerData.username);
        const usersRepository = await getUsersRepository();
        const user = await usersRepository.getUserByUsername(registerData.username);
        const personalAccess = await bluebird.fromCallback(
          (cb) => app.storageLayer.accesses.findOne({ id: user.id }, {}, null, cb));
        const initUser = new User(user);
        assert.equal(res.body.apiEndpoint, ApiEndpoint.build(initUser.username, personalAccess.token));
      });
      it('[LPLP] Valid access token exists in the response', async function () {
        assert.exists(res.body.apiEndpoint);
        const token = res.body.apiEndpoint.split('//')[1].split('@')[0];

        // check that I can get events with this token
        const res2 = await request.get(`/${res.body.username}/events`)
          .set('authorization', token);
        assert.equal(res2.status, 200);
        assert.isTrue(res2.body.events.length > 0);
      });
      it('[M5XB] should store all the fields', function () {});
    });

    describe('Schema validation', function () {
      describe(
        'when given an invalid username parameter',
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
        'when given an invalid password parameter',
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
        'when given an invalid email parameter',
        testInvalidParameterValidation(
          'email', {
            maxLength: 300,
            type: 'string'
          },
          ['PJY5', '6SID', '6OX5', 'GV6I', '1JN8', 'S8U8']
        )
      );

      describe(
        'when given an invalid appId parameter',
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
        'when given an invalid invitationToken parameter',
        testInvalidParameterValidation(
          'invitationToken',
          {
            type: 'string'
          },
          ['FJ51', 'UEKC', '79A5', 'CYW6']
        )
      );

      describe(
        'when given an invalid referer parameter',
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
        'when given an invalid language parameter',
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

    describe('Property values uniqueness', function () {
      describe('username property', function () {
        let registerData;
        before(async function () {
          const registerData1ReuseUsername = generateRegisterBody();
          nock(config.get('services:register:url')).put('/users', (body) => { return true; }).reply(200, { errors: [] });
          res = await request.post('/users').send(registerData1ReuseUsername);
          assert.equal(res.status, 201);

          const registerData1ReuseEmail = generateRegisterBody();
          nock(config.get('services:register:url')).put('/users', (body) => { return true; }).reply(200, { errors: [] });
          res = await request.post('/users').send(registerData1ReuseEmail);
          assert.equal(res.status, 201);

          // create a user with the same username and email from two other users
          registerData = generateRegisterBody();
          registerData.username = registerData1ReuseUsername.username;
          registerData.email = registerData1ReuseEmail.email;
          nock(config.get('services:register:url')).put('/users', (body) => { return true; }).reply(200, { errors: [] });
          res = await request.post('/users').send(registerData);
        });
        it('[LZ1K] should respond with status 409', function () {
          assert.equal(res.status, 409);
        });
        it('[M2HD] should respond with the correct error message', function () {
          assert.exists(res.error);
          assert.exists(res.error.text);

          // changed to new error format to match the cluster
          const error = JSON.parse(res.error.text);
          assert.deepEqual(error.error.data, { username: registerData.username, email: registerData.email });
        });
      });
    });

    describe('When providing an indexed value that is neither a number nor a string', () => {
      function generateInvalidBodyWith (incorrectValue) {
        return {
          username: charlatan.Lorem.characters(7),
          password: charlatan.Lorem.characters(7),
          appId: charlatan.Lorem.characters(7),
          email: charlatan.Internet.email(),
          insurancenumber: incorrectValue
        };
      }

      describe('by providing an object', () => {
        it('[S6PS] must return an error', async () => {
          const res = await request.post('/users').send(generateInvalidBodyWith({
            [charlatan.Lorem.characters(5)]: charlatan.Lorem.words(10).join(' ')
          }));
          assert.equal(res.status, 400);
        });
      });
    });

    function verifyInvalidInputResponse (
      registerBodyModification,
      expectedErrorParam,
      testTags
    ) {
      return () => {
        before(async function () {
          const invalidRegisterBody = Object.assign(
            {},
            generateRegisterBody(),
            registerBodyModification
          );
          res = await request.post('/users').send(invalidRegisterBody);
        });
        it(`[${testTags[0]}] should respond with status 400`, function () {
          assert.equal(res.status, 400);
        });
        it(`[${testTags[1]}] should respond with the correct error message`, function () {
          assert.exists(res.error);
          assert.exists(res.error.text);
          const error = JSON.parse(res.error.text);
          assert.include(error.error.data[0].param, expectedErrorParam);
        });
      };
    }

    function testInvalidParameterValidation (parameterName, constraints, testTags) {
      return () => {
        if (constraints.minLength) {
          describe(
            'that is too short',
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
            'that is too long',
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
            'that has invalid characters',
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
              'that has an invalid type',
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
            'that is null',
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

  describe('GET /reg/:username/check', function () {
    const existingUsername = 'exist-' + cuid();
    before(async function () {
      await mongoFixtures.user(existingUsername);
    });

    function path (username) {
      return `/reg/${username}/check_username`;
    }

    it('[7T9L] when checking a valid available username, it should respond with status 200 and {reserved:false}', async () => {
      const res = await request.get(path('unexisting-username'));

      const body = res.body;
      assert.equal(res.status, 200);
      assert.isFalse(body.reserved);
    });

    it('[153Q] when checking a valid taken username, it should respond with status 409 and the correct error', async () => {
      const res = await request.get(path(existingUsername));

      const body = res.body;
      assert.equal(res.status, 409);
      assert.equal(body.error.id, ErrorIds.ItemAlreadyExists);
      assert.deepEqual(body.error.data, { username: existingUsername });
    });

    it('[H09H] when checking a too short username, it should respond with status 400 and the correct error', async () => {
      const res = await request.get(path('a'.repeat(USERNAME_MIN_LENGTH - 1)));

      const body = res.body;
      assert.equal(res.status, 400);
      assert.equal(body.error.id, ErrorIds.InvalidParametersFormat);
      assert.isTrue(body.error.data[0].code.includes('username'));
    });

    it('[VFE1] when checking a too long username, it should respond with status 400 and the correct error', async () => {
      const res = await request.get(path('a'.repeat(USERNAME_MAX_LENGTH + 1)));

      const body = res.body;
      assert.equal(res.status, 400);
      assert.equal(body.error.id, ErrorIds.InvalidParametersFormat);
      assert.isTrue(body.error.data[0].code.includes('username'));
    });

    it('[FDTC] when checking a username with invalid characters, it should respond with status 400 and the correct error', async () => {
      const res = await request.get(path('abc:def'));

      const body = res.body;
      assert.equal(res.status, 400);
      assert.equal(body.error.id, ErrorIds.InvalidParametersFormat);
      assert.isTrue(body.error.data[0].code.includes('username'));
    });
  });
});
