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
const fs = require('fs');
const should = require('should'); // explicit require to benefit from static function
const timestamp = require('unix-timestamp');
const _ = require('lodash');
const bluebird = require('bluebird');
const chai = require('chai');
const assert = chai.assert;

require('./test-helpers');
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const commonTests = helpers.commonTests;
const validation = helpers.validation;
const ErrorIds = require('errors').ErrorIds;
const eventFilesStorage = helpers.dependencies.storage.user.eventFiles;
const methodsSchema = require('../src/schema/streamsMethods');

const testData = helpers.data;
const treeUtils = require('utils').treeUtils;

const { getMall } = require('mall');
const cache = require('cache');

describe('[STRE] streams', function () {
  const user = structuredClone(testData.users[0]);
  const initialRootStreamId = testData.streams[0].id;
  const basePath = '/' + user.username + '/streams';
  // these must be set after server instance started
  let request = null;
  let accessId = null;

  let mall;

  before(async () => { mall = await getMall(); });
  function path (id) {
    return basePath + '/' + id;
  }

  // to verify data change notifications
  let streamsNotifCount,
    eventsNotifCount;
  server.on('axon-streams-changed', function () { streamsNotifCount++; });
  server.on('axon-events-changed', function () { eventsNotifCount++; });

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      },
      function (stepDone) {
        helpers.dependencies.storage.user.accesses.findOne(user, { token: request.token },
          null, function (err, access) {
            assert.notExists(err);
            accessId = access.id;
            stepDone();
          });
      }
    ], done);
  });

  describe('GET /', function () {
    before(resetData);

    it('[TG78] must return non-trashed streams (as a tree) by default', function (done) {
      request.get(basePath).end(async function (res) {
        // manually filter out trashed items

        const expected = treeUtils.filterTree(validation.removeDeletionsAndHistory(structuredClone(testData.streams)),
          false, function (s) { return !s.trashed; });
        await validation.addStoreStreams(expected);
        res.body.streams = validation.removeAccountStreams(res.body.streams);

        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          body: { streams: expected }
        }, done);
      });
    });

    it('[DPWG] must return all streams (trashed or not) when requested', function (done) {
      request.get(basePath).query({ state: 'all' }).end(async function (res) {
        const expected = _.sortBy(validation.removeDeletions(structuredClone(testData.streams)), 'name');
        await validation.addStoreStreams(expected);
        res.body.streams = validation.removeAccountStreams(res.body.streams);
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          body: { streams: expected }
        }, done);
      });
    });

    it('[RDD5] must include stream deletions (since the given time) when requested', function (done) {
      const params = { includeDeletionsSince: timestamp.now('-45m') };
      request.get(basePath).query(params).end(function (res) {
        res.body.streams = validation.removeAccountStreams(res.body.streams);
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result
        });
        res.body.streamDeletions.should.eql(_.at(testData.streams, 4));
        done();
      });
    });

    it('[T8AM] must include stream deletions even when the given time is 0', function (done) {
      const params = { includeDeletionsSince: 0 };
      request.get(basePath).query(params).end(function (res) {
        res.body.streams = validation.removeAccountStreams(res.body.streams);
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result
        });
        assert.exists(res.body.streamDeletions);
        done();
      });
    });

    it('[1M8A] must not keep stream deletions past a certain time ' +
        '(cannot test because cannot force-run Mongo\'s TTL cleanup task)');

    it('[W9VC] must return a correct 401 error if no access token is provided', function (done) {
      commonTests.checkAccessTokenAuthentication(server.url, basePath, done);
    });

    it('[UVWK] must return child streams when providing a parent stream id', function (done) {
      request.get(basePath).query({ parentId: initialRootStreamId }).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          body: { streams: testData.streams[0].children }
        }, done);
      });
    });

    it('[AJZL] must return a correct error if the parent stream is unknown', function (done) {
      request.get(basePath).query({ parentId: 'unknownStreamId' }).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.UnknownReferencedResource,
          data: { parentId: 'unknownStreamId' }
        }, done);
      });
    });

    it('[G5F2] must return a correct error if the stream is unknown', function (done) {
      request.get(basePath).query({ id: 'unknownStreamId' }).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.UnknownReferencedResource,
          data: { id: 'unknownStreamId' }
        }, done);
      });
    });
  });

  describe('POST /', function () {
    beforeEach(resetData);

    it('[ENVV] must create a new "root" stream with the sent data, returning it', function (done) {
      const data = {
        name: 'Test Root Stream',
        clientData: {
          testClientDataField: 'testValue'
        },
        // included to make sure it's properly ignored and stripped before storage
        children: [{ name: 'should be ignored' }]
      };
      let originalCount,
        createdStream,
        time;

      async.series([
        async function countInitialRootStreams () {
          const streams = await mall.streams.get(user.id, { storeId: 'local', hideRootStreams: true });
          originalCount = streams.length;
        },
        function addNewStream (stepDone) {
          request.post(basePath).send(data).end(function (res) {
            time = timestamp.now();
            validation.check(res, {
              status: 201,
              schema: methodsSchema.create.result
            });
            createdStream = res.body.stream;
            streamsNotifCount.should.eql(1, 'streams notifications');
            stepDone();
          });
        },
        async function verifyStreamData () {
          // server and current "mall" instance are not running on the same instance and cache must me invalidated manually
          cache.unsetStreams(user.id, 'local');
          const streams = await mall.streams.get(user.id, { storeId: 'local', hideRootStreams: true });
          streams.length.should.eql(originalCount + 1, 'should count one more root stream');

          const expected = structuredClone(data);
          expected.id = createdStream.id;
          expected.parentId = null;
          expected.created = expected.modified = time;
          expected.createdBy = expected.modifiedBy = accessId;
          expected.children = [];
          const actual = _.find(streams, function (stream) {
            return stream.id === createdStream.id;
          });
          validation.checkObjectEquality(actual, expected);
        },
        async function verifyStoredItem () {
          const stream = await mall.streams.getOneWithNoChildren(user.id, createdStream.id);
          validation.checkStoredItem(stream, 'stream');
        }
      ], done);
    });

    it('[A2HP] must return a correct error if the sent data is badly formatted', function (done) {
      request.post(basePath).send({ badProperty: 'bad value' }).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

    it('[GGS3] must return a correct error if a stream with the same id already exists', function (done) {
      const data = { id: testData.streams[0].id, name: 'Duplicate' };
      request.post(basePath).send(data).end(function (res) {
        validation.checkError(res, {
          status: 409,
          id: ErrorIds.ItemAlreadyExists,
          data: { id: data.id }
        }, done);
      });
    });

    it('[UHKI] must allow reuse of deleted ids', function (done) {
      const data = {
        id: testData.streams[4].id,
        name: 'New stream reusing previously deleted id',
        parentId: null
      };
      request.post(basePath).send(data).end(function (res) {
        validation.check(res, {
          status: 201,
          schema: methodsSchema.create.result
        });
        validation.checkObjectEquality(res.body.stream, data);
        done();
      });
    });

    it('[8WGG] must accept explicit null for optional fields', function (done) {
      const data = {
        id: 'nullable',
        name: 'New stream with null fields',
        parentId: null,
        clientData: null,
        children: null,
        trashed: null
      };
      request.post(basePath).send(data).end(function (res) {
        validation.check(res, {
          status: 201,
          schema: methodsSchema.create.result
        }, done);
      });
    });

    it('[NR4D] must fail if a sibling stream with the same name already exists', function (done) {
      const data = { name: testData.streams[0].name };
      request.post(basePath).send(data).end(function (res) {
        validation.checkError(res, {
          status: 409,
          id: ErrorIds.ItemAlreadyExists,
          data: { name: data.name }
        }, done);
      });
    });

    // this test doesn't apply to streams in particular, but the bug was found here and there's
    // no better location at the moment
    it('[JINC] must return a correct error if the sent data is not valid JSON', function (done) {
      request.post(basePath).type('json').send('{"someProperty": ”<- bad opening quote"}')
        .end(function (res) {
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidRequestStructure
          }, done);
        });
    });

    it('[CHDM] must create a new child stream (with predefined id) when providing a parent stream id',
      (done) => {
        let originalCount;

        async.series([
          async function _countInitialChildStreams () {
            const streams = await mall.streams.get(user.id, { id: initialRootStreamId, storeId: 'local', childrenDepth: -1 });
            originalCount = streams[0].children.length;
          },
          function _addNewStream (stepDone) {
            const data = {
              id: 'predefined-stream-id',
              name: 'New Child Stream',
              parentId: initialRootStreamId
            };
            request.post(basePath).send(data).end(function (res) {
              validation.check(res, {
                status: 201,
                schema: methodsSchema.create.result
              });
              assert.strictEqual(res.body.stream.id, data.id);
              assert.strictEqual(streamsNotifCount, 1);

              stepDone();
            });
          },
          async function _recountChildStreams () {
            // server and current "mall" instance are not running on the same instance and cache must me invalidated manually
            cache.unsetStreams(user.id, 'local');
            const streams = await mall.streams.get(user.id, { id: initialRootStreamId, storeId: 'local', childrenDepth: -1 });
            const count = streams[0].children.length;
            assert.strictEqual(count, originalCount + 1, 'Created a child stream.');
          }
        ],
        done);
      });

    // Test added to verify fix of issue#29
    it('[88VQ] must return an error if the new stream\'s parentId ' +
      'is the empty string', function (done) {
      const data = {
        name: 'zero-length parentId string Stream',
        parentId: ''
      };
      request.post(basePath).send(data).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidParametersFormat
        }, done);
      });
    });

    it('[84RK] must slugify the new stream\'s predefined id', function (done) {
      const data = {
        id: 'pas encodé de bleu!',
        name: 'Genevois, cette fois'
      };

      request.post(basePath).send(data).end(function (res) {
        validation.check(res, {
          status: 201,
          schema: methodsSchema.create.result
        });
        res.body.stream.id.should.eql('pas-encode-de-bleu');
        done();
      });
    });

    it('[2B3H] must return a correct error if the parent stream is unknown', function (done) {
      const data = {
        name: 'New Child Stream',
        parentId: 'unknown-stream-id'
      };
      request.post(basePath).send(data).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.UnknownReferencedResource,
          data: { parentId: data.parentId }
        }, done);
      });
    });

    it('[8JB5] must return a correct error if the given predefined stream\'s id is "null"',
      function (done) {
        const data = {
          id: 'null',
          name: 'Badly Named Stream'
        };
        request.post(basePath).send(data).end(function (res) {
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidItemId
          }, done);
        });
      });

    it('[6TPQ] must return a correct error if the given predefined stream\'s id is "*"',
      function (done) {
        const data = {
          id: '*',
          name: 'Badly Named Stream'
        };
        request.post(basePath).send(data).end(function (res) {
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidItemId
          }, done);
        });
      });

    it('[Z3RC] must accept streamId "size"', function (done) {
      const data = {
        id: 'size',
        name: 'Size'
      };
      request.post(basePath).send(data).end(function (res) {
        validation.check(res, {
          status: 201,
          schema: methodsSchema.create.result
        }, done);
      });
    });
  });

  describe('PUT /<id>', function () {
    beforeEach(resetData);

    it('[SO48] must modify the stream with the sent data', function (done) {
      const original = testData.streams[0];
      let time;
      const data = {
        name: 'Updated Root Stream 0',
        clientData: {
          clientField: 'client value'
        }
      };

      request.put(path(original.id)).send(data).end(function (res) {
        time = timestamp.now();
        validation.check(res, {
          status: 200,
          schema: methodsSchema.update.result
        });

        const expected = structuredClone(data);
        expected.id = original.id;
        expected.parentId = original.parentId;
        expected.modified = time;
        expected.modifiedBy = accessId;
        delete expected.children;
        validation.checkObjectEquality(res.body.stream, expected);

        streamsNotifCount.should.eql(1, 'streams notifications');
        done();
      });
    });

    it('[5KNJ] must accept explicit null for optional fields', function (done) {
      const data = {
        parentId: null,
        clientData: null,
        trashed: null
      };
      request.put(path(testData.streams[0].id)).send(data).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.update.result
        }, done);
      });
    });

    it('[0ANV] must add/update/remove the specified client data fields without touching the others',
      function (done) {
        const original = testData.streams[1];
        const data = {
          clientData: {
            booleanProp: true, // add
            stringProp: 'Where Art Thou?', // update
            numberProp: null // delete
          }
        };

        request.put(path(original.id)).send(data).end(function (res) {
          validation.check(res, {
            status: 200,
            schema: methodsSchema.update.result
          });

          const expected = structuredClone(original);
          _.extend(expected.clientData, data.clientData);
          delete expected.clientData.numberProp;
          delete expected.modified;
          delete expected.modifiedBy;
          delete expected.children;
          validation.checkObjectEquality(res.body.stream, expected);

          streamsNotifCount.should.eql(1, 'streams notifications');
          done();
        });
      });

    it('[PL2G] must return a correct error if the stream does not exist', function (done) {
      request.put(path('unknown-id')).send({ name: '?' }).end(function (res) {
        validation.checkError(res, {
          status: 404,
          id: ErrorIds.UnknownResource
        }, done);
      });
    });

    it('[JWT4] must return a correct error if the sent data is badly formatted', function (done) {
      request.put(path(testData.streams[1].id)).send({ badProperty: 'bad value' })
        .end(function (res) {
          validation.checkErrorInvalidParams(res, done);
        });
    });

    it('[344I] must fail if a sibling stream with the same name already exists', function (done) {
      const update = { name: testData.streams[0].name };
      request.put(path(testData.streams[1].id)).send(update).end(function (res) {
        validation.checkError(res, {
          status: 409,
          id: ErrorIds.ItemAlreadyExists,
          data: { name: update.name }
        }, done);
      });
    });

    it('[PT1E] must move the stream under the given parent when specified', function (done) {
      const original = testData.streams[0].children[1];
      const newParent = testData.streams[1];

      async.series([
        function updateStream (stepDone) {
          request.put(path(original.id)).send({ parentId: newParent.id })
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.update.result
              });
              streamsNotifCount.should.eql(1, 'streams notifications');
              stepDone();
            });
        },
        async function verifyStreamsData () {
          const streams = await mall.streams.get(user.id, { storeId: 'local', hideRootStreams: true });

          const updated = structuredClone(original);
          updated.parentId = newParent.id;
          delete updated.modified;
          delete updated.modifiedBy;
          const expected = structuredClone(newParent);
          expected.children = structuredClone(newParent.children);
          expected.children.unshift(updated);
          const actual = _.find(streams, function (stream) {
            return stream.id === newParent.id;
          });
          validation.checkObjectEquality(actual, expected);
        }
      ], done);
    });

    it('[HJBH] must return a correct error if the new parent stream is unknown', function (done) {
      request.put(path(testData.streams[1].id)).send({ parentId: 'unknown-id' })
        .end(function (res) {
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.UnknownReferencedResource,
            data: { parentId: 'unknown-id' }
          }, done);
        });
    });

    // ticket #1209
    it('[29S6] must return an error if the "parentId" is the same as the "id"', function (done) {
      const id = testData.streams[1].id;
      request.put(path(id)).send({ parentId: id })
        .end(function (res) {
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidOperation,
            data: { parentId: id }
          }, done);
        });
    });

    describe('forbidden updates of protected fields', function () {
      const streamId = 'forbidden_stream_update_test';
      const stream = {
        id: streamId,
        name: streamId
      };

      beforeEach(function (done) {
        request.post(basePath).send(stream).end(function (res) {
          validation.check(res, {
            status: 201,
            schema: methodsSchema.create.result
          }, done);
        });
      });

      it('[PN1H] must fail and throw a forbidden error in strict mode', function (done) {
        const forbiddenUpdate = {
          id: 'forbidden',
          children: [],
          created: 1,
          createdBy: 'bob',
          modified: 1,
          modifiedBy: 'alice'
        };

        async.series([
          function instanciateServerWithStrictMode (stepDone) {
            setIgnoreProtectedFieldUpdates(false, stepDone);
          },
          function testForbiddenUpdate (stepDone) {
            request.put(path(streamId)).send(forbiddenUpdate).end(function (res) {
              validation.checkError(res, {
                status: 403,
                id: ErrorIds.Forbidden
              }, stepDone);
            });
          }
        ], done);
      });

      it('[A3WC] must succeed by ignoring protected fields and log a warning in non-strict mode', function (done) {
        const forbiddenUpdate = {
          id: 'forbidden',
          children: [],
          created: 1,
          createdBy: 'bob',
          modified: 1,
          modifiedBy: 'alice'
        };

        async.series([
          function instanciateServerWithNonStrictMode (stepDone) {
            setIgnoreProtectedFieldUpdates(true, stepDone);
          },
          function testForbiddenUpdate (stepDone) {
            request.put(path(streamId)).send(forbiddenUpdate).end(function (res) {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.update.result
              });
              const stream = res.body.stream;
              should(stream.id).not.be.equal(forbiddenUpdate.id);
              should(stream.created).not.be.equal(forbiddenUpdate.created);
              should(stream.createdBy).not.be.equal(forbiddenUpdate.createdBy);
              should(stream.modified).not.be.equal(forbiddenUpdate.modified);
              should(stream.modifiedBy).not.be.equal(forbiddenUpdate.modifiedBy);
              stepDone();
            });
          }
        ], done);
      });

      function setIgnoreProtectedFieldUpdates (activated, stepDone) {
        const settings = structuredClone(helpers.dependencies.settings);
        settings.updates.ignoreProtectedFields = activated;
        server.ensureStarted(settings, stepDone);
      }
    });
  });

  describe('[STRD] DELETE /<id>', function () {
    this.timeout(5000);

    beforeEach(resetData);

    it('[205A] must flag the specified stream as trashed', function (done) {
      const trashedId = testData.streams[0].id;
      let time;

      request.del(path(trashedId)).end(function (res) {
        time = timestamp.now();
        validation.check(res, {
          status: 200,
          schema: methodsSchema.del.result
        });

        const trashedStream = res.body.stream;
        trashedStream.trashed.should.eql(true);
        trashedStream.modified.should.be.within(time - 1, time);
        trashedStream.modifiedBy.should.eql(accessId);

        streamsNotifCount.should.eql(1, 'streams notifications');
        done();
      });
    });

    it('[TEFF] must delete the stream when already trashed with its descendants if there are no linked ' +
        'events', function (done) {
      const parent = testData.streams[2];
      const deletedStream = parent.children[1];
      const id = deletedStream.id;
      const childId = deletedStream.children[0].id;
      let expectedDeletion;
      let expectedChildDeletion;

      async.series([
        async function trashStream () {
          await mall.streams.update(user.id, { id, trashed: true });
        },
        function deleteStream (stepDone) {
          request.del(path(id)).end(function (res) {
            expectedDeletion = {
              id,
              deleted: timestamp.now()
            };
            expectedChildDeletion = {
              id: childId,
              deleted: timestamp.now()
            };

            validation.check(res, {
              status: 200,
              schema: methodsSchema.del.result
            });
            streamsNotifCount.should.eql(1, 'streams notifications');
            stepDone();
          });
        },
        async function verifyStreamData () {
          // parent
          const parentStream = await mall.streams.get(user.id, { id: parent.id, storeId: 'local', childrenDepth: -1, includeTrashed: true });
          const parentChildren = parentStream[0].children;
          parentChildren.length.should.eql(testData.streams[2].children.length - 1, 'child streams');

          // deleted stream
          const deletedStreams = await mall.streams.getDeletions(user.id, 0, ['local']);
          const foundDeletedStream = deletedStreams.filter(s => s.id === id)[0];
          assert.exists(foundDeletedStream, 'cannot find deleted stream');
          validation.checkObjectEquality(foundDeletedStream, expectedDeletion);

          // child stream
          const foundDeletedChild = deletedStreams.filter(s => s.id === childId)[0];
          assert.exists(foundDeletedChild, 'cannot find deleted child stream');
          validation.checkObjectEquality(foundDeletedChild, expectedChildDeletion);
        }
      ],
      done);
    });

    it('[LVTR] must return a correct error if there are linked events and the related parameter is ' +
        'missing', function (done) {
      const id = testData.streams[0].id;
      async.series([
        async function trashStream () {
          await mall.streams.update(user.id, { id, trashed: true });
        },
        function deleteStream (stepDone) {
          request.del(path(testData.streams[0].id)).end(function (res) {
            validation.checkError(res, {
              status: 400,
              id: ErrorIds.InvalidParametersFormat
            }, stepDone);
          });
        }
      ],
      done);
    });

    it('[RKEU] must reject the deletion of a root stream with mergeEventsWithParent=true', function (done) {
      const id = testData.streams[0].id;
      async.series([
        async function trashStream () {
          await mall.streams.update(user.id, { id, trashed: true });
        }, function deleteStream (stepDone) {
          request.del(path(testData.streams[0].id)).query({ mergeEventsWithParent: true })
            .end(function (res) {
              validation.checkError(res, {
                status: 400,
                id: ErrorIds.InvalidOperation,
                data: { streamId: id }
              }, stepDone);
            });
        }
      ],
      done);
    });

    it('[26V0] must reassign the linked events to the deleted stream\'s parent when specified', function (done) {
      const parentStream = testData.streams[0];
      const deletedStream = parentStream.children[1];

      async.series([
        function trashStream (stepDone) {
          request.del(path(deletedStream.id)).query({ mergeEventsWithParent: true })
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.del.result
              });
              stepDone();
            });
        },
        function deleteStream (stepDone) {
          request.del(path(deletedStream.id)).query({ mergeEventsWithParent: true })
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.del.result
              });
              stepDone();
            });
        },
        function checkNotifs (stepDone) {
          streamsNotifCount.should.eql(2, 'streams notifications');
          eventsNotifCount.should.eql(1, 'events notifications');
          stepDone();
        },
        async function verifyLinkedEvents () {
          const linkedEvents = await mall.events.get(user.id, { streams: [{ any: [parentStream.id] }] });
          _.map(linkedEvents, 'id').should.eql([
            testData.events[4].id,
            testData.events[3].id,
            testData.events[2].id,
            testData.events[1].id
          ]);
        }
      ],
      done);
    });

    it('[KLD8] must delete the linked events when mergeEventsWithParent is false', function (done) {
      const id = testData.streams[8].id;
      const deletedEvents = testData.events.filter(function (e) {
        if (e.streamIds == null) return false;
        return e.streamIds[0] === id;
      });
      const deletedEventWithAtt = deletedEvents[0];
      let deletionTime;

      const ADD_N_EVENTS = 100;

      async.series([
        function addEventAttachment (stepDone) {
          request.post('/' + user.username + '/events/' + deletedEventWithAtt.id)
            .attach('image', testData.attachments.image.path,
              testData.attachments.image.fileName)
            .end(function (res) {
              validation.check(res, { status: 200 });
              eventsNotifCount = 0; // reset
              stepDone();
            });
        },
        async function fillStreamWithALotOfEvent () {
          const mall = await getMall();
          for (let i = 0; i < ADD_N_EVENTS; i++) {
            await mall.events.create(user.id, {
              id: 'cxxxxxxx' + i,
              type: 'note/txt',
              streamIds: [testData.streams[8].id],
              content: '' + i,
              time: timestamp.now(),
              created: timestamp.now(),
              createdBy: 'test',
              modified: timestamp.now(),
              modifiedBy: 'test'
            });
          }
        },
        async function trashStream () {
          await mall.streams.update(user.id, { id, trashed: true });
        },
        function deleteStream (stepDone) {
          request.del(path(id))
            .query({ mergeEventsWithParent: false })
            .end(function (res) {
              deletionTime = timestamp.now();
              validation.check(res, {
                status: 200,
                schema: methodsSchema.del.result
              });

              should(streamsNotifCount).eql(1, 'streams notifications');
              should(eventsNotifCount).eql(1, 'events notifications');

              stepDone();
            });
        },
        async function verifyLinkedEvents () {
          let events = await mall.events.get(user.id, { state: 'all' });
          const foundDeletedEvents = await mall.events.getDeletions('local', user.id, { deletedSince: 0 });
          // lets separate system events from all other events and validate them separately
          const separatedEvents = validation.separateAccountStreamsAndOtherEvents(events);
          events = separatedEvents.events;
          const eventsWithoutHistory = testData.events.filter(e => e.headId == null);
          (events.length + foundDeletedEvents.length).should.eql(eventsWithoutHistory.length + ADD_N_EVENTS, 'events');

          // validate account streams events
          const actualAccountStreamsEvents = separatedEvents.accountStreamsEvents;
          validation.validateAccountEvents(actualAccountStreamsEvents);

          deletedEvents.forEach(function (e) {
            const actual = _.find(foundDeletedEvents, { id: e.id });
            assert.approximately(
              actual.deleted, deletionTime, 2,
              'Deletion time must be correct.');
            assert.equal(actual.id, e.id);
          });

          const dirPath = eventFilesStorage.getEventPath(user.id, deletedEventWithAtt.id);

          // some time after returning to the client. Let's hang around and try
          // this several times.
          await bluebird.fromCallback(cb => {
            assertEventuallyTrue(
              () => !fs.existsSync(dirPath),
              5, // second(s)
              'Event directory must be deleted' + dirPath,
              cb
            );
          });
        }
      ], done);

      function assertEventuallyTrue (property, maxWaitSeconds, msg, cb) {
        const deadline = new Date().getTime() + maxWaitSeconds;
        const checker = () => {
          if (new Date().getTime() > deadline) {
            return cb(new chai.AssertionError('Timeout: ' + msg));
          }

          const result = property();
          if (result) return cb();

          // assert: result is false, try again in a bit.
          setImmediate(checker);
        };

        // Launch first check
        setImmediate(checker);
      }
    });

    it('[1U1M] must return a correct error if the item is unknown', function (done) {
      request.del(path('unknown_id')).end(function (res) {
        validation.checkError(res, {
          status: 404,
          id: ErrorIds.UnknownResource
        }, done);
      });
    });
  });

  function resetData (done) {
    streamsNotifCount = 0;
    eventsNotifCount = 0;
    async.series([
      testData.resetStreams,
      testData.resetEvents
    ], done);
  }
});
