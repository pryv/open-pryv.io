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

require('./test-helpers');
const helpers = require('./helpers');
const ErrorIds = require('errors').ErrorIds;
const server = helpers.dependencies.instanceManager;
const async = require('async');
const validation = helpers.validation;
const methodsSchema = require('../src/schema/profileMethods');
const testData = helpers.data;
const _ = require('lodash');

describe('profile (app)', function () {
  const user = structuredClone(testData.users[0]);
  const basePath = '/' + user.username + '/profile';
  let request = null; // must be set after server instance started
  const appAccess = testData.accesses[4];
  const appProfile = testData.profile[2];
  const sharedAccess = testData.accesses[1];

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) { request = helpers.request(server.url); stepDone(); }
    ], done);
  });

  describe('GET /public', function () {
    before(testData.resetProfile);

    const path = basePath + '/public';

    it('[FWG1] must return publicly shared key-value profile info', function (done) {
      request.get(path, appAccess.token).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          body: { profile: testData.profile[0].data }
        }, done);
      });
    });
  });

  describe('GET /app', function () {
    before(testData.resetProfile);

    const path = basePath + '/app';

    it('[13DL] must return key-value settings for the current app', function (done) {
      request.get(path, appAccess.token).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          body: { profile: appProfile.data }
        }, done);
      });
    });

    it('[J37U] must refuse requests with a shared access token', function (done) {
      request.get(path, sharedAccess.token).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidOperation
        }, done);
      });
    });

    it('[GYBN] must refuse requests with a personal access token', function (done) {
      const personalRequest = helpers.request(server.url);
      async.series([
        personalRequest.login.bind(personalRequest, user),
        function (stepDone) {
          personalRequest.get(path).end(function (res) {
            validation.checkError(res, {
              status: 400,
              id: ErrorIds.InvalidOperation
            }, stepDone);
          });
        }
      ], done);
    });
  });

  describe('PUT /app', function () {
    beforeEach(testData.resetProfile);

    const path = basePath + '/app';

    it('[1QFB] must add/update/remove the specified keys without touching the others', function (done) {
      const data = {
        newKey: 'New Value', // add
        keyOne: 'No One', // update
        keyTwo: null // delete
      };
      request.put(path, appAccess.token).send(data).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.update.result
        });

        const expectedData = _.extend(structuredClone(appProfile.data), data);
        delete expectedData.keyTwo;
        res.body.profile.should.eql(expectedData);

        done();
      });
    });

    it('[0H9A] must refuse requests with a shared access token', function (done) {
      request.put(path, sharedAccess.token).send({ any: 'thing' }).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidOperation
        }, done);
      });
    });

    it('[JC5F] must refuse requests with a personal access token', function (done) {
      const personalRequest = helpers.request(server.url);
      async.series([
        personalRequest.login.bind(personalRequest, user),
        function (stepDone) {
          personalRequest.put(path).send({ any: 'thing' }).end(function (res) {
            validation.checkError(res, {
              status: 400,
              id: ErrorIds.InvalidOperation
            }, stepDone);
          });
        }
      ], done);
    });
  });
});
