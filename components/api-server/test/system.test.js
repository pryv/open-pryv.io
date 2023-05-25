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
const async = require('async');
const should = require('should');
const request = require('superagent');
const timestamp = require('unix-timestamp');
const _ = require('lodash');
const assert = require('chai').assert;
const bluebird = require('bluebird');
const os = require('os');
const fs = require('fs');
const { setTimeout } = require('timers/promises');

require('./test-helpers');
const helpers = require('./helpers');
const ErrorIds = require('errors').ErrorIds;
const server = helpers.dependencies.instanceManager;
const methodsSchema = require('../src/schema/systemMethods');
const validation = helpers.validation;
const encryption = require('utils').encryption;
const testData = helpers.data;
const { getUsersRepository } = require('business/src/users');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection, context } = require('./test-helpers');
const charlatan = require('charlatan');
const cuid = require('cuid');
const { getConfig } = require('@pryv/boiler');

require('date-utils');

describe('[SYRO] system route', function () {
  let mongoFixtures;
  let username;
  let server;
  let config;

  before(async function () {
    config = await getConfig();
    mongoFixtures = databaseFixture(await produceMongoConnection());
    username = 'system-test';
    server = await context.spawn();
  });
  after(async () => {
    await mongoFixtures.clean();
    server.stop();
  });

  before(async () => {
    await mongoFixtures.user(username, {});
  });

  it('[JT1A] should parse correctly usernames starting with "system"', async () => {
    const res = await server.request().get('/' + username + '/events')
      .set('authorization', 'dummy');
    should.exist(res.body.error);
    res.body.error.id.should.eql('invalid-access-token');
  });

  it('[CHEK] System check Platform integrity ', async () => {
    const res = await request.get(new URL('/system/check-platform-integrity', server.url()).toString())
      .set('authorization', config.get('auth:adminAccessKey'));
    should.exists(res.body.checks);
    const checkLength = 2;
    should.equal(res.body.checks.length, checkLength);
    for (let i = 0; i < checkLength; i++) {
      const check = res.body.checks[i];
      should.exist(check.title);
      should.exist(check.infos);
      should.exist(check.errors);
      should.equal(check.errors.length, 0);
    }
  });

  describe('DELETE /mfa', () => {
    let username, mfaPath, profilePath, res, profileRes, token, restOfProfile;

    before(async () => {
      username = charlatan.Lorem.characters(10);
      token = cuid();
      mfaPath = `/system/users/${username}/mfa`;
      profilePath = `/${username}/profile/private`;
      restOfProfile = { restOfProfile: { something: '123' } };
      const user = await mongoFixtures.user(username);
      await user.access({
        type: 'personal',
        token
      });
      await user.session(token);
      await server.request()
        .put(profilePath)
        .set('authorization', token)
        .send({
          mfa: { content: { phone: '123' }, recoveryCodes: ['1', '2', '3'] },
          restOfProfile
        });
    });
    before(async () => {
      res = await server.request()
        .delete(mfaPath)
        .set('authorization', config.get('auth:adminAccessKey'));
      profileRes = await server.request().get(profilePath).set('authorization', token);
    });
    it('[1V4D] should return 204', () => {
      assert.equal(res.status, 204);
    });
    it('[3HE9] should delete the user\'s "mfa" profile property', async () => {
      assert.isUndefined(profileRes.body.profile.mfa);
    });
    it('[I2PU] should not delete anything else in the profile', () => {
      assert.deepEqual(profileRes.body.profile.restOfProfile, restOfProfile);
    });
  });
});

describe('[SYER] system (ex-register)', function () {
  let mongoFixtures;

  this.timeout(5000);
  function basePath () {
    return new URL('/system', server.url).toString();
  }

  before(async function () {
    mongoFixtures = databaseFixture(await produceMongoConnection());
    await mongoFixtures.context.cleanEverything();
  });

  beforeEach(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses
    ], done);
  });

  after(async function () {
    await mongoFixtures.context.cleanEverything();
  });
  // NOTE: because we mock the email sending service for user creation and to
  // keep test code simple, test order is important. The first test configures
  // the mock service in order to test email sending, the second one
  // reconfigures it so that it just replies OK for subsequent tests.
  // DEPRECATED: remove (along with all other references to `create-user`) after all reg servers updated
  describe('POST /create-user (DEPRECATED)', function () {
    function path () {
      return basePath() + '/create-user';
    }
    function post (data, callback) {
      return request.post(path())
        .set('authorization', helpers.dependencies.settings.auth.adminAccessKey)
        .send(data)
        .end(callback);
    }

    const newUserPassword = '1l0v3p0t1r0nZ';
    const newUserData = {
      username: 'mr-dupotager',
      passwordHash: encryption.hashSync(newUserPassword),
      email: 'dupotager@test.com',
      language: 'fr'
    };

    describe('when email sending really works', function () {
      before(async function () {
        await mongoFixtures.context.cleanEverything();
      });
      it('[FUTR] must create a new user with the sent data, sending a welcome email', async function () {
        const settings = _.cloneDeep(helpers.dependencies.settings);
        settings.services.email.enabled = {
          welcome: true
        };

        let mailSent = false;

        // setup mail server mock
        helpers.instanceTestSetup.set(settings, {
          context: settings.services.email,
          execute: function () {
            require('nock')(this.context.url)
              .post('')
              .reply(200, function (uri, body) {
                const assert = require('assert');
                assert.equal(body.message.global_merge_vars[0].content, 'mr-dupotager', 'mail server mock is expecting mr-dupotager');
                assert.match(body.template_name, /welcome/, 'mr-dupotager', 'mail server mock is expecting welcom in message body');
                this.context.testNotifier.emit('mail-sent1');
              }.bind(this));
          }
        });
        // fetch notification from server process
        server.once('mail-sent1', function () {
          mailSent = true;
        });
        await (new Promise(server.ensureStarted.bind(server, settings)));

        const usersRepository = await getUsersRepository();
        const originalUsers = await usersRepository.getAll();

        const originalCount = originalUsers.length;
        // create user
        const res = await bluebird.fromCallback(cb => post(newUserData, cb));
        validation.check(res, {
          status: 201,
          schema: methodsSchema.createUser.result
        });
        await setTimeout(1000);
        mailSent.should.eql(true);

        // getUpdatedUsers
        const users = await usersRepository.getAll(true);
        users.length.should.eql(originalCount + 1, 'users');

        const expected = _.cloneDeep(newUserData);
        expected.storageUsed = { dbDocuments: 0, attachedFiles: 0 };
        const actual = _.find(users, function (user) {
          return user.username === newUserData.username;
        });
        validation.checkStoredItem(actual.getAccountWithId(), 'user');
        // password hash is not retrieved with getAll
        delete expected.passwordHash;
        const account = actual.getReadableAccount();
        account.username = newUserData.username;
        account.should.eql(expected);
      });
    });

    it('[0G7C] must not send a welcome email if mailing is deactivated', function (done) {
      const settings = _.cloneDeep(helpers.dependencies.settings);
      settings.services.email.enabled = false;
      testWelcomeMailNotSent(settings, done);
    });
    it('[TWBF] must not send a welcome email if welcome mail is deactivated', function (done) {
      const settings = _.cloneDeep(helpers.dependencies.settings);
      settings.services.email.enabled = {
        welcome: false
      };
      testWelcomeMailNotSent(settings, done);
    });

    function testWelcomeMailNotSent (settings, callback) {
      // setup mail server mock
      helpers.instanceTestSetup.set(settings, {
        context: settings.services.email,
        execute: function () {
          require('nock')(this.context.url).post(this.context.sendMessagePath)
            .reply(200, function () {
              this.context.testNotifier.emit('mail-sent2');
            }.bind(this));
        }
      });

      // fetch notification from server process
      server.once('mail-sent2', function () {
        return callback(new Error('Welcome email should not be sent!'));
      });

      async.series([
        server.ensureStarted.bind(server, settings),
        function registerNewUser (stepDone) {
          const newUserDataExpected = Object.assign({}, newUserData);
          post(newUserDataExpected, function (err, res) {
            should.not.exists(err);
            validation.check(res, {
              status: 201,
              schema: methodsSchema.createUser.result
            });

            stepDone();
          });
        }
      ], callback);
    }

    describe('when it just replies OK', function () {
      before(server.ensureStarted.bind(server, helpers.dependencies.settings));

      it('[9K71] must run the process but not save anything for test username "recla"',
        async function () {
          const settings = _.cloneDeep(helpers.dependencies.settings);

          should(process.env.NODE_ENV).be.eql('test');

          // setup mail server mock, persisting over the next tests
          helpers.instanceTestSetup.set(settings, {
            context: settings.services.email,
            execute: function () {
              require('nock')(this.context.url).persist()
                .post(this.context.sendMessagePath)
                .reply(200);
            }
          });

          await (new Promise(server.ensureStarted.bind(server, settings)));

          const usersRepository = await getUsersRepository();
          const originalUsers = await usersRepository.getAll();
          const originalCount = originalUsers.length;

          // create user
          const data = {
            username: 'recla',
            passwordHash: encryption.hashSync('youpi'),
            email: 'recla@rec.la',
            language: 'fr'
          };
          const res = await bluebird.fromCallback(cb => post(data, cb));

          validation.check(res, {
            status: 201,
            schema: methodsSchema.createUser.result
          });
          const createdUserId = res.body.id;

          // getUpdatedUsers
          const users = await usersRepository.getAll();
          users.length.should.eql(originalCount, 'users');
          should.not.exist(_.find(users, { id: createdUserId }));
        });

      it('[ZG1L] must support the old "/register" path for backwards-compatibility', function (done) {
        const newUserDataExpected = Object.assign({}, newUserData);
        request.post(new URL('/register/create-user', server.url).toString())
          .set('authorization', helpers.dependencies.settings.auth.adminAccessKey)
          .send(newUserDataExpected)
          .end(function (err, res) {
            should.not.exists(err);
            validation.check(res, {
              status: 201
            }, done);
          });
      });

      it('[VGF5] must return a correct 400 error if the sent data is badly formatted', function (done) {
        // eslint-disable-next-line n/handle-callback-err
        post({ badProperty: 'bad value' }, function (err, res) {
          validation.checkErrorInvalidParams(res, done);
        });
      });

      it('[ABI5] must return a correct 400 error if the language property is above 5 characters', function (done) {
        const newUserDataExpected = Object.assign({}, newUserData);
        // eslint-disable-next-line n/handle-callback-err
        post(_.assignIn(newUserDataExpected, { language: 'abcdef' }), function (err, res) {
          validation.checkErrorInvalidParams(res, done);
        });
      });

      it('[OVI4] must return a correct 400 error if the language property is the empty string', function (done) {
        const newUserDataExpected = Object.assign({}, newUserData);
        // eslint-disable-next-line n/handle-callback-err
        post(_.assignIn(newUserDataExpected, { language: '' }), function (err, res) {
          validation.checkErrorInvalidParams(res, done);
        });
      });

      it('[RD10] must return a correct 400 error if a user with the same user name already exists',
        async function () {
          const data = {
            username: testData.users[0].username,
            passwordHash: '$-1s-b4d-f0r-U',
            email: 'roudoudou@choupinou.ch',
            language: 'fr'
          };
          try {
            await bluebird.fromCallback(cb => post(data, cb));
            throw new Error('The response should not be successful');
          } catch (err) {
            validation.checkError(err.response, {
              status: 409,
              id: ErrorIds.ItemAlreadyExists,
              data: { username: data.username }
            });
          }
        });

      it('[NPJE] must return a correct 400 error if a user with the same email address already exists', async () => {
        const existingUser = await mongoFixtures.user(charlatan.Lorem.characters(10));
        const data = {
          username: charlatan.Lorem.characters(10),
          passwordHash: '$-1s-b4d-f0r-U',
          email: existingUser.attrs.email,
          language: 'fr'
        };

        try {
          await bluebird.fromCallback(
            (cb) => post(data, cb));
          assert.isTrue(false);
        } catch (err) {
          assert.equal(err.response.status, 409);
          assert.equal(err.response.body.error.id, ErrorIds.ItemAlreadyExists);
          assert.deepEqual(err.response.body.error.data, { email: data.email });
        }
      });

      it('[Y5JB] must return a correct 404 error when authentication is invalid', function (done) {
        const newUserDataExpected = Object.assign({}, newUserData);
        request
          .post(path())
          .set('authorization', 'bad-key').send(newUserDataExpected)
          // eslint-disable-next-line n/handle-callback-err
          .end(function (err, res) {
            validation.checkError(res, {
              status: 404,
              id: ErrorIds.UnknownResource
            }, done);
          });
      });

      it('[GF3L] must return a correct error if the content type is wrong', function (done) {
        request.post(path())
          .set('authorization', helpers.dependencies.settings.auth.adminAccessKey)
          .set('Content-Type', 'application/Jssdlfkjslkjfon') // <-- case error
          // eslint-disable-next-line n/handle-callback-err
          .end(function (err, res) {
            validation.checkError(res, {
              status: 415,
              id: ErrorIds.UnsupportedContentType
            }, done);
          });
      });
    });

    describe('when we log into a temporary log file', function () {
      let logFilePath = '';

      beforeEach(function (done) {
        async.series([
          ensureLogFileIsEmpty,
          generateLogFile,
          instanciateServerWithLogs
        ], done);
      });

      function ensureLogFileIsEmpty (stepDone) {
        if (logFilePath.length <= 0) return stepDone();
        fs.truncate(logFilePath, function (err) {
          if (err && err.code === 'ENOENT') {
            return stepDone();
          } // ignore error if file doesn't exist
          stepDone(err);
        });
      }

      function generateLogFile (stepDone) {
        logFilePath = os.tmpdir() + '/password-logs.log';
        stepDone();
      }

      function instanciateServerWithLogs (stepDone) {
        const settings = _.cloneDeep(helpers.dependencies.settings);
        settings.logs = {
          file: {
            active: true,
            path: logFilePath,
            level: 'debug',
            maxsize: 500000,
            maxFiles: 50,
            json: false
          }
        };
        server.ensureStarted(settings, stepDone);
      }

      after(server.ensureStarted.bind(server, helpers.dependencies.settings));

      // cf. GH issue #64
      it('[Y69B] must replace the passwordHash in the logs by (hidden) when the authentication is invalid', function (done) {
        const newUserDataExpected = Object.assign({}, newUserData);
        async.series([
          function failCreateUser (stepDone) {
            request.post(path()).set('authorization', 'bad-key').send(newUserDataExpected)
              // eslint-disable-next-line n/handle-callback-err
              .end(function (err, res) {
                validation.checkError(res, {
                  status: 404,
                  id: ErrorIds.UnknownResource
                }, stepDone);
              });
          },
          verifyHiddenPasswordHashInLogs
        ], done);
      });

      // cf. GH issue #64 too
      it('[MEJ9] must replace the passwordHash in the logs by (hidden) when the payload is invalid (here parameters)', function (done) {
        const newUserDataExpected = Object.assign({}, newUserData);
        async.series([
          function failCreateUser (stepDone) {
            // eslint-disable-next-line n/handle-callback-err
            post(_.extend({ invalidParam: 'yolo' }, newUserDataExpected), function (err, res) {
              validation.checkError(res, {
                status: 400,
                id: ErrorIds.InvalidParametersFormat
              }, stepDone);
            });
          },
          verifyHiddenPasswordHashInLogs
        ], done);
      });

      it('[CO6H] must not mention the passwordHash in the logs when none is provided', function (done) {
        const newUserDataExpected = Object.assign({}, newUserData);
        async.series([
          function failCreateUser (stepDone) {
            const dataWithNoPasswordHash = _.cloneDeep(newUserDataExpected);
            delete dataWithNoPasswordHash.passwordHash;

            // eslint-disable-next-line n/handle-callback-err
            post(dataWithNoPasswordHash, function (err, res) {
              validation.checkError(res, {
                status: 400,
                id: ErrorIds.InvalidParametersFormat
              }, stepDone);
            });
          },
          verifyNoPasswordHashFieldInLogs
        ], done);
      });

      function verifyHiddenPasswordHashInLogs (callback) {
        const newUserDataExpected = Object.assign({}, newUserData);
        fs.readFile(logFilePath, 'utf8', function (err, data) {
          if (err) {
            return callback(err);
          }
          should(data.indexOf(newUserDataExpected.passwordHash)).be.equal(-1);
          if (/passwordHash/.test(data)) { should(data.indexOf('(hidden password)')).be.aboveOrEqual(0); }
          callback();
        });
      }

      function verifyNoPasswordHashFieldInLogs (callback) {
        fs.readFile(logFilePath, 'utf8', function (err, data) {
          if (err) {
            return callback(err);
          }
          should(data.indexOf('passwordHash=')).be.equal(-1);
          callback();
        });
      }
    });
  });

  describe('GET /user-info/{username}', function () {
    const user = Object.assign({}, testData.users[0]);
    function path (username) {
      return basePath() + '/user-info/' + username;
    }

    before(server.ensureStarted.bind(server, helpers.dependencies.settings));

    it('[9C1A] trackingFunctions must return user information (including time of last account use)', function (done) {
      let originalInfo,
        expectedTime;
      async.series([
        function getInitialInfo (stepDone) {
          request.get(path(user.username))
            .set('authorization', helpers.dependencies.settings.auth.adminAccessKey)
            .end(function (err, res) {
              should.not.exists(err);
              validation.check(res, {
                status: 200,
                schema: methodsSchema.getUserInfo.result
              });
              originalInfo = res.body.userInfo;
              stepDone();
            });
        },
        function makeUserRequest1 (stepDone) {
          request.get(new URL('/' + user.username + '/events', server.url).toString())
            .set('authorization', testData.accesses[4].token)
            .end(function (err) {
              stepDone(err);
            });
        },
        function makeUserRequest2 (stepDone) {
          request.get(new URL('/' + user.username + '/events', server.url).toString())
            .set('authorization', testData.accesses[1].token)
            .end(function (err) {
              expectedTime = timestamp.now();
              stepDone(err);
            });
        },
        function getUpdatedInfo (stepDone) {
          request.get(path(user.username))
            .set('authorization', helpers.dependencies.settings.auth.adminAccessKey)
            .end(function (err, res) {
              should.not.exists(err);
              const info = res.body.userInfo;

              assert.approximately(info.lastAccess, expectedTime, 2);

              info.callsTotal
                .should.eql(originalInfo.callsTotal + 2,
                  'calls total');
              info.callsDetail['events:get']
                .should.eql(originalInfo.callsDetail['events:get'] + 2,
                  'calls detail');

              const accessKey1 = testData.accesses[4].name; // app access
              const accessKey2 = 'shared'; // shared access

              info.callsPerAccess[accessKey1]
                .should.eql(originalInfo.callsPerAccess[accessKey1] + 1,
                  'calls per access (personal)');
              info.callsPerAccess[accessKey2]
                .should.eql(originalInfo.callsPerAccess[accessKey2] + 1,
                  'calls per access (shared)');

              stepDone();
            });
        }
      ], done);
    });

    it('[FNJ5] must return a correct 404 error when authentication is invalid', function (done) {
      // eslint-disable-next-line n/handle-callback-err
      request.get(path(user.username)).set('authorization', 'bad-key').end(function (err, res) {
        validation.checkError(res, {
          status: 404,
          id: ErrorIds.UnknownResource
        }, done);
      });
    });
  });
});
