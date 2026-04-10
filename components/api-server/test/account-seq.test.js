/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const _ = require('lodash');
const async = require('async');
const { promisify } = require('util');
const fs = require('fs');
const timestamp = require('unix-timestamp');

require('./test-helpers');
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const ErrorIds = require('errors').ErrorIds;
const validation = helpers.validation;
const methodsSchema = require('../src/schema/accountMethods');
let pwdResetReqsStorage;
const testData = helpers.dynData({ prefix: 'acct' });
const { getUsersRepository } = require('business/src/users');
const { getUserAccountStorage } = require('storage');
const { getMall } = require('mall');
const encryption = require('utils').encryption;

describe('[ACCO] account', function () {
  const user = structuredClone(testData.users[0]);
  let usersRepository = null;
  let userAccountStorage = null;
  let mall = null;

  before(async () => {
    usersRepository = await getUsersRepository();
    userAccountStorage = await getUserAccountStorage();
    mall = await getMall();
    pwdResetReqsStorage = helpers.dependencies.storage.passwordResetRequests;
  });

  const basePath = '/' + user.username + '/account';
  let request = null; // must be set after server instance started

  // to verify data change notifications
  let accountNotifCount;
  server.on('test-account-changed', function () { accountNotifCount++; });

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetEvents,
      testData.resetProfile,
      testData.resetStreams,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      }
    ], done);
  });

  // Clean up the personal access created by login
  after(function (done) {
    const accessStorage = helpers.dependencies.storage.user.accesses;
    accessStorage.removeOne(user, { token: request.token }, done);
  });

  after(async function () {
    await testData.cleanup();
  });

  // [AC01] GET / - Tests moved to account-2convert.test.js:
  // - [PHSB] must return the user's account details
  // - [K5EI] must be forbidden to non-personal accesses

  describe('[AC02] PUT /', function () {
    beforeEach(async () => { await resetUsers(); });

    it('[0PPV] must modify account details with the sent data',
      function (done) {
        const updatedData = {
          email: 'userzero.new@test.com',
          language: 'zh'
        };

        async.series([
          function update (stepDone) {
            request.put(basePath).send(updatedData).end(function (res) {
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
              assert.strictEqual(accountNotifCount, 1, 'account notifications');
              stepDone();
            });
          },
          async function verifyData () {
            const retrievedUser = await usersRepository.getUserByUsername(user.username);
            validation.checkStoredItem(retrievedUser.getAccountWithId(), 'user');
          }
        ], done);
      });

    // [AT0V], [NZE2] - Tests moved to account-2convert.test.js
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

  describe('[AC03] storage space monitoring', function () {
    before(function (done) {
      async.series([
        testData.resetUsers,
        testData.resetEvents,
        testData.resetProfile,
        testData.resetStreams,
        server.ensureStarted.bind(server, helpers.dependencies.settings),
        function (stepDone) {
          request = helpers.request(server.url);
          request.login(user, stepDone);
        }
      ], done);
    });
    before(getFilesystemBlockSize);

    // Clean up the personal access created by login in this describe block
    after(function (done) {
      const accessStorage = helpers.dependencies.storage.user.accesses;
      accessStorage.removeOne(user, { token: request.token }, done);
    });

    // when checking files storage size we allow a small 1k error margin to account for folder sizes

    // tests the computation of user storage size which is used from different API methods
    // (so we're not directly testing an API method here)
    it('[NFJQ] must properly compute used storage size for a given user when called', async () => {
      const newAtt = testData.attachments.image;

      const storageInfoInitial = await mall.getUserStorageInfos(user.id);

      const expectedAttsSize = _.reduce(testData.events, function (total, evt) {
        return total + getTotalAttachmentsSize(evt);
      }, 0);

      // On Ubuntu with ext4 FileSystem the size difference is 4k, not 1k. I still dunno why.
      assert.ok(Math.abs(storageInfoInitial.local.files.sizeKb - expectedAttsSize) <= filesystemBlockSize);

      const addEventWithAttachmentAsync = promisify(addEventWithAttachment);
      await addEventWithAttachmentAsync(newAtt);
      const storageInfoAfter = await mall.getUserStorageInfos(user.id);

      // hard to know what the exact difference should be, so we just expect it's bigger
      assert.ok(storageInfoAfter.local.events.count > storageInfoInitial.local.events.count);
      assert.ok(Math.abs(storageInfoAfter.local.files.sizeKb - (storageInfoInitial.local.files.sizeKb +
        newAtt.size)) <= filesystemBlockSize);
    });

    // test nightly job script
    it('[Y445] must properly compute storage size for all users in nightly script', async function () {
      const newAtt = testData.attachments.image;
      const execSync = require('child_process').execSync;

      // Initial nightly task
      execSync('node ./bin/nightly');

      // Verify initial storage usage
      const initialStorageInfo = await mall.getUserStorageInfos(user.id);
      assert.ok(initialStorageInfo.local.files.sizeKb > 0);

      // Add an attachment
      const addEventWithAttachmentAsync2 = promisify(addEventWithAttachment);
      await addEventWithAttachmentAsync2(newAtt);

      // Another nightly task
      execSync('node ./bin/nightly');

      // Verify updated storage usage
      const updatedStorageInfo = await mall.getUserStorageInfos(user.id);

      assert.ok(updatedStorageInfo.local.events.count > initialStorageInfo.local.events.count);
      assert.ok(Math.abs(updatedStorageInfo.local.files.sizeKb -
        (initialStorageInfo.local.files.sizeKb + newAtt.size)) <= filesystemBlockSize);
    });

    function addEventWithAttachment (attachment, callback) {
      request.post('/' + user.username + '/events')
        .field('event', JSON.stringify({ type: 'test/i', streamIds: [testData.streams[0].id] }))
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
          assert.deepStrictEqual(retrievedUser.storageUsed.dbDocuments, initialStorageUsed.dbDocuments);
          assert.ok(Math.abs(retrievedUser.storageUsed.attachedFiles -
            (initialStorageUsed.attachedFiles + newAtt.size)) <= filesystemBlockSize);
        }
      ], done);
    });

    it('[93AP] must be approximately updated (diff) when deleting an attached file', async function () {
      const deletedAtt = testData.dynCreateAttachmentIdMap[testData.events[0].id][0];
      const initialStorageInfo = await mall.getUserStorageInfos(user.id);

      const path = '/' + user.username + '/events/' + testData.events[0].id + '/' +
        deletedAtt.id;
      try {
        await request.del(path);
      } catch (e) {
        // not an error, but the callback returns the response in 1st position
        // either we do the request with superagent, or we update request()
      }

      const updatedStorageInfo = await mall.getUserStorageInfos(user.id);
      assert.strictEqual(updatedStorageInfo.local.events.count, initialStorageInfo.local.events.count);
      assert.ok(Math.abs(updatedStorageInfo.local.files.sizeKb -
        (initialStorageInfo.local.files.sizeKb - deletedAtt.size)) <= filesystemBlockSize);
    });

    it('[5WO0] must be approximately updated (diff) when deleting an event', async function () {
      const deletedEvt = testData.events[2];
      const deletedEvtPath = '/' + user.username + '/events/' + deletedEvt.id;
      const initialStorageInfo = await mall.getUserStorageInfos(user.id);
      try {
        await request.del(deletedEvtPath);
      } catch (e) {}
      try {
        await request.del(deletedEvtPath);
      } catch (e) {}

      const updatedStorageInfo = await mall.getUserStorageInfos(user.id);
      assert.strictEqual(updatedStorageInfo.local.events.count, initialStorageInfo.local.events.count);
      assert.ok(Math.abs(updatedStorageInfo.local.files.sizeKb -
        (initialStorageInfo.local.files.sizeKb - getTotalAttachmentsSize(deletedEvt))) <= filesystemBlockSize);
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

  describe('[AC04] /change-password', function () {
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
            assert.strictEqual(accountNotifCount, 1, 'account notifications');
            stepDone();
          });
        },
        function verifyNewPassword (stepDone) {
          request.login(Object.assign({}, user, { password: data.newPassword }), stepDone);
        },
        async function checkPasswordInHistory () {
          assert.strictEqual(await userAccountStorage.passwordExistsInHistory(user.id, data.oldPassword, 2), true, 'missing previous password in history');
          assert.strictEqual(await userAccountStorage.passwordExistsInHistory(user.id, data.newPassword, 1), true, 'missing new password in history');
        }
      ], done);
    });

    // [STWH], [8I1N], [J5VH] - Tests moved to account-2convert.test.js

    describe('[APWD] When password rules are enabled', function () {
      const settings = _.merge(structuredClone(helpers.dependencies.settings), helpers.passwordRules.settingsOverride);
      const baseData = { oldPassword: user.password };

      before(async () => {
        await resetUsers();
        await server.ensureStartedAsync(settings);
      });

      describe('[AC05] Complexity rules:', function () {
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

      describe('[AC06] Reuse rules:', function () {
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

      describe('[AC07] Age rules:', function () {
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

  describe('[AC08] /request-password-reset and /reset-password', function () {
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
          assert.ok(resetToken != null);
          pwdResetReqsStorage.get(
            resetToken,
            user.username,
            function (err, resetReq) {
              assert.ok(err == null);
              assert.ok(resetReq != null);
              assert.strictEqual(resetReq._id, resetToken);
              assert.strictEqual(resetReq.username, user.username);
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
              assert.strictEqual(mailSent, false);
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
              assert.ok(err == null);
              assert.ok(token != null);
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

    // [J6GB], [5K14], [PKBP], [ON9V], [T5L9] - Tests moved to account-2convert.test.js

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
              assert.ok(err == null);
              assert.ok(token != null);
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
            assert.ok(resetToken != null);
            pwdResetReqsStorage.get(
              resetToken,
              user.username,
              function (err, resetReq) {
                assert.ok(err == null);
                assert.ok(resetReq != null);
                assert.strictEqual(resetReq._id, resetToken);
                assert.strictEqual(resetReq.username, user.username);
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
