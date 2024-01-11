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
const should = require('should');
const _ = require('lodash');
const async = require('async');
const fs = require('fs');
const os = require('os');
const request = require('superagent');
const timestamp = require('unix-timestamp');

require('./test-helpers');
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const validation = helpers.validation;
const ErrorIds = require('errors').ErrorIds;
const testData = helpers.data;
const { UserRepositoryOptions } = require('business/src/users');
const { getUserAccountStorage } = require('storage');
const encryption = require('utils').encryption;

describe('auth', function () {
  this.timeout(5000);
  let userAccountStorage;

  function apiPath (username) {
    return new URL(username, server.url).href;
  }

  function basePath (username) {
    return apiPath(username) + '/auth';
  }

  before(async function () {
    userAccountStorage = await getUserAccountStorage();
  });

  before(function (done) {
    async.series([
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      testData.resetUsers
    ], done);
  });

  afterEach(function (done) {
    helpers.dependencies.storage.sessions.clearAll(done);
  });

  const user = structuredClone(testData.users[0]);
  const trustedOrigin = 'http://test.pryv.local';
  const authData = {
    username: user.username,
    password: user.password,
    appId: 'pryv-test'
  };

  describe('/login', function () {
    function path (username) {
      return basePath(username) + '/login';
    }

    before(testData.resetAccesses);

    it('[2CV5] must authenticate the given credentials, open a session and return the access token', function (done) {
      async.series([
        function login (stepDone) {
          request
            .post(path(authData.username))
            .set('Origin', trustedOrigin)
            .send(authData)
            .end(function (err, res) {
              should.not.exist(err);
              assert.strictEqual(res.statusCode, 200);
              should.exist(res.body.token);
              should.exist(res.body.apiEndpoint);
              assert.include(res.body.apiEndpoint, res.body.token);
              checkNoUnwantedCookie(res);
              should.exist(res.body.preferredLanguage);
              assert.strictEqual(res.body.preferredLanguage, user.language);
              stepDone();
            });
        },
        function checkAccess (stepDone) {
          helpers.dependencies.storage.user.accesses.findOne(user, { name: authData.appId }, null, function (err, access) {
            should.not.exist(err);
            access.modifiedBy.should.eql(UserRepositoryOptions.SYSTEM_USER_ACCESS_ID);
            stepDone();
          });
        }
      ], done);
    });

    it('[68SH] must return expired', function (done) {
      let personalToken;
      async.series([
        function login (stepDone) {
          request
            .post(path(authData.username))
            .set('Origin', trustedOrigin)
            .send(authData)
            .end(function (err, res) {
              should.not.exist(err);
              personalToken = res.body.token;
              stepDone();
            });
        },
        function expireSession (stepDone) {
          helpers.dependencies.storage.sessions.expireNow(personalToken, function (err /* , session */) {
            stepDone(err);
          });
        },
        function shouldReturnSessionHasExpired (stepDone) {
          request
            .get(apiPath(authData.username) + '/access-info')
            .set('Origin', trustedOrigin)
            .set('Authorization', personalToken)
            .end(function (err, res) {
              should.exist(err);
              assert.strictEqual(res.statusCode, 403);
              assert.strictEqual(res.body.error.id, 'invalid-access-token');
              assert.strictEqual(res.body.error.message, 'Access session has expired.');
              stepDone();
            });
        }
      ], done);
    });

    it('[5UMP] must reuse the current session if already open', function (done) {
      let originalToken;
      async.series([
        function login (stepDone) {
          request
            .post(path(authData.username))
            .set('Origin', trustedOrigin)
            .send(authData)
            .end(function (err, res) {
              should.not.exist(err);
              assert.strictEqual(res.statusCode, 200);
              originalToken = res.body.token;
              stepDone();
            });
        },
        function loginAgain (stepDone) {
          request
            .post(path(authData.username))
            .set('Origin', trustedOrigin)
            .send(authData)
            .end(function (err, res) {
              should.not.exist(err);
              assert.strictEqual(res.statusCode, 200);
              assert.strictEqual(res.body.token, originalToken);
              assert.exists(res.body.apiEndpoint);
              assert.include(res.body.apiEndpoint, originalToken);
              stepDone();
            });
        }
      ], done);
    });

    it('[509A] must accept "wildcarded" app ids and origins', function (done) {
      request
        .post(path(authData.username))
        .set('Origin', 'https://test.rec.la:1234')
        .send(authData)
        .end(function (err, res) {
          should.not.exist(err);
          assert.strictEqual(res.statusCode, 200);
          done();
        });
    });

    it('[ADL4] must accept "no origin" (i.e. not a CORS request) if authorized', function (done) {
      const authDataNoCORS = Object.assign({}, authData, { appId: 'pryv-test-no-cors' });
      request
        .post(path(authDataNoCORS.username))
        .send(authDataNoCORS)
        .end(function (err, res) {
          should.not.exist(err);
          assert.strictEqual(res.statusCode, 200);
          done();
        });
    });

    it('[A7JL] must also accept "referer" in place of "origin" (e.g. some browsers do not provide "origin")', function (done) {
      request
        .post(path(authData.username))
        .set('Referer', trustedOrigin)
        .send(authData)
        .end(function (err, res) {
          should.not.exist(err);
          assert.strictEqual(res.statusCode, 200);
          done();
        });
    });

    it('[IKNM] must also accept "referer" in place of "origin" (e.g. some browsers do not provide "origin")', function (done) {
      request
        .post(path(authData.username))
        .set('Referer', trustedOrigin)
        .send(authData)
        .end(function (err, res) {
          should.not.exist(err);
          res.statusCode.should.eql(200);
          done();
        });
    });

    it('[1TI6] must not be case-sensitive for the username', function (done) {
      request
        .post(path(authData.username))
        .set('Origin', trustedOrigin)
        .send(Object.assign({}, authData, { username: authData.username.toUpperCase() }))
        .end(function (err, res) {
          should.not.exist(err);
          assert.strictEqual(res.statusCode, 200);
          done();
        });
    });

    it('[L7JQ] must return a correct error when the local credentials are missing or invalid', function (done) {
      const data = Object.assign({}, authData, {
        username: authData.username,
        password: 'bad-password'
      });
      request
        .post(path(data.username))
        .set('Origin', trustedOrigin)
        .send(data)
        .end(function (err, res) {
          should.exist(err);
          validation.checkError(res, {
            status: 401,
            id: ErrorIds.InvalidCredentials
          });
          should.not.exist(res.body.token);
          done();
        });
    });

    it('[4AQR] must return a correct error if the app id is missing or untrusted', function (done) {
      const data = Object.assign({}, authData, { appId: 'untrusted-app-id' });
      request
        .post(path(data.username))
        .set('Origin', trustedOrigin)
        .send(data)
        .end(function (err, res) {
          should.exist(err);
          validation.checkError(res, {
            status: 401,
            id: ErrorIds.InvalidCredentials
          });
          should.not.exist(res.body.token);
          done();
        });
    });

    it('[NDB0] must return a correct error if the origin is missing or does not match the app id', function (done) {
      request
        .post(path(authData.username))
        .set('Origin', 'http://mismatching.origin')
        .send(authData)
        .end(function (err, res) {
          should.exist(err);
          validation.checkError(res, {
            status: 401,
            id: ErrorIds.InvalidCredentials
          });
          should.not.exist(res.body.token);
          done();
        });
    });

    // concurrent requests
    it('[FMJH] must support concurrent login request, saving only the last token that is written in the storage', function (done) {
      const loginCount = 2;
      const randomId = 'pryv-test-' + Date.now();
      const accessStorage = helpers.dependencies.storage.user.accesses;
      async.times(loginCount, function (n, next) {
        request
          .post(path(authData.username))
          .set('Origin', 'https://test.rec.la:1234')
          .send({
            username: user.username,
            password: user.password,
            appId: randomId
          })
          .end(function (err, res) {
            if (err) { return next(err); }
            should(res.statusCode).be.equal(200);
            next(null, res.body.token);
          });
      }, function (err, results) {
        if (err) { return done(err); }
        const lastResult = results[1];
        accessStorage.findOne(user, { name: randomId, type: 'personal' }, null, (err, access) => {
          should.not.exist(err);
          should(access.token).be.equal(lastResult);
          done();
        });
      });
    });

    // cf. GH issue #57
    it('[9WHP] must not leak _private object from Result', function (done) {
      request
        .post(path(authData.username))
        .set('Origin', trustedOrigin)
        .send(authData)
        .end(function (err, res) {
          should.not.exist(err);
          assert.strictEqual(res.statusCode, 200);
          should.exist(res.body.token);
          checkNoUnwantedCookie(res);
          should.exist(res.body.preferredLanguage);
          assert.strictEqual(res.body.preferredLanguage, user.language);
          should.not.exist(res.body._private);
          done();
        });
    });

    // cf. GH issue #3
    describe('when we log into a temporary log file', function () {
      let logFilePath = '';

      beforeEach(function (done) {
        async.series([ensureLogFileIsEmpty, generateLogFile, instanciateServerWithLogs], done);
      });

      function ensureLogFileIsEmpty (stepDone) {
        if (logFilePath.length <= 0) { return stepDone(); }
        const truncateTo = 0; // default
        fs.truncate(logFilePath, truncateTo, function (err) {
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
        const settings = structuredClone(helpers.dependencies.settings);
        settings.logs = {
          file: {
            active: true,
            path: logFilePath,
            level: 'debug',
            maxsize: 500000,
            maxFiles: 50,
            json: false,
            rotation: {
              isActive: false
            }
          }
        };
        server.ensureStarted(settings, stepDone);
      }

      after(server.ensureStarted.bind(server, helpers.dependencies.settings));

      it('[C03J] must replace the password in the logs by (hidden) when an error occurs', function (done) {
        const wrongPasswordData = structuredClone(authData);
        wrongPasswordData.password = 'wrongPassword';
        async.series([
          function failLogin (stepDone) {
            request
              .post(path(authData.username))
              .set('Origin', trustedOrigin)
              .send(wrongPasswordData)
              .end(function (err, res) {
                should.exist(err);
                assert.strictEqual(res.statusCode, 401);
                stepDone();
              });
          },
          function givehalfSecondChance (stepDone) {
            setTimeout(stepDone, 500);
          },
          function verifyHiddenPasswordInLogs (stepDone) {
            fs.readFile(logFilePath, 'utf8', function (err, data) {
              if (err) {
                return stepDone(err);
              }
              assert.isAbove(data.length, 10, 'Issue in configuration, logfile is empty. >> ' + logFilePath);
              const passwordFound = data.indexOf(wrongPasswordData.password);
              const hiddenPasswordFound = data.indexOf('"password":"(hidden password)"');
              assert.equal(passwordFound, -1, 'password is present in logs when it should not. >> \n' + data);
              assert.isAtLeast(hiddenPasswordFound, 0, 'log with hidden password not found.. >> \n' + data);
              stepDone();
            });
          }
        ], done);
      });

      it('[G0YT] must not mention the password in the logs when none is provided', function (done) {
        const wrongPasswordData = structuredClone(authData);
        delete wrongPasswordData.password;
        async.series([
          function failLogin (stepDone) {
            request
              .post(path(authData.username))
              .set('Origin', trustedOrigin)
              .send(wrongPasswordData)
              .end(function (err, res) {
                should.exist(err);
                assert.strictEqual(res.statusCode, 400);
                stepDone();
              });
          },
          function verifyNoPasswordFieldInLogs (stepDone) {
            fs.readFile(logFilePath, 'utf8', function (err, data) {
              if (err) {
                return stepDone(err);
              }
              should(data.indexOf('password=')).be.equal(-1);
              stepDone();
            });
          }
        ], done);
      });
    });

    function checkNoUnwantedCookie (res) {
      if (!res.headers['set-cookie']) {
        return;
      }
      res.headers['set-cookie']
        .filter(function (cookieString) {
          return cookieString.indexOf('sso=') !== 0; // we only want the SSO cookie
        })
        .should.eql([]);
    }

    describe('[WPRA] When password rules are enabled', function () {
      const settings = _.merge(structuredClone(helpers.dependencies.settings), helpers.passwordRules.settingsOverride);
      const maxAge = helpers.passwordRules.settingsOverride.auth.passwordAgeMaxDays;
      const minAge = 1;

      before(async () => {
        await testData.resetUsers();
        settings.auth.passwordAgeMinDays = minAge;
        await server.ensureStartedAsync(settings);
      });

      after(async () => {
        // restore server with original config
        await server.ensureStartedAsync(helpers.dependencies.settings);
      });

      it('[675V] must succeed if the password is not yet expired, returning planned expiration time and possible change time', async function () {
        // setup current password with time not yet expired
        await userAccountStorage.clearHistory(user.id);
        const passwordHash = await encryption.hash(user.password);
        const passwordTime = timestamp.now(`-${maxAge - 1}d`);
        await userAccountStorage.addPasswordHash(user.id, passwordHash, 'test', passwordTime);
        const res = await request
          .post(path(authData.username))
          .set('Origin', trustedOrigin)
          .send(authData);
        assert.exists(res.body.passwordExpires);
        assert.approximately(res.body.passwordExpires, timestamp.add(passwordTime, `${maxAge}d`), 1000);
        assert.exists(res.body.passwordCanBeChanged);
        assert.approximately(res.body.passwordCanBeChanged, timestamp.add(passwordTime, `${minAge}d`), 1000);
      });

      // this test should be kept at the end of the describe as it impacts the configuration
      it('[D3EV] must return an error if the password has expired, indicating the date it did so', async function () {
        // setup current password with expired time
        await userAccountStorage.clearHistory(user.id);
        const passwordHash = await encryption.hash(user.password);
        const passwordTime = timestamp.now(`-${maxAge + 1}d`);
        await userAccountStorage.addPasswordHash(user.id, passwordHash, 'test', passwordTime);
        const res = await request
          .post(path(authData.username))
          .ok(() => true)
          .set('Origin', trustedOrigin)
          .send(authData);
        validation.checkError(res, {
          status: 401,
          id: ErrorIds.InvalidCredentials
        });
        const expectedExpirationTime = timestamp.add(passwordTime, `${maxAge}d`);
        assert.include(res.body.error.message, `Password expired since ${timestamp
                    .toDate(expectedExpirationTime)
                    .toISOString()}`);
        assert.deepEqual(res.body.error.data, {
          expiredTime: expectedExpirationTime
        });
      });
    });
  });

  describe('/logout', function () {
    function path (username) {
      return basePath(username) + '/logout';
    }

    it('[6W5M] must terminate the access session and fail to logout a second time (session already expired)', function (done) {
      let token;
      async.series([
        function (stepDone) {
          request
            .post(basePath(user.username) + '/login')
            .set('Origin', trustedOrigin)
            .send(authData)
            .end(function (err, res) {
              assert.notExists(err);
              token = res.body.token;
              if (typeof token !== 'string') {
                return stepDone(new Error('AF: not a string'));
              }
              stepDone();
            });
        },
        function (stepDone) {
          request
            .post(path(user.username))
            .send({})
            .set('authorization', token)
            .end(function (err, res) {
              assert.notExists(err);
              assert.strictEqual(res.statusCode, 200);
              stepDone();
            });
        },
        function (stepDone) {
          // Session was already closed
          // Trying to logout a second time should fail
          request
            .post(path(user.username))
            .send({})
            .set('authorization', token)
            .end(function (err, res) { // eslint-disable-line n/handle-callback-err
              validation.checkError(res, {
                status: 403,
                id: ErrorIds.InvalidAccessToken
              }, stepDone);
            });
        }
      ], done);
    });

    it('[E2MD] (or any request) must alternatively accept the access token in the query string', function (done) {
      const testRequest = helpers.request(server.url);
      async.series([
        testRequest.login.bind(testRequest, user),
        function (stepDone) {
          request
            .post(path(user.username))
            .query({ auth: testRequest.token })
            .send({})
            .end(function (err, res) {
              assert.notExists(err);
              assert.strictEqual(res.statusCode, 200);
              stepDone();
            });
        }
      ], done);
    });
  });

  describe('SSO support', function () {
    // WARNING: exceptionally, tests in here are interdependent and their sequence matters
    const persistentReq2 = request.agent();

    before(function (done) {
      persistentReq2
        .post(basePath(authData.username) + '/login')
        .set('Origin', trustedOrigin)
        .send(authData)
        .end(function () {
          done();
        });
    });

    it('[TIDW] GET /who-am-i must return a 410 as it has been removed', function (done) {
      persistentReq2
        .get(basePath(authData.username) + '/who-am-i')
        .end(function (err, res) { // eslint-disable-line n/handle-callback-err
          assert.strictEqual(res.statusCode, 410);
          done();
        });
    });
  });
});
