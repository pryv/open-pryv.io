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
const server = helpers.dependencies.instanceManager;
const async = require('async');
const validation = helpers.validation;
const methodsSchema = require('../src/schema/profileMethods');
const storage = helpers.dependencies.storage.user.profile;
const testData = helpers.data;
const _ = require('lodash');

describe('profile (personal)', function () {
  const user = Object.assign({}, testData.users[0]);
  const basePath = '/' + user.username + '/profile';
  let request = null; // must be set after server instance started
  const publicProfile = testData.profile[0];
  const privateProfile = testData.profile[1];

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      }
    ], done);
  });

  describe('GET', function () {
    before(testData.resetProfile);

    it('[J61R] /public must return publicly shared key-value profile info',
      testGet.bind(null, publicProfile));

    it('[HIMS] /private must return private key-value profile info',
      testGet.bind(null, privateProfile));

    function testGet (profile, done) {
      request.get(basePath + '/' + profile.id).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          body: { profile: profile.data }
        }, done);
      });
    }

    it('[36B1] must return an appropriate error for other paths', function (done) {
      request.get(basePath + '/unknown-profile').end(function (res) {
        res.statusCode.should.eql(404);
        done();
      });
    });

    it('[FUJA] "private" must be forbidden to non-personal accesses', function (done) {
      request.get(basePath + '/private', testData.accesses[4].token).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });
  });

  describe('PUT', function () {
    beforeEach(testData.resetProfile);

    it('[M28R] /public must add/update/remove the specified keys without touching the others',
      testPut.bind(null, publicProfile));

    it('[WU9C] /private must add/update/remove the specified keys without touching the others',
      testPut.bind(null, privateProfile));

    it('[2AS6] must create the profile if not existing', function (done) {
      async.series([
        storage.removeAll.bind(storage, user),
        testPut.bind(null, { id: 'public', data: {} })
      ], done);
    });

    function testPut (original, done) {
      const data = {
        newKey: 'New Value', // add
        keyOne: 'No One', // update
        keyTwo: null // delete
      };
      request.put(basePath + '/' + original.id).send(data).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.update.result
        });

        const expectedData = _.extend(_.cloneDeep(original.data), data);
        delete expectedData.keyTwo;
        res.body.profile.should.eql(expectedData);

        done();
      });
    }

    it('[Q99E] must return an appropriate error for other paths', function (done) {
      request.put(basePath + '/unknown-profile').send({ an: 'update' }).end(function (res) {
        res.statusCode.should.eql(404);
        done();
      });
    });

    it('[T565] must be forbidden to non-personal accesses', function (done) {
      request.put(basePath + '/public', testData.accesses[4].token).send({ an: 'update' })
        .end(function (res) {
          validation.checkErrorForbidden(res, done);
        });
    });
  });
});
