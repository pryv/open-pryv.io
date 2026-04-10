/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const async = require('async');
const timestamp = require('unix-timestamp');
const _ = require('lodash');
const assert = require('node:assert');

require('./test-helpers');
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const commonTests = helpers.commonTests;
const validation = helpers.validation;
const ErrorIds = require('errors').ErrorIds;
const methodsSchema = require('../src/schema/streamsMethods');

const testData = helpers.dynData({ prefix: 'strm' });
const treeUtils = require('utils').treeUtils;

const { getMall } = require('mall');

describe('[STRE] streams', function () {
  const user = structuredClone(testData.users[0]);
  const initialRootStreamId = testData.streams[0].id;
  const basePath = '/' + user.username + '/streams';
  // these must be set after server instance started
  let request = null;

  let mall;

  before(async () => { mall = await getMall(); });
  function path (id) {
    return basePath + '/' + id;
  }

  // to verify data change notifications
  let streamsNotifCount,
    eventsNotifCount;
  server.on('test-streams-changed', function () { streamsNotifCount++; });
  server.on('test-events-changed', function () { eventsNotifCount++; });

  before(function (done) {
    async.series([
      testData.resetUsers,
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

  describe('[ST01] GET /', function () {
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
        assert.deepStrictEqual(res.body.streamDeletions, _.at(testData.streams, 4));
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
        assert.ok(res.body.streamDeletions != null);
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

    // [AJZL] Duplicate of streams-patternc.test.js - removed
    // [G5F2] Duplicate of streams-patternc.test.js - removed
  });

  describe('[ST02] POST /', function () {
    beforeEach(resetData);

    // [ENVV] Converted to Pattern C: streams-patternc.test.js [PENV] - removed

    // [A2HP] Duplicate of streams-patternc.test.js - removed
    // [GGS3] Duplicate of streams-patternc.test.js - removed

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

    // [8WGG] Duplicate of streams-patternc.test.js - removed
    // [NR4D] Duplicate of streams-patternc.test.js - removed

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

    // [CHDM] Converted to Pattern C: streams-patternc.test.js [PCHD] - removed

    // [88VQ] Duplicate of streams-patternc.test.js - removed
    // [84RK] Duplicate of streams-patternc.test.js - removed
    // [2B3H] Duplicate of streams-patternc.test.js - removed
    // [8JB5] Duplicate of streams-patternc.test.js - removed
    // [6TPQ] Duplicate of streams-patternc.test.js - removed
    // [Z3RC] Duplicate of streams-patternc.test.js - removed
  });

  describe('[ST03] PUT /<id>', function () {
    beforeEach(resetData);

    // [SO48] Converted to Pattern C: streams-patternc.test.js [PSO4] - removed

    // [5KNJ] Duplicate of streams-patternc.test.js - removed
    // [0ANV] Converted to Pattern C: streams-patternc.test.js [PSO4] - removed
    // [PL2G] Duplicate of streams-patternc.test.js - removed
    // [JWT4] Duplicate of streams-patternc.test.js - removed

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

    it('[JT6G] must modify the stream with the sent data event if name and parentId sent are the same', function (done) {
      request.get(basePath).query({ parentId: testData.streams[2].children[1].id }).end(function (resQ) {
        const stream = resQ.body.streams[0];
        const data = {
          name: stream.name,
          clientData: { hello: 'bob' },
          parentId: stream.parentId
        };

        request.put(path(stream.id)).send(data).end(function (res) {
          validation.check(res, {
            status: 200,
            schema: methodsSchema.update.result
          }, done);
        });
      });
    });

    // Uses notification tracking - kept in Pattern A for complex verification
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
              assert.strictEqual(streamsNotifCount, 1, 'streams notifications');
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

    // [HJBH] Duplicate of streams-patternc.test.js - removed
    // [29S6] Duplicate of streams-patternc.test.js - removed

    describe('[ST04] forbidden updates of protected fields', function () {
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
              assert.notStrictEqual(stream.id, forbiddenUpdate.id);
              assert.notStrictEqual(stream.created, forbiddenUpdate.created);
              assert.notStrictEqual(stream.createdBy, forbiddenUpdate.createdBy);
              assert.notStrictEqual(stream.modified, forbiddenUpdate.modified);
              assert.notStrictEqual(stream.modifiedBy, forbiddenUpdate.modifiedBy);
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

    // [205A] Converted to Pattern C: streams-patternc.test.js [P205] - removed

    // Uses notification tracking - kept in Pattern A for complex verification (descendant deletion)
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
            assert.strictEqual(streamsNotifCount, 1, 'streams notifications');
            stepDone();
          });
        },
        async function verifyStreamData () {
          // parent
          const parentStream = await mall.streams.get(user.id, { id: parent.id, storeId: 'local', childrenDepth: -1, includeTrashed: true });
          const parentChildren = parentStream[0].children;
          assert.strictEqual(parentChildren.length, testData.streams[2].children.length - 1, 'child streams');

          // deleted stream
          const deletedStreams = await mall.streams.getDeletions(user.id, 0, ['local']);
          const foundDeletedStream = deletedStreams.filter(s => s.id === id)[0];
          assert.ok(foundDeletedStream != null, 'cannot find deleted stream');
          validation.checkObjectEquality(foundDeletedStream, expectedDeletion);

          // child stream
          const foundDeletedChild = deletedStreams.filter(s => s.id === childId)[0];
          assert.ok(foundDeletedChild != null, 'cannot find deleted child stream');
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
          assert.strictEqual(streamsNotifCount, 2, 'streams notifications');
          assert.strictEqual(eventsNotifCount, 1, 'events notifications');
          stepDone();
        },
        async function verifyLinkedEvents () {
          const linkedEvents = await mall.events.get(user.id, { streams: [{ any: [parentStream.id] }] });
          assert.deepStrictEqual(_.map(linkedEvents, 'id'), [
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
      let deletedEventWithAttPost = null;
      let deletionTime;

      const ADD_N_EVENTS = 100;

      async.series([
        function addEventAttachment (stepDone) {
          request.post('/' + user.username + '/events/' + deletedEventWithAtt.id)
            .attach('image', testData.attachments.image.path,
              testData.attachments.image.fileName)
            .end(function (res) {
              deletedEventWithAttPost = res.body.event;
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

              assert.strictEqual(streamsNotifCount, 1, 'streams notifications');
              assert.strictEqual(eventsNotifCount, 1, 'events notifications');

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
          assert.strictEqual(events.length + foundDeletedEvents.length, eventsWithoutHistory.length + ADD_N_EVENTS, 'events');

          // validate account streams events
          const actualAccountStreamsEvents = separatedEvents.accountStreamsEvents;
          validation.validateAccountEvents(actualAccountStreamsEvents);

          deletedEvents.forEach(function (e) {
            const actual = _.find(foundDeletedEvents, { id: e.id });
            assert.ok(Math.abs(actual.deleted - deletionTime) <= 2,
              'Deletion time must be correct.');
            assert.strictEqual(actual.id, e.id);
          });
          try {
            await mall.events.getAttachment(user.id, { id: deletedEventWithAttPost.id }, deletedEventWithAttPost.attachments[0].id);
            throw new Error('Should not find attachment');
          } catch (err) {
            assert.strictEqual(err.id, 'unknown-resource');
          }
        }
      ], done);
    });

    // [1U1M] Duplicate of streams-patternc.test.js - removed
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
