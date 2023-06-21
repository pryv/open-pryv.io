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

const assert = require('chai').assert;
const should = require('should');
const _ = require('lodash');
const async = require('async');
const bluebird = require('bluebird');
const fs = require('fs');
const timestamp = require('unix-timestamp');

require('./test-helpers');
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const ErrorIds = require('errors').ErrorIds;
const validation = helpers.validation;
const methodsSchema = require('../src/schema/accountMethods');
const pwdResetReqsStorage = helpers.dependencies.storage.passwordResetRequests;
const storageSize = helpers.dependencies.storage.size;
const testData = helpers.data;
const { getUsersRepository } = require('business/src/users');
const { getUserAccountStorage } = require('storage');
const { getConfig } = require('@pryv/boiler');
const encryption = require('utils').encryption;

let isOpenSource = false;

describe('[ACCO] account', function () {
  const user = structuredClone(testData.users[0]);
  let usersRepository = null;
  let userAccountStorage = null;

  before(async () => {
    const config = await getConfig();
    isOpenSource = config.get('openSource:isActive');
    usersRepository = await getUsersRepository();
    userAccountStorage = await getUserAccountStorage();
  });

  const basePath = '/' + user.username + '/account';
  let request = null; // must be set after server instance started

  // to verify data change notifications
  let accountNotifCount;
  server.on('axon-account-changed', function () { accountNotifCount++; });

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetEvents,
      testData.resetProfile,
      testData.resetFollowedSlices,

      testData.resetStreams,
      testData.resetAttachments,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      }
    ], done);
  });

  describe('GET /', function () {
    beforeEach(async () => { await resetUsers(); });

    it('[PHSB] must return the user\'s account details', function (done) {
      request.get(basePath).end(function (res) {
        const expected = structuredClone(user);
        delete expected.id;
        delete expected.password;
        delete expected.storageUsed;
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          body: { account: expected },
          sanitizeFn: cleanUpDetails,
          sanitizeTarget: 'account'
        }, done);
      });
    });

    it('[K5EI] must be forbidden to non-personal accesses', function (done) {
      request.get(basePath, testData.accesses[4].token).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });
  });

  describe('PUT /', function () {
    beforeEach(async () => { await resetUsers(); });

    it('[0PPV] must modify account details with the sent data, notifying register if e-mail changed',
      function (done) {
        const settings = structuredClone(helpers.dependencies.settings);
        settings.testsSkipForwardToRegister = false;
        const updatedData = {
          email: 'userzero.new@test.com',
          language: 'zh'
        };

        // setup registration server mock
        let regServerCalled = false;
        helpers.instanceTestSetup.set(settings, {
          context: Object.assign({}, settings.services.register, { username: user.username }),
          execute: function () {
            const scope = require('nock')(this.context.url);
            scope.put('/users')
              .matchHeader('Authorization', this.context.key)
              .reply(200, function (uri, requestBody) {
                this.context.testNotifier.emit('reg-server-called', requestBody);
              }.bind(this));
          }
        });

        // fetch service call data from server process
        server.on('reg-server-called', function (sentData) {
          sentData.should.eql({
            fieldsToDelete: {},
            user: {
              email: [
                {
                  creation: false,
                  isActive: true,
                  isUnique: true,
                  value: updatedData.email
                }],
              language: [
                {
                  creation: false,
                  isActive: true,
                  isUnique: false,
                  value: updatedData.language
                }
              ]
            },
            username: user.username
          });
          regServerCalled = true;
        });

        async.series([
          server.ensureStarted.bind(server, settings),
          function update (stepDone) {
            request.put(basePath).send(updatedData).end(function (res) {
              if (!isOpenSource) { // no notification in openSource
                assert.isOk(regServerCalled);
              }
              const expected = Object.assign({}, user, updatedData);
              delete expected.id;
              delete expected.password;
              delete expected.storageUsed;

              validation.check(res, {
                status: 200,
                schema: methodsSchema.update.result,
                body: { account: expected },
                sanitizeFn: cleanUpDetails,
                sanitizeTarget: 'account'
              });
              accountNotifCount.should.eql(1, 'account notifications');
              stepDone();
            });
          },
          async function verifyData () {
            const retrievedUser = await usersRepository.getUserByUsername(user.username);
            validation.checkStoredItem(retrievedUser.getAccountWithId(), 'user');
          }
        ], done);
      });

    it('[AT0V] must return a correct error if the sent data is badly formatted', function (done) {
      request.put(basePath).send({ badProperty: 'bad value' }).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

    it('[NZE2] must be forbidden to non-personal accesses', function (done) {
      request
        .put(basePath, testData.accesses[4].token)
        .send({ language: 'zh' }).end(function (res) {
          validation.checkErrorForbidden(res, done);
        });
    });
  });

  let filesystemBlockSize = 1024;

  function getFilesystemBlockSize (done) {
    const testFilePath = './file_test.txt';
    const testValue = '0';
    fs.writeFile(testFilePath, testValue, (err) => {
      if (err) throw err;

      fs.stat(testFilePath, (err, status) => {
        if (err) throw err;
        filesystemBlockSize = status.blksize;

        fs.unlink(testFilePath, (err) => {
          if (err) throw err;

          done();
        });
      });
    });
  }

  describe('storage space monitoring', function () {
    before(function (done) {
      async.series([
        testData.resetUsers,
        testData.resetAccesses,
        testData.resetEvents,
        testData.resetProfile,
        testData.resetFollowedSlices,

        testData.resetStreams,
        testData.resetAttachments,
        server.ensureStarted.bind(server, helpers.dependencies.settings),
        function (stepDone) {
          request = helpers.request(server.url);
          request.login(user, stepDone);
        }
      ], done);
    });
    before(getFilesystemBlockSize);

    // when checking files storage size we allow a small 1k error margin to account for folder sizes

    // tests the computation of user storage size which is used from different API methods
    // (so we're not directly testing an API method here)
    it('[NFJQ] must properly compute used storage size for a given user when called', async () => {
      const newAtt = testData.attachments.image;

      let storageUsed = await storageSize.computeForUser(user);
      assert.isAbove(storageUsed.dbDocuments, 0);

      const expectedAttsSize = _.reduce(testData.events, function (total, evt) {
        return total + getTotalAttachmentsSize(evt);
      }, 0);

      // On Ubuntu with ext4 FileSystem the size difference is 4k, not 1k. I still dunno why.
      assert.approximately(storageUsed.attachedFiles, expectedAttsSize, filesystemBlockSize);
      const initialStorageUsed = storageUsed;

      await bluebird.fromCallback(cb => addEventWithAttachment(newAtt, cb));
      storageUsed = await storageSize.computeForUser(user);

      // hard to know what the exact difference should be, so we just expect it's bigger
      assert.isAbove(storageUsed.dbDocuments, initialStorageUsed.dbDocuments);
      assert.approximately(storageUsed.attachedFiles, initialStorageUsed.attachedFiles +
        newAtt.size, filesystemBlockSize);
      const updatedStorageUsed = storageUsed;
      const retrievedUser = await usersRepository.getUserById(user.id);
      assert.deepEqual(retrievedUser.storageUsed, updatedStorageUsed);
    });

    // test nightly job script
    it('[Y445] must properly compute storage size for all users in nightly script', async function () {
      const newAtt = testData.attachments.image;
      const execSync = require('child_process').execSync;

      // Initial nightly task
      execSync('node ./bin/nightly');

      // Verify initial storage usage
      const initialStorageUsed = await storageSize.computeForUser(user);
      initialStorageUsed.attachedFiles.should.be.above(0);

      // Add an attachment
      await bluebird.fromCallback(
        (cb) => addEventWithAttachment(newAtt, cb));

      // Another nightly task
      execSync('node ./bin/nightly');

      // Verify updated storage usage
      const updatedStorageUsed = await storageSize.computeForUser(user);

      updatedStorageUsed.dbDocuments.should.be.above(initialStorageUsed.dbDocuments);
      updatedStorageUsed.attachedFiles.should.be.approximately(
        initialStorageUsed.attachedFiles + newAtt.size, filesystemBlockSize);
    });

    function addEventWithAttachment (attachment, callback) {
      request.post('/' + user.username + '/events')
        .field('event', JSON.stringify({ type: 'test/i', streamId: testData.streams[0].id }))
        .attach('image', attachment.path, attachment.filename)
        .end(function (res) {
          validation.check(res, { status: 201 });
          callback();
        });
    }

    it('[0QVH] must be approximately updated (diff) when adding an attached file', function (done) {
      let initialStorageUsed;
      const newAtt = testData.attachments.image;
      async.series([
        async function checkInitial () {
          const retrievedUser = await usersRepository.getUserById(user.id);
          initialStorageUsed = retrievedUser.storageUsed;
        },
        function addAttachment (stepDone) {
          request.post('/' + user.username + '/events/' + testData.events[0].id)
            .attach('image', newAtt.path, newAtt.filename)
            .end(function (res) {
              validation.check(res, { status: 200 });
              stepDone();
            });
        },
        async function checkUpdated () {
          const retrievedUser = await usersRepository.getUserById(user.id);
          initialStorageUsed = retrievedUser.storageUsed;
          retrievedUser.storageUsed.dbDocuments.should.eql(initialStorageUsed.dbDocuments);
          retrievedUser.storageUsed.attachedFiles.should.be.approximately(
            initialStorageUsed.attachedFiles + newAtt.size, filesystemBlockSize);
        }
      ], done);
    });

    it('[93AP] must be approximately updated (diff) when deleting an attached file', async function () {
      const deletedAtt = testData.events[0].attachments[0];
      const initialStorageUsed = await storageSize.computeForUser(user);

      const path = '/' + user.username + '/events/' + testData.events[0].id + '/' +
        deletedAtt.id;
      try {
        await request.del(path);
      } catch (e) {
        // not an error, but the callback returns the response in 1st position
        // either we do the request with superagent, or we update request()
      }

      const updatedStoragedUsed = await storageSize.computeForUser(user);
      assert.equal(updatedStoragedUsed.dbDocuments, initialStorageUsed.dbDocuments);
      assert.approximately(updatedStoragedUsed.attachedFiles,
        initialStorageUsed.attachedFiles - deletedAtt.size,
        filesystemBlockSize);
    });

    it('[5WO0] must be approximately updated (diff) when deleting an event', async function () {
      const deletedEvt = testData.events[2];
      const deletedEvtPath = '/' + user.username + '/events/' + deletedEvt.id;
      const initialStorageUsed = await storageSize.computeForUser(user);
      try {
        await request.del(deletedEvtPath);
      } catch (e) {}
      try {
        await request.del(deletedEvtPath);
      } catch (e) {}

      const updatedStoragedUsed = await storageSize.computeForUser(user);
      assert.equal(updatedStoragedUsed.dbDocuments, initialStorageUsed.dbDocuments);
      assert.approximately(updatedStoragedUsed.attachedFiles,
        initialStorageUsed.attachedFiles - getTotalAttachmentsSize(deletedEvt),
        filesystemBlockSize);
    });

    function getTotalAttachmentsSize (event) {
      if (!event.attachments) {
        return 0;
      }
      return _.reduce(event.attachments, function (evtTotal, att) {
        return evtTotal + att.size;
      }, 0);
    }
  });

  describe('/change-password', function () {
    before(async () => { await resetUsers(); });

    const path = basePath + '/change-password';

    it('[6041] must change the password to the given value', function (done) {
      const data = {
        oldPassword: user.password,
        newPassword: 'Dr0ws$4p'
      };
      async.series([
        function changePassword (stepDone) {
          request.post(path).send(data).end(function (res) {
            validation.check(res, {
              status: 200,
              schema: methodsSchema.changePassword.result
            });
            accountNotifCount.should.eql(1, 'account notifications');
            stepDone();
          });
        },
        function verifyNewPassword (stepDone) {
          request.login(Object.assign({}, user, { password: data.newPassword }), stepDone);
        },
        async function checkPasswordInHistory () {
          assert.isTrue(await userAccountStorage.passwordExistsInHistory(user.id, data.oldPassword, 2), 'missing previous password in history');
          assert.isTrue(await userAccountStorage.passwordExistsInHistory(user.id, data.newPassword, 1), 'missing new password in history');
        }
      ], done);
    });

    it('[STWH] must return an error if the given old password does not match', function (done) {
      const data = {
        oldPassword: 'bad-password',
        newPassword: 'Dr0ws$4p'
      };
      request.post(path).send(data).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidOperation
        }, done);
      });
    });

    it('[8I1N] must return a correct error if the sent data is badly formatted', function (done) {
      request.post(path).send({ badProperty: 'bad value' }).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

    it('[J5VH] must be forbidden to non-personal accesses', function (done) {
      request.post(path, testData.accesses[4].token).send({ some: 'data' }).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    describe('[APWD] When password rules are enabled', function () {
      const settings = _.merge(structuredClone(helpers.dependencies.settings), helpers.passwordRules.settingsOverride);
      const baseData = { oldPassword: user.password };

      before(async () => {
        await resetUsers();
        await server.ensureStartedAsync(settings);
      });

      describe('Complexity rules:', function () {
        it('[1YPT] must return an error if the new password is too short', async () => {
          const data = Object.assign({}, baseData, { newPassword: helpers.passwordRules.passwords.badTooShort });
          const res = await request.post(path).send(data);
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidParametersFormat
          });
          assert.match(res.body.error.message, /characters long/);
        });

        it('[352R] must accept the new password if it is long enough', async () => {
          const data = Object.assign({}, baseData, { newPassword: helpers.passwordRules.passwords.good3CharCats });
          const res = await request.post(path).send(data);
          validation.check(res, {
            status: 200
          });
          baseData.oldPassword = data.newPassword;
        });

        it('[663A] must return an error if the new password does not contains characters from enough categories', async () => {
          const data = Object.assign({}, baseData, { newPassword: helpers.passwordRules.passwords.bad2CharCats });
          const res = await request.post(path).send(data);
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidParametersFormat
          });
          assert.match(res.body.error.message, /categories/);
        });

        it('[OY2G] must accept the new password if it contains characters from enough categories', async () => {
          // also tests checking for all 4 categories
          await server.ensureStartedAsync(_.merge(structuredClone(settings), { auth: { passwordComplexityMinCharCategories: 4 } }));
          const data = Object.assign({}, baseData, { newPassword: helpers.passwordRules.passwords.good4CharCats });
          const res = await request.post(path).send(data);
          validation.check(res, {
            status: 200
          });
          baseData.oldPassword = data.newPassword;
        });
      });

      describe('Reuse rules:', function () {
        it('[AFX4] must return an error if the new password is found in the N last passwords used', async () => {
          const passwordsHistory = await setupPasswordHistory(settings.auth.passwordPreventReuseHistoryLength);
          const data = Object.assign({}, baseData, { newPassword: passwordsHistory[0] });
          const res = await request.post(path).send(data);
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidOperation
          });
          assert.match(res.body.error.message, /last used/);
        });

        it('[6XXP] must accept the new password if different from the N last passwords used', async () => {
          const passwordsHistory = await setupPasswordHistory(settings.auth.passwordPreventReuseHistoryLength + 1);
          const data = Object.assign({}, baseData, { newPassword: passwordsHistory[0] });
          const res = await request.post(path).send(data);
          validation.check(res, {
            status: 200
          });
          baseData.oldPassword = data.newPassword;
        });

        async function setupPasswordHistory (historyLength) {
          const passwordsHistory = [];
          for (let n = historyLength; n >= 1; n--) {
            const pwd = `${helpers.passwordRules.passwords.good4CharCats}-${n}`;
            const res = await request.post(path).send(Object.assign({}, baseData, { newPassword: pwd }));
            validation.check(res, { status: 200 });
            passwordsHistory.push(pwd);
            baseData.oldPassword = pwd;
          }
          return passwordsHistory;
        }
      });

      describe('Age rules:', function () {
        const passwordAgeSettings = _.merge(structuredClone(settings), { auth: { passwordAgeMinDays: 1 } });

        it('[J4O6] must return an error if the current password’s age is below the set minimum', async () => {
          await server.ensureStartedAsync(passwordAgeSettings);

          // setup current password with time less than 1d ago
          await userAccountStorage.clearHistory(user.id);
          const passwordHash = await encryption.hash(baseData.oldPassword);
          await userAccountStorage.addPasswordHash(user.id, passwordHash, 'test', timestamp.now('-23h'));

          // try and change
          const data = Object.assign({}, baseData, { newPassword: helpers.passwordRules.passwords.good4CharCats });
          const res = await request.post(path).send(data);
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidOperation
          });
          assert.match(res.body.error.message, /day\(s\) ago/);
        });

        it('[RGGN] must accept the new password if the current one’s age is greater than the set minimum', async () => {
          await server.ensureStartedAsync(passwordAgeSettings);

          // setup current password with time more than 1d ago
          await userAccountStorage.clearHistory(user.id);
          const passwordHash = await encryption.hash(baseData.oldPassword);
          await userAccountStorage.addPasswordHash(user.id, passwordHash, 'test', timestamp.now('-25h'));

          // try and change
          const data = Object.assign({}, baseData, { newPassword: helpers.passwordRules.passwords.good4CharCats });
          const res = await request.post(path).send(data);
          validation.check(res, {
            status: 200
          });
          baseData.oldPassword = data.newPassword;
        });
      });
    });
  });

  describe('/request-password-reset and /reset-password', function () {
    beforeEach(async () => {
      await resetUsers;
      server.removeAllListeners('password-reset-token');
    });

    const requestPath = basePath + '/request-password-reset';
    const resetPath = basePath + '/reset-password';
    const authData = { appId: 'pryv-test' };

    it('[G1VN] "request" must trigger an email with a reset token, store that token, ' +
       'then "reset" must reset the password to the given value', function (done) {
      const settings = structuredClone(helpers.dependencies.settings);
      let resetToken;
      const newPassword = 'Dr0ws$4p';

      settings.services.email.enabled = true;

      // setup mail server mock

      helpers.instanceTestSetup.set(settings, {
        context: settings.services.email,
        execute: function () {
          require('nock')(this.context.url).post('')
            .reply(200, function (uri, body) {
              const token = body.message.global_merge_vars[0].content; // HACK, assume structure
              this.context.testNotifier.emit('password-reset-token', token);
            }.bind(this));
        }
      });
      // fetch reset token from server process
      server.on('password-reset-token', function (token) {
        resetToken = token;
      });

      async.series([
        server.ensureStarted.bind(server, settings),
        function requestReset (stepDone) {
          request.post(requestPath)
            .unset('authorization')
            .set('Origin', 'http://test.pryv.local')
            .send(authData)
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.requestPasswordReset.result
              }, stepDone);
            });
        },
        function verifyStoredRequest (stepDone) {
          assert.exists(resetToken);
          pwdResetReqsStorage.get(
            resetToken,
            user.username,
            function (err, resetReq) {
              assert.notExists(err);
              assert.exists(resetReq);
              should(resetReq._id).be.equal(resetToken);
              should(resetReq.username).be.equal(user.username);
              stepDone();
            }
          );
        },
        function doReset (stepDone) {
          const data = Object.assign({}, authData, {
            resetToken,
            newPassword
          });
          request.post(resetPath).send(data)
            .unset('authorization')
            .set('Origin', 'http://test.pryv.local')
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.resetPassword.result
              }, stepDone);
            });
        },
        function verifyNewPassword (stepDone) {
          request.login(Object.assign({}, user, { password: newPassword }), stepDone);
        }
      ], done);
    });

    it('[HV0V] must not trigger a reset email if mailing is deactivated', function (done) {
      const settings = structuredClone(helpers.dependencies.settings);
      settings.services.email.enabled = false;
      testResetMailNotSent(settings, done);
    });

    it('[VZ1W] must not trigger a reset email if reset mail is deactivated', function (done) {
      const settings = structuredClone(helpers.dependencies.settings);
      settings.services.email.enabled = {
        resetPassword: false
      };
      testResetMailNotSent(settings, done);
    });

    function testResetMailNotSent (settings, callback) {
      let mailSent = false;

      // setup mail server mock
      helpers.instanceTestSetup.set(settings, {
        context: settings.services.email.mandrill,
        execute: function () {
          require('nock')(this.context.url).post(this.context.sendMessagePath)
            .reply(200, function () {
              this.context.testNotifier.emit('password-reset-token');
            }.bind(this));
        }
      });
      // fetch reset token from server process
      server.on('password-reset-token', function () {
        mailSent = true;
        return callback(new Error('Reset email should not be sent!'));
      });

      async.series([
        server.ensureStarted.bind(server, settings),
        function requestReset (stepDone) {
          request.post(requestPath)
            .unset('authorization')
            .set('Origin', 'http://test.pryv.local')
            .send(authData)
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.requestPasswordReset.result
              });
              mailSent.should.eql(false);
              stepDone();
            });
        }
      ], callback);
    }

    it('[3P2N] must not be possible to use a reset token to illegally change password of another user', function (done) {
      let resetToken = null;
      const newPassword = 'hackingYourPassword';
      const user1 = testData.users[1];

      async.series([
        function generateResetToken (stepDone) {
          // generate a reset token for user1
          pwdResetReqsStorage.generate(
            user1.username,
            function (err, token) {
              assert.notExists(err);
              assert.exists(token);
              resetToken = token;
              stepDone();
            }
          );
        },
        function doReset (stepDone) {
          const data = Object.assign({}, authData, {
            resetToken,
            newPassword
          });
          // use user1's resetToken to reset user0's password
          request.post(resetPath).send(data)
            .unset('authorization')
            .set('Origin', 'http://test.pryv.local')
            .end(function (res) {
              validation.checkError(res, {
                status: 401,
                id: ErrorIds.InvalidAccessToken
              }, stepDone);
            });
        }
      ], done);
    });

    it('[J6GB] "request" must return an error if the requesting app is not trusted', function (done) {
      request.post(requestPath).send({ appId: 'bad-app-id' })
        .unset('authorization')
        .set('Origin', 'http://test.pryv.local')
        .end(function (res) {
          validation.checkError(res, {
            status: 401,
            id: ErrorIds.InvalidCredentials
          }, done);
        });
    });

    it('[5K14] "request" must return an error if sent data is badly formatted', function (done) {
      request.post(requestPath).send({ badParam: '?' })
        .unset('authorization')
        .end(function (res) {
          validation.checkErrorInvalidParams(res, done);
        });
    });

    it('[PKBP] "reset" must return an error if the reset token is invalid/expired', function (done) {
      const data = Object.assign({}, authData, {
        resetToken: 'bad-token',
        newPassword: '>-=(♥️)=-<'
      });
      request.post(resetPath).send(data)
        .unset('authorization')
        .set('Origin', 'http://test.pryv.local')
        .end(function (res) {
          validation.checkError(res, {
            status: 401,
            id: ErrorIds.InvalidAccessToken
          }, done);
        });
    });

    it('[ON9V] "reset" must return an error if the requesting app is not trusted', function (done) {
      request.post(resetPath).send({ resetToken: '?', newPassword: '123456', appId: 'bad-app-id' })
        .unset('authorization')
        .set('Origin', 'http://test.pryv.local')
        .end(function (res) {
          validation.checkError(res, {
            status: 401,
            id: ErrorIds.InvalidCredentials
          }, done);
        });
    });

    it('[T5L9] "reset" must return an error if sent data is badly formatted', function (done) {
      request.post(resetPath).send({ badParam: '?' })
        .unset('authorization')
        .end(function (res) {
          validation.checkErrorInvalidParams(res, done);
        });
    });

    it('[VGRT] "reset" must return an error if the reset token was already used', function (done) {
      let resetToken = null;
      const newPassword = 'myN3wF4ncYp4ssw0rd';
      const user = testData.users[0];

      async.series([
        function generateResetToken (stepDone) {
          // generate a reset token for user1
          pwdResetReqsStorage.generate(
            user.username,
            function (err, token) {
              assert.notExists(err);
              assert.exists(token);
              resetToken = token;
              stepDone();
            }
          );
        },
        function doResetFirst (stepDone) {
          const data = Object.assign({}, authData, { resetToken, newPassword });
          // use user1's resetToken to reset user0's password
          request.post(resetPath).send(data)
            .unset('authorization')
            .set('Origin', 'http://test.pryv.local')
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.requestPasswordReset.result
              });
              stepDone();
            });
        },
        function doResetSecond (stepDone) {
          const data = Object.assign({}, authData, { resetToken, newPassword });
          // use user1's resetToken to reset user0's password
          request.post(resetPath).send(data)
            .unset('authorization')
            .set('Origin', 'http://test.pryv.local')
            .end(function (res) {
              validation.checkError(res, {
                status: 401,
                id: ErrorIds.InvalidAccessToken
              }, stepDone);
            });
        }
      ], done);
    });

    describe('[RPWD] When password rules are enabled', function () {
      it('[HZCU] must fail if the new password does not comply (smoke test; see "/change-password" tests)', function (done) {
        const settings = _.merge(structuredClone(helpers.dependencies.settings), helpers.passwordRules.settingsOverride);
        settings.services.email.enabled = true;

        let resetToken;
        const badPassword = helpers.passwordRules.passwords.badTooShort;

        // setup mail server mock

        helpers.instanceTestSetup.set(settings, {
          context: settings.services.email,
          execute: function () {
            require('nock')(this.context.url).post('')
              .reply(200, function (uri, body) {
                const token = body.message.global_merge_vars[0].content; // HACK, assume structure
                this.context.testNotifier.emit('password-reset-token', token);
              }.bind(this));
          }
        });
        // fetch reset token from server process
        server.on('password-reset-token', function (token) {
          resetToken = token;
        });

        async.series([
          server.ensureStarted.bind(server, settings),
          function requestReset (stepDone) {
            request.post(requestPath)
              .unset('authorization')
              .set('Origin', 'http://test.pryv.local')
              .send(authData)
              .end(function (res) {
                validation.check(res, {
                  status: 200,
                  schema: methodsSchema.requestPasswordReset.result
                }, stepDone);
              });
          },
          function verifyStoredRequest (stepDone) {
            assert.exists(resetToken);
            pwdResetReqsStorage.get(
              resetToken,
              user.username,
              function (err, resetReq) {
                should.not.exist(err);
                assert.exists(resetReq);
                should(resetReq._id).be.equal(resetToken);
                should(resetReq.username).be.equal(user.username);
                stepDone();
              }
            );
          },
          function doReset (stepDone) {
            const data = Object.assign({}, authData, {
              resetToken,
              newPassword: badPassword
            });
            request.post(resetPath).send(data)
              .unset('authorization')
              .set('Origin', 'http://test.pryv.local')
              .end(function (res) {
                validation.checkError(res, {
                  status: 400,
                  id: ErrorIds.InvalidParametersFormat
                });
                assert.match(res.body.error.message, /characters long/);
                stepDone();
              });
          }
        ], done);
      });
    });
  });

  async function resetUsers () {
    accountNotifCount = 0;
    await testData.resetUsers();
  }

  function cleanUpDetails (accountDetails) {
    delete accountDetails.storageUsed;
  }
});
