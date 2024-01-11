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

const async = require('async');
const should = require('should'); // explicit require to benefit from static functions
const { assert } = require('chai');
const _ = require('lodash');

require('./test-helpers');
const helpers = require('./helpers');
const ErrorIds = require('errors').ErrorIds;
const server = helpers.dependencies.instanceManager;
const validation = helpers.validation;
const methodsSchema = require('../src/schema/followedSlicesMethods');
const storage = helpers.dependencies.storage.user.followedSlices;
const testData = helpers.data;

describe('followed slices', function () {
  const user = structuredClone(testData.users[0]);
  const basePath = '/' + user.username + '/followed-slices';
  let request = null; // must be set after server instance started

  function path (id) {
    return basePath + '/' + id;
  }

  // to verify data change notifications
  let followedSlicesNotifCount;
  server.on('axon-followed-slices-changed', function () { followedSlicesNotifCount++; });

  before(function (done) {
    async.series([
      testData.resetUsers,
      helpers.dependencies.storage.user.accesses
        .removeAll.bind(helpers.dependencies.storage.user.accesses, user),
      helpers.dependencies.storage.user.accesses
        .insertMany.bind(helpers.dependencies.storage.user.accesses, user,
          [testData.accesses[4]]),
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      }
    ], done);
  });

  describe('GET /', function () {
    before(resetFollowedSlices);

    it('[TNKS] must return all followed slices (ordered by user name, then access token)',
      function (done) {
        request.get(basePath).end(function (res) {
          validation.check(res, {
            status: 200,
            schema: methodsSchema.get.result,
            body: { followedSlices: _.sortBy(testData.followedSlices, 'name') }
          }, done);
        });
      });

    it('[U9M4] must be forbidden to non-personal accesses', function (done) {
      request.get(basePath, testData.accesses[4].token).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });
  });

  describe('POST /', function () {
    beforeEach(resetFollowedSlices);

    it('[HVYA] must create a new followed slice with the sent data, returning it', function (done) {
      const data = {
        name: 'Some followed slice',
        url: 'https://mirza.pryv.io/',
        accessToken: 'some-token'
      };
      let originalCount,
        createdSlice;

      async.series([
        function countInitial (stepDone) {
          storage.countAll(user, function (err, count) {
            assert.notExists(err);
            originalCount = count;
            stepDone();
          });
        },
        function addNew (stepDone) {
          request.post(basePath).send(data).end(function (res) {
            validation.check(res, {
              status: 201,
              schema: methodsSchema.create.result
            });
            createdSlice = res.body.followedSlice;
            followedSlicesNotifCount.should.eql(1, 'followed slices notifications');
            stepDone();
          });
        },
        function verifyData (stepDone) {
          storage.findAll(user, null, function (err, followedSlices) {
            assert.notExists(err);

            followedSlices.length.should.eql(originalCount + 1, 'followed slices');

            const expected = structuredClone(data);
            expected.id = createdSlice.id;
            const actual = _.find(followedSlices, function (slice) {
              return slice.id === createdSlice.id;
            });
            validation.checkStoredItem(actual, 'followedSlice');
            actual.should.eql(expected);

            stepDone();
          });
        }
      ],
      done
      );
    });

    it('[BULL] must return a correct error if the sent data is badly formatted', function (done) {
      request.post(basePath).send({ badProperty: 'bad value' }).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

    it('[GPZK] must return a correct error if the same followed slice (url and token) already exists',
      function (done) {
        const data = {
          name: 'New name',
          url: testData.followedSlices[0].url,
          accessToken: testData.followedSlices[0].accessToken
        };
        request.post(basePath).send(data).end(function (res) {
          validation.checkError(res, {
            status: 409,
            id: ErrorIds.ItemAlreadyExists,
            data: { url: data.url, accessToken: data.accessToken }
          }, done);
        });
      });

    it('[RYNB] must return a correct error if a followed slice with the same name already exists',
      function (done) {
        const data = {
          name: testData.followedSlices[0].name,
          url: 'https://hippolyte.pryv.io/',
          accessToken: 'some-token'
        };
        request.post(basePath).send(data).end(function (res) {
          validation.checkError(res, {
            status: 409,
            id: ErrorIds.ItemAlreadyExists,
            data: { name: data.name }
          }, done);
        });
      });
  });

  describe('PUT /<id>', function () {
    beforeEach(resetFollowedSlices);

    it('[LM08] must modify the followed slice with the sent data', function (done) {
      const original = testData.followedSlices[0];
      const newSliceData = {
        name: 'Updated Slice 0'
      };

      request.put(path(original.id)).send(newSliceData).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.update.result
        });

        const expected = Object.assign({}, original, newSliceData);
        res.body.followedSlice.should.eql(expected);

        followedSlicesNotifCount.should.eql(1, 'followed slices notifications');
        done();
      });
    });

    it('[QFGH] must return a correct error if the followed slice does not exist', function (done) {
      request.put(path('unknown-id')).send({ name: '?' }).end(function (res) {
        validation.checkError(res, {
          status: 404,
          id: ErrorIds.UnknownResource
        }, done);
      });
    });

    it('[RUQE] must return a correct error if the sent data is badly formatted', function (done) {
      request.put(path(testData.followedSlices[1].id)).send({ badProperty: 'bad value' })
        .end(function (res) {
          validation.checkErrorInvalidParams(res, done);
        });
    });

    it('[T256] must return a correct error if a followed slice with the same name already exists',
      function (done) {
        const update = { name: testData.followedSlices[0].name };
        request.put(path(testData.followedSlices[1].id)).send(update).end(function (res) {
          validation.checkError(res, {
            status: 409,
            id: ErrorIds.ItemAlreadyExists,
            data: { name: update.name }
          }, done);
        });
      });
  });

  describe('DELETE /<id>', function () {
    beforeEach(resetFollowedSlices);

    it('[U7LY] must delete the followed slice', function (done) {
      const deletedId = testData.followedSlices[2].id;
      async.series([
        function deleteSlice (stepDone) {
          request.del(path(deletedId)).end(function (res) {
            validation.check(res, {
              status: 200,
              schema: methodsSchema.del.result
            });
            followedSlicesNotifCount.should.eql(1, 'followed slices notifications');
            stepDone();
          });
        },
        function verifyData (stepDone) {
          storage.findAll(user, null, function (err, slices) {
            assert.notExists(err);

            slices.length.should.eql(testData.followedSlices.length - 1, 'followed slices');

            const deletedSlice = _.find(slices, function (slice) {
              return slice.id === deletedId;
            });
            should.not.exist(deletedSlice);

            stepDone();
          });
        }
      ],
      done
      );
    });

    it('[UATV] must return a correct error if the followed slice does not exist', function (done) {
      request.del(path('unknown-id')).end(function (res) {
        validation.checkError(res, {
          status: 404,
          id: ErrorIds.UnknownResource
        }, done);
      });
    });
  });

  function resetFollowedSlices (done) {
    followedSlicesNotifCount = 0;
    const user = structuredClone(testData.users[0]);
    testData.resetFollowedSlices(done, user);
  }
});
