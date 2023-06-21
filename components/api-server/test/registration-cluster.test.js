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

const { assert } = require('chai');
const _ = require('lodash');
const nock = require('nock');
const charlatan = require('charlatan');
const bluebird = require('bluebird');
const supertest = require('supertest');

const helpers = require('./helpers');
const { getConfig } = require('@pryv/boiler');
const { getApplication } = require('api-server/src/application');
const ErrorIds = require('errors/src/ErrorIds');
const ErrorMessages = require('errors/src/ErrorMessages');
const { getUsersRepository, User } = require('business/src/users');
const { getUserAccountStorage } = require('storage');
const { databaseFixture } = require('test-helpers');
const { produceMongoConnection } = require('./test-helpers');
const { ApiEndpoint } = require('utils');

/**
 * @returns {{ appId: string; username: any; email: any; password: string; invitationToken: string; referer: string; insurancenumber: any; }}
 */
function defaults () {
  return {
    appId: 'pryv-test',
    username: charlatan.Lorem.characters(7),
    email: charlatan.Internet.email(),
    password: 'abcdefgh',
    invitationToken: 'enjoy',
    referer: 'pryv',
    insurancenumber: charlatan.Number.number(3)
  };
}

describe('[REGC] registration: cluster', function () {
  let isDnsLess;

  before(async function () {
    config = await getConfig();
    isDnsLess = config.get('dnsLess:isActive');
    if (isDnsLess) { this.skip(); }
  });

  let app;
  let request;
  let res;
  let config;
  let regUrl;
  let userData;
  let serviceRegisterRequests = [];
  let mongoFixtures;
  let usersRepository;
  let userAccountStorage;

  // clean the database before starting all tests for registration
  before(async function () {
    mongoFixtures = databaseFixture(await produceMongoConnection());
    await mongoFixtures.context.cleanEverything();
    userAccountStorage = await getUserAccountStorage();
  });

  before(async function () {
    config.injectTestConfig({
      dnsLess: { isActive: false },
      openSource: { isActive: false },
      testsSkipForwardToRegister: false
    });
    regUrl = config.get('services:register:url');
    app = getApplication();
    await app.initiate();
    await require('../src/methods/auth/register')(app.api);
    request = supertest(app.expressApp);
    usersRepository = await getUsersRepository();
  });

  after(async function () {
    config.injectTestConfig({});
    mongoFixtures = databaseFixture(await produceMongoConnection());
    await mongoFixtures.context.cleanEverything();
  });

  const methodPath = '/users';

  function buildValidationRequest (user, hasToken = true) {
    const validationRequest = {
      core: res.req._header.split('Host: ')[1].split('\r\n')[0],
      username: user.username,
      uniqueFields: {
        username: user.username,
        email: user.email
      }
    };
    if (hasToken) {
      validationRequest.invitationToken = user.invitationToken;
    }
    return validationRequest;
  }

  function buildRegistrationRequest (user, hasToken = true) {
    const registrationRequest = {
      host: { name: res.req._header.split('Host: ')[1].split('\r\n')[0] },
      unique: ['username', 'email'],
      user: {
        username: user.username,
        email: user.email,
        appId: user.appId,
        referer: user.referer,
        insurancenumber: user.insurancenumber
      }
    };
    if (hasToken) {
      registrationRequest.user.invitationToken = user.invitationToken;
    }
    return registrationRequest;
  }

  function stripRegistrationRequest (request) {
    delete request.user.language;
    delete request.user.id;
    return request;
  }

  describe('POST /users (create user)', function () {
    describe('[WAUW] when a user with the same username (not email) already exists in core but not in register', () => {
      let oldEmail, firstUser, secondUser, firstValidationRequest, firstRegistrationRequest, serviceRegisterRequestsPUT;

      before(async () => {
        userData = defaults();
        serviceRegisterRequests = [];
        serviceRegisterRequestsPUT = [];
        nock.cleanAll();
        nock(regUrl)
          .post('/users/validate', (body) => {
            serviceRegisterRequests.push(body);
            return true;
          })
          .times(2)
          .reply(200, { errors: [] });
        nock(regUrl)
          .post('/users', (body) => {
            serviceRegisterRequests.push(body);
            return true;
          })
          .times(2)
          .reply(200, {
            username: 'anyusername'
          });
        nock(regUrl)
          .put('/users', (body) => {
            serviceRegisterRequestsPUT.push(body);
            return true;
          })
          .times(2)
          .reply(200, {
            ok: true
          });
        nock(regUrl)
          .delete('/users/' + userData.username + '?onlyReg=true', () => {
            return true;
          })
          .times(1)
          .reply(200, { deleted: true });
        // first request
        res = await request.post(methodPath).send(userData);
        firstValidationRequest = _.merge(buildValidationRequest(userData), {
          uniqueFields: { email: userData.email }
        });
        firstRegistrationRequest = buildRegistrationRequest(userData);
        firstUser = await usersRepository.getUserByUsername(userData.username);
        // second request, same username but with another email
        oldEmail = userData.email;
        userData.email = charlatan.Internet.email();
        res = await request.post(methodPath).send(userData);
        secondUser = await usersRepository.getUserByUsername(userData.username);
      });

      it('[QV8Z] should respond with status 201', () => {
        assert.equal(res.status, 201);
      });

      it('[TCOM] should respond with the username and apiEndpoint', async () => {
        const body = res.body;
        assert.equal(body.username, userData.username);
        const usersRepository = await getUsersRepository();
        const user = await usersRepository.getUserByUsername(userData.username);
        const personalAccess = await bluebird.fromCallback((cb) => app.storageLayer.accesses.findOne({ id: user.id }, {}, null, cb));
        const initUser = new User(userData);
        assert.equal(body.apiEndpoint, ApiEndpoint.build(initUser.username, personalAccess.token));
      });

      it('[7QB6] should send the right data to register', () => {
        const firstValidationSent = serviceRegisterRequests[0];
        assert.deepEqual(firstValidationSent, firstValidationRequest, 'first validation request is invalid');
        let firstRegistrationSent = serviceRegisterRequests[1];
        firstRegistrationSent = stripRegistrationRequest(firstRegistrationSent);
        assert.deepEqual(firstRegistrationSent, firstRegistrationRequest, ' first registration request is invalid');
        const secondValidationSent = serviceRegisterRequests[2];
        const secondValidationRequest = buildValidationRequest(userData);
        assert.deepEqual(secondValidationSent, secondValidationRequest, 'second validation request is invalid');
        let secondRegistrationSent = serviceRegisterRequests[3];
        secondRegistrationSent = stripRegistrationRequest(secondRegistrationSent);
        const secondRegistrationRequest = buildRegistrationRequest(userData);
        assert.deepEqual(secondRegistrationSent, secondRegistrationRequest, ' second registration request is invalid');
        const users = [firstUser, secondUser];
        assert.equal(serviceRegisterRequestsPUT.length, users.length, 'should have recieved 2 PUT requests');
        for (let i = 0; i < serviceRegisterRequestsPUT.length; i++) {
          const putRequest = serviceRegisterRequestsPUT[i];
          assert.deepEqual(putRequest, {
            username: users[i].username,
            user: {
              appId: [
                {
                  value: 'pryv-test',
                  isUnique: false,
                  isActive: true,
                  creation: true
                }
              ],
              invitationToken: [
                {
                  value: 'enjoy',
                  isUnique: false,
                  isActive: true,
                  creation: true
                }
              ],
              language: [
                {
                  creation: true,
                  isActive: true,
                  isUnique: false,
                  value: 'en'
                }
              ],
              referer: [
                {
                  value: 'pryv',
                  isUnique: false,
                  isActive: true,
                  creation: true
                }
              ],
              insurancenumber: [
                {
                  value: users[i].insurancenumber,
                  isUnique: false,
                  isActive: true,
                  creation: true
                }
              ],
              email: [
                {
                  value: users[i].email,
                  isUnique: true,
                  isActive: true,
                  creation: true
                }
              ]
            },
            fieldsToDelete: {}
          });
        }
      });

      it('[A2EM] should replace first user events in the storage', () => {
        const firstEmail = firstUser.events.filter((e) => e.type === 'email/string')[0].content;
        const secondEmail = secondUser.events.filter((e) => e.type === 'email/string')[0].content;
        assert.equal(firstEmail, oldEmail);
        assert.equal(secondEmail, userData.email);
      });
    });

    describe('when a user with the same username/email already exists in core but not in register', () => {
      let firstValidationRequest;
      let firstRegistrationRequest;

      before(async () => {
        userData = defaults();
        serviceRegisterRequests = [];
        nock(regUrl)
          .post('/users/validate', (body) => {
            serviceRegisterRequests.push(body);
            return true;
          })
          .times(2)
          .reply(200, { errors: [] });
        nock(regUrl)
          .post('/users', (body) => {
            serviceRegisterRequests.push(body);
            return true;
          })
          .times(2)
          .reply(200, {
            username: 'anyusername'
          });
        nock(regUrl)
          .put('/users', (/* body */) => {
            return true;
          })
          .times(2)
          .reply(200, {
            ok: true
          });
        nock(regUrl)
          .delete('/users/' + userData.username + '?onlyReg=true', () => {
            return true;
          })
          .times(1)
          .reply(200, { deleted: true });
        res = await request.post(methodPath).send(userData);
        firstValidationRequest = buildValidationRequest(userData);
        firstRegistrationRequest = buildRegistrationRequest(userData);
        res = await request.post(methodPath).send(userData);
      });

      it('[GRAW] should respond with status 201', () => {
        assert.equal(res.status, 201);
      });

      it('[AY44] should respond with the username and apiEndpoint (TODO)', () => {
        const body = res.body;
        assert.equal(body.username, userData.username);
      });

      it('[ZHYX] should send the right data to register', () => {
        // validate validation request - first and third requests
        // should be validation and they shuold be equal
        // (remove core because validation and registration was done
        // by different processes - port is different)
        const validationSent2 = structuredClone(serviceRegisterRequests[0]);
        delete validationSent2.core;
        delete serviceRegisterRequests[2].core;
        assert.deepEqual(validationSent2, serviceRegisterRequests[2]);
        // alsl validation request should be valid
        assert.deepEqual(serviceRegisterRequests[0], firstValidationRequest);
        // also first registration request should be valid
        let registrationSent = serviceRegisterRequests[1];
        registrationSent = stripRegistrationRequest(registrationSent);
        assert.deepEqual(registrationSent, firstRegistrationRequest);
      });
    });

    describe('when the username exists in register', () => {
      before(async () => {
        userData = _.extend({}, defaults(), { username: 'wactiv' });
        serviceRegisterRequests = [];
        nock(regUrl)
          .post('/users/validate', (body) => {
            serviceRegisterRequests.push(body);
            return true;
          })
          .reply(409, {
            error: {
              id: ErrorIds.ItemAlreadyExists,
              data: { username: 'wactiv' }
            }
          });
        res = await request.post(methodPath).send(userData);
      });

      it('[NUC9] should respond with status 409', () => {
        assert.equal(res.status, 409);
      });

      it('[X1IA] should respond with the correct error', () => {
        const error = res.body.error;
        assert.equal(error.id, ErrorIds.ItemAlreadyExists);
        assert.equal(error.data.username, userData.username);
      });

      it('[JJJY] should send the right data to register', () => {
        const validationSent = serviceRegisterRequests[0];
        assert.deepEqual(validationSent, buildValidationRequest(userData));
      });
    });

    describe('when the email exists in register', () => {
      before(async () => {
        userData = _.extend({}, defaults(), { email: 'wactiv@pryv.io' });
        serviceRegisterRequests = [];
        nock(regUrl)
          .post('/users/validate', (body) => {
            serviceRegisterRequests.push(body);
            return true;
          })
          .reply(409, {
            error: {
              id: ErrorIds.ItemAlreadyExists,
              data: { email: 'wactiv@pryv.io' }
            }
          });
        res = await request.post(methodPath).send(userData);
      });

      it('[SJXN] should respond with status 409', () => {
        assert.equal(res.status, 409);
      });

      it('[U0ZN] should respond with the correct error', () => {
        const error = res.body.error;
        assert.equal(error.id, ErrorIds.ItemAlreadyExists);
        assert.equal(error.data.email, userData.email);
      });

      it('[2UNK] should send the right data to register', () => {
        const validationSent = serviceRegisterRequests[0];
        assert.deepEqual(validationSent, buildValidationRequest(userData));
      });
    });

    describe('when the user and email exist in register', () => {
      before(async () => {
        userData = _.extend({}, defaults(), {
          username: 'wactiv',
          email: 'wactiv@pryv.io'
        });
        serviceRegisterRequests = [];
        nock(regUrl)
          .post('/users/validate', (body) => {
            serviceRegisterRequests.push(body);
            return true;
          })
          .reply(409, {
            error: {
              id: ErrorIds.ItemAlreadyExists,
              data: {
                email: 'wactiv@pryv.io',
                username: 'wactiv'
              }
            }
          });
        res = await request.post(methodPath).send(userData);
      });

      it('[LUC6] should respond with status 409', () => {
        assert.equal(res.status, 409);
      });

      it('[XIN8] should respond with the correct error', () => {
        const error = res.body.error;
        assert.equal(error.id, ErrorIds.ItemAlreadyExists);
        assert.equal(error.data.email, userData.email);
        assert.equal(error.id, ErrorIds.ItemAlreadyExists);
        assert.equal(error.data.username, userData.username);
      });

      it('[OIRY] should send the right data to register', () => {
        const validationSent = serviceRegisterRequests[0];
        assert.deepEqual(validationSent, buildValidationRequest(userData));
      });
    });

    describe('when there is a simultaneous registration', () => {
      before(async () => {
        userData = defaults();
        serviceRegisterRequests = [];
        nock(regUrl)
          .post('/users/validate', (body) => {
            serviceRegisterRequests.push(body);
            return true;
          })
          .reply(409, {
            error: {
              id: ErrorIds.ItemAlreadyExists,
              data: {
                username: userData.username
              }
            }
          });
        res = await request.post(methodPath).send(userData);
      });

      it('[I0HG] should respond with status 409', () => {
        assert.equal(res.status, 409);
      });

      it('[QFVZ] should respond with the correct error', () => {
        const error = res.body.error;
        assert.equal(error.id, ErrorIds.ItemAlreadyExists);
        // we don't receive conflicting keys yet
      });

      it('[MMG9] should send the right data to register', () => {
        const validationSent = serviceRegisterRequests[0];
        assert.deepEqual(validationSent, buildValidationRequest(userData));
      });
    });

    describe('when invitationTokens are undefined', () => {
      describe('and a random string is provided as "invitationToken"', () => {
        before(async () => {
          userData = defaults();
          userData.invitationToken = charlatan.Lorem.characters(25);
          serviceRegisterRequests = [];
          nock(regUrl)
            .post('/users/validate', (body) => {
              serviceRegisterRequests.push(body);
              return true;
            })
            .reply(200, { errors: [] });
          nock(regUrl)
            .post('/users', (body) => {
              serviceRegisterRequests.push(body);
              return true;
            })
            .reply(200, {
              username: userData.username
            });
          nock(regUrl)
            .put('/users', (/* body */) => {
              return true;
            })
            .reply(201, {
              ok: true
            });
          res = await request.post(methodPath).send(userData);
        });

        it('[CMOV] should respond with status 201', () => {
          assert.equal(res.status, 201);
        });

        it('[F0MO] should send the right data to register', () => {
          const validationSent = serviceRegisterRequests[0];
          assert.deepEqual(validationSent, buildValidationRequest(userData));
          let registrationSent = serviceRegisterRequests[1];
          registrationSent = stripRegistrationRequest(registrationSent);
          assert.deepEqual(registrationSent, buildRegistrationRequest(userData));
        });
      });

      describe('and "invitationToken" is missing', () => {
        const serviceRegisterValidate = [];
        const serviceRegisterCreateUser = [];
        before(async () => {
          userData = defaults();
          delete userData.invitationToken;
          nock(regUrl)
            .post('/users/validate', (body) => {
              serviceRegisterValidate.push(body);
              return true;
            })
            .reply(200, { errors: [] });
          nock(regUrl)
            .post('/users', (body) => {
              serviceRegisterCreateUser.push(body);
              return true;
            })
            .reply(200, {
              username: userData.username
            });
          nock(regUrl)
            .put('/users', (/* body */) => {
              return true;
            })
            .reply(201, {
              ok: true
            });
          res = await request.post(methodPath).send(userData);
        });

        it('[LOIB] should respond with status 201', () => {
          assert.equal(res.status, 201);
        });

        it('[5O4Q] should send the right data to register', () => {
          const validationSent = serviceRegisterValidate[0];
          assert.deepEqual(validationSent, buildValidationRequest(userData, false));
          let registrationSent = serviceRegisterCreateUser[0];
          registrationSent = stripRegistrationRequest(registrationSent);
          assert.deepEqual(registrationSent, buildRegistrationRequest(userData, false));
        });
      });
    });

    describe('when invitationTokens are defined', () => {
      describe('when a valid one is provided', () => {
        before(async () => {
          userData = defaults();
          serviceRegisterRequests = [];
          nock(regUrl)
            .post('/users/validate', (body) => {
              serviceRegisterRequests.push(body);
              return true;
            })
            .reply(200, { errors: [] });
          nock(regUrl)
            .post('/users', (body) => {
              serviceRegisterRequests.push(body);
              return true;
            })
            .reply(200, {
              username: userData.username
            });
          nock(regUrl)
            .put('/users', (/* body */) => {
              return true;
            })
            .reply(200, {
              ok: true
            });
          res = await request.post(methodPath).send(userData);
        });

        it('[Z2ZY] should respond with status 201', () => {
          assert.equal(res.status, 201);
        });

        it('[DIFS] should send the right data to register', () => {
          const validationSent = serviceRegisterRequests[0];
          assert.deepEqual(validationSent, buildValidationRequest(userData));
          let registrationSent = serviceRegisterRequests[1];
          registrationSent = stripRegistrationRequest(registrationSent);
          assert.deepEqual(registrationSent, buildRegistrationRequest(userData));
        });

        it('[1BF3] should find password in password history', async () => {
          const user = await usersRepository.getUserByUsername(userData.username);
          assert.isTrue(await userAccountStorage.passwordExistsInHistory(user.id, userData.password, 1), 'missing password in history');
        });
      });

      describe('when an invalid one is provided', () => {
        before(async () => {
          userData = defaults();
          serviceRegisterRequests = [];
          nock(regUrl)
            .post('/users/validate', (body) => {
              serviceRegisterRequests.push(body);
              return true;
            })
            .reply(400, {
              error: {
                id: ErrorIds.InvalidInvitationToken
              }
            });
          res = await request.post(methodPath).send(userData);
        });

        it('[4GON] should respond with status 400', () => {
          assert.equal(res.status, 400);
        });

        it('[ZBYW] should send the right data to register', () => {
          const validationSent = serviceRegisterRequests[0];
          assert.deepEqual(validationSent, buildValidationRequest(userData));
        });
      });
    });

    describe('when invitationTokens are set to [] (forbidden creation)', () => {
      describe('when any string is provided', () => {
        before(async () => {
          userData = defaults();
          serviceRegisterRequests = [];
          nock(regUrl)
            .post('/users/validate', (body) => {
              serviceRegisterRequests.push(body);
              return true;
            })
            .reply(400, {
              error: {
                id: ErrorIds.InvalidInvitationToken
              }
            });
          res = await request.post(methodPath).send(userData);
        });

        it('[CX9N] should respond with status 400', () => {
          assert.equal(res.status, 400);
        });

        it('[IH6K] should send the right data to register', () => {
          const validationSent = serviceRegisterRequests[0];
          assert.deepEqual(validationSent, buildValidationRequest(userData));
        });
      });
    });

    describe('when custom account streams validation exists', () => {
      describe('when email is set as required and it is not set in the request', () => {
        before(async () => {
          userData = defaults();
          // remove email from the request
          delete userData.email;
          res = await request.post(methodPath).send(userData);
        });

        it('[UMWB] should respond with status 400', () => {
          assert.equal(res.status, 400);
        });

        it('[8RDA] should respond with the correct error', () => {
          const error = res.body.error;
          assert.equal(error.id, ErrorIds.InvalidParametersFormat);
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

      describe('when field does not match custom validation settings', () => {
        before(async () => {
          userData = userData = defaults();
          userData.insurancenumber = 'abc';
          res = await request.post(methodPath).send(userData);
        });

        it('[8W22] should respond with status 400', () => {
          assert.equal(res.status, 400);
        });

        it('[GBKD] should respond with the correct error', () => {
          const error = res.body.error;
          assert.equal(error.id, ErrorIds.InvalidParametersFormat);
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
        config.injectTestConfig(helpers.passwordRules.settingsOverride);
        userData = defaults();
        nock(regUrl)
          .post('/users/validate', () => true)
          .reply(200, { errors: [] });
        nock(regUrl)
          .post('/users', () => true)
          .reply(200, { username: userData.username });
        nock(regUrl)
          .put('/users', () => true)
          .reply(200, { ok: true });
      });

      it('[0OBL] must fail if the new password does not comply (smoke test; see "/change-password" in account tests)', async () => {
        userData.password = helpers.passwordRules.passwords.badTooShort;
        const res = await request.post(methodPath).send(userData);
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidParametersFormat
        });
      });

      it('[5BQL] must succeed if the new password complies (smoke test; see "/change-password" in account tests)', async () => {
        userData.password = helpers.passwordRules.passwords.good4CharCats;
        const res = await request.post(methodPath).send(userData);
        validation.check(res, { status: 201 });
      });
    });
  });
});
