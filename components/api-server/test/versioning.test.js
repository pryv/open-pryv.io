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
const _ = require('lodash');
const charlatan = require('charlatan');
const { assert } = require('chai');

const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const validation = helpers.validation;
const eventsMethodsSchema = require('../src/schema/eventsMethods');
const streamsMethodsSchema = require('../src/schema/streamsMethods');
const testData = helpers.data;
const SystemStreamSerializer = require('business/src/system-streams/serializer');
const { integrity } = require('business');
const { getMall } = require('mall');

require('date-utils');

describe('Versioning', function () {
  let mall = null;
  before(async () => {
    mall = await getMall();
  });

  const user = structuredClone(testData.users[0]);
  let request = null;

  function pathToEvent (eventId) {
    let resPath = '/' + user.username + '/events';
    if (eventId) {
      resPath += '/' + eventId;
    }
    return resPath;
  }

  function pathToStream (streamId) {
    let resPath = '/' + user.username + '/streams';
    if (streamId) {
      resPath += '/' + streamId;
    }
    return resPath;
  }

  before(function (done) {
    const settings = structuredClone(helpers.dependencies.settings);
    settings.versioning.forceKeepHistory = true;
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetStreams,
      testData.resetEvents,
      server.ensureStarted.bind(server, settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      }
    ], done);
  });

  after(function (done) {
    const settings = structuredClone(helpers.dependencies.settings);
    settings.versioning = {
      forceKeepHistory: false,
      deletionMode: 'keep-nothing'
    };
    server.ensureStarted(settings, done);
  });

  const eventWithHistory = testData.events[16];
  const trashedEventWithHistory = testData.events[19];
  const eventWithNoHistory = testData.events[22];
  const eventOnChildStream = testData.events[25];

  const normalStream = testData.streams[7];
  const childStream = normalStream.children[0];

  describe('Events', function () {
    it('[RWIA] must not return history when calling events.get', function (done) {
      const queryParams = { limit: 100 };

      request.get(pathToEvent(null)).query(queryParams).end(function (res) {
        const separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
        res.body.events = separatedEvents.events;
        validation.check(res, {
          status: 200,
          schema: eventsMethodsSchema.get.result
        });
        const events = res.body.events;
        (events.length).should.be.above(0);
        events.forEach(function (event) {
          assert.notExists(event.headId);
        });
        done();
      });
    });

    describe('deletionMode', function () {
      beforeEach(testData.resetEvents);

      it('[FLLW] must delete the event\'s history when deleting it with deletionMode=keep-nothing',
        function (done) {
          const settings = structuredClone(helpers.dependencies.settings);
          settings.versioning.deletionMode = 'keep-nothing';

          async.series([
            server.ensureStarted.bind(server, settings),
            function deleteEvent (stepDone) {
              request.del(pathToEvent(trashedEventWithHistory.id)).end(function (res) {
                validation.check(res, {
                  status: 200,
                  schema: eventsMethodsSchema.del.result
                });
                res.body.eventDeletion.id.should.eql(trashedEventWithHistory.id);
                stepDone();
              });
            },
            async function findDeletionInStorageAndCheckThatHistoryIsDeleted () {
              const event = await mall.events.getOne(user.id, trashedEventWithHistory.id);
              const eventHistory = await mall.events.getHistory(user.id, trashedEventWithHistory.id);
              eventHistory.length.should.be.eql(0); // empty history
              assert.exists(event.deleted);
            }
          ], done);
        });

      it('[6W0B] must minimize the event\'s history when deleting it with deletionMode=keep-authors',
        function (done) {
          const settings = structuredClone(helpers.dependencies.settings);
          settings.versioning.deletionMode = 'keep-authors';

          async.series([
            server.ensureStarted.bind(server, settings),
            function deleteEvent (stepDone) {
              request.del(pathToEvent(trashedEventWithHistory.id)).end(function (res) {
                validation.check(res, {
                  status: 200,
                  schema: eventsMethodsSchema.del.result
                });
                stepDone();
              });
            },
            async function findDeletionInStorageAndCheckThatHistoryIsDeleted () {
              const deletedEvent = await mall.events.getOne(user.id, trashedEventWithHistory.id);
              assert.exists(deletedEvent);

              (Object.keys(deletedEvent).length).should.eql(integrity.events.isActive ? 5 : 4);
              deletedEvent.id.should.eql(trashedEventWithHistory.id);
              assert.exists(deletedEvent.deleted);
              assert.exists(deletedEvent.modified);
              assert.exists(deletedEvent.modifiedBy);
              if (integrity.events.isActive) assert.exists(deletedEvent.integrity);

              const eventHistory = await mall.events.getHistory(user.id, trashedEventWithHistory.id);
              eventHistory.length.should.be.eql(2);
              eventHistory.forEach(function (event) {
                // integrity is lost
                (Object.keys(event).length).should.eql(3);
                assert.exists(event.id);
                assert.equal(event.id, trashedEventWithHistory.id);
                assert.exists(event.modified);
                assert.exists(event.modifiedBy);
              });
            }
          ], done);
        });

      it('[1DBC] must not modify the event\'s history when deleting it with ' +
        'deletionMode=keep-everything',
      function (done) {
        const settings = structuredClone(helpers.dependencies.settings);
        settings.versioning.deletionMode = 'keep-everything';

        async.series([
          server.ensureStarted.bind(server, settings),
          function deleteEvent (stepDone) {
            request.del(pathToEvent(trashedEventWithHistory.id)).end(function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.del.result
              });
              stepDone();
            });
          },
          async function verifyDeletedHeadInStory () {
            const event = await mall.events.getOne(user.id, trashedEventWithHistory.id);
            assert.exists(event);
            const expected = structuredClone(trashedEventWithHistory);
            delete expected.streamId;
            // this comes from the storage .. no need to test tags
            delete expected.tags;
            expected.deleted = event.deleted;
            integrity.events.set(expected);
            event.should.eql(expected);
          },
          async function checkThatHistoryIsUnchanged () {
            const eventHistory = await mall.events.getHistory(user.id, trashedEventWithHistory.id);

            // TODO clean this test
            const checked = { first: false, second: false };
            (eventHistory.length).should.eql(2);
            eventHistory.forEach(function (event) {
              if (event.modified === testData.events[20].modified) {
                const expected = structuredClone(testData.events[20]);
                expected.id = expected.headId;
                delete expected.headId;
                delete expected.tags;// this comes from the storage .. no need to test tags
                event.should.eql(expected);
                checked.first = true;
              } else if (event.modified === testData.events[21].modified) {
                const expected = structuredClone(testData.events[21]);
                expected.id = expected.headId;
                delete expected.headId;
                delete expected.tags;// this comes from the storage .. no need to test tags
                event.should.eql(expected);
                checked.second = true;
              }
            });
            checked.should.eql({ first: true, second: true });
          }
        ], done);
      });
    });

    describe('events.getOne', function () {
      it('[YRI7] must not return an event\'s history when calling getOne with includeHistory flag off',
        function (done) {
          request.get(pathToEvent(eventWithHistory.id)).query({ includeHistory: false }).end(
            function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.getOne.result
              });
              assert.notExists(res.body.history);
              done();
            }
          );
        });

      it('[KPQZ] must return an event\'s history when calling getOne with includeHistory flag on',
        function (done) {
          request.get(pathToEvent(eventWithHistory.id)).query({ includeHistory: true }).end(
            function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.getOne.result
              });
              assert.exists(res.body.history);

              done();
            }
          );
        });
    });

    describe('forceKeepHistory is OFF', function () {
      before(function (done) {
        const settings = structuredClone(helpers.dependencies.settings);
        settings.versioning.forceKeepHistory = false;
        server.ensureStarted(settings, done);
      });

      beforeEach(testData.resetEvents);

      it('[PKA9] must not generate history when updating an event', function (done) {
        const updateData = {
          content: 'updated content'
        };
        async.series([
          function updateEvent (stepDone) {
            request.put(pathToEvent(eventWithNoHistory.id)).send(updateData).end(function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.update.result
              });
              stepDone();
            });
          },
          function callGetOne (stepDone) {
            request.get(pathToEvent(eventWithNoHistory.id)).query({ includeHistory: true }).end(
              function (res) {
                validation.check(res, {
                  status: 200,
                  schema: eventsMethodsSchema.getOne.result
                });
                assert.exists(res.body);
                (res.body.history.length).should.eql(0);
                stepDone();
              });
          }
        ], done);
      });
    });

    describe('forceKeepHistory is ON', function () {
      beforeEach(testData.resetEvents);

      before(function (done) {
        const settings = structuredClone(helpers.dependencies.settings);
        settings.versioning.forceKeepHistory = true;
        async.series([
          server.ensureStarted.bind(server, settings)
        ], done);
      });

      it('[0P6S] must generate history when updating an event', function (done) {
        const updateData = {
          content: 'first updated content'
        };
        async.series([
          function updateEventOnce (stepDone) {
            request.put(pathToEvent(eventWithNoHistory.id)).send(updateData).end(function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.update.result
              });
              stepDone();
            });
          },
          function updateEventTwice (stepDone) {
            updateData.content = 'second updated content';
            request.put(pathToEvent(eventWithNoHistory.id)).send(updateData).end(function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.update.result
              });
              stepDone();
            });
          },
          function verifyThatHistoryIsIncludedAndSorted (stepDone) {
            request.get(pathToEvent(eventWithNoHistory.id))
              .query({ includeHistory: true }).end(
                function (res) {
                  validation.check(res, {
                    status: 200,
                    schema: eventsMethodsSchema.getOne.result
                  });
                  assert.exists(res.body);
                  assert.exists(res.body.history);
                  (res.body.history.length).should.eql(2);
                  const history = res.body.history;
                  let time = 0;
                  history.forEach(function (previousVersion) {
                    delete previousVersion.streamId;
                    (previousVersion.id).should.eql(eventWithNoHistory.id);
                    // check sorted by modified field
                    if (time !== 0) {
                      (previousVersion.modified).should.be.above(time);
                    }
                    time = previousVersion.modified;
                    (_.omit(previousVersion, ['modified', 'modifiedBy', 'content', 'tags', 'integrity']))
                      .should.eql(_.omit(eventWithNoHistory,
                        ['modified', 'modifiedBy', 'content', 'tags', 'integrity']));
                  });
                  stepDone();
                });
          }
        ], done);
      });

      it('[NZQB] must generate history when trashing an event', function (done) {
        async.series([
          function trashEvent (stepDone) {
            request.del(pathToEvent(eventWithNoHistory.id)).end(function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.update.result
              });
              stepDone();
            });
          },
          function verifyThatHistoryIsIncluded (stepDone) {
            request.get(pathToEvent(eventWithNoHistory.id))
              .query({ includeHistory: true }).end(
                function (res) {
                  validation.check(res, {
                    status: 200,
                    schema: eventsMethodsSchema.getOne.result
                  });
                  assert.exists(res.body);
                  assert.exists(res.body.history);
                  (res.body.history.length).should.eql(1);
                  const previousVersion = res.body.history[0];
                  delete previousVersion.streamId;
                  (previousVersion.id).should.eql(eventWithNoHistory.id);
                  (_.omit(previousVersion, ['modified', 'modifiedBy', 'trashed', 'integrity', 'tags']))
                    .should.eql(_.omit(eventWithNoHistory,
                      ['modified', 'modifiedBy', 'integrity', 'tags']));
                  stepDone();
                });
          }
        ], done);
      });
    });
  });

  describe('Streams', function () {
    before(function (done) {
      const settings = structuredClone(helpers.dependencies.settings);
      settings.versioning = {
        forceKeepHistory: true
      };
      server.ensureStarted(settings, done);
    });

    beforeEach(function (done) {
      async.series([
        testData.resetStreams,
        testData.resetEvents
      ], done);
    });

    it('[H1PK] must generate events\' history when their stream is deleted with ' +
    ' mergeEventsWithParents=true since their streamId is modified', function (done) {
      async.series([
        function deleteStream (stepDone) {
          request.del(pathToStream(childStream.id))
            .query({ mergeEventsWithParent: true }).end(function (res) {
              validation.check(res, {
                status: 200,
                schema: streamsMethodsSchema.del.result
              });
              res.body.streamDeletion.id.should.eql(childStream.id);
              stepDone();
            });
        },
        function verifyHistory (stepDone) {
          request.get(pathToEvent(eventOnChildStream.id)).query({ includeHistory: true })
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.getOne.result
              });
              const event = res.body.event;
              event.streamId.should.eql(normalStream.id);
              const history = res.body.history;
              assert.exists(history);
              history.length.should.eql(2);
              history.forEach(function (previousVersion) {
                previousVersion.id.should.eql(eventOnChildStream.id);
                previousVersion.streamId.should.eql(childStream.id);
              });
              stepDone();
            });
        }
      ], done);
    });

    it('[95TJ] must delete the events\' history when their stream is deleted with ' +
    ' mergeEventsWithParents=false and deletionMode=\'keep-nothing\'', function (done) {
      const settings = structuredClone(helpers.dependencies.settings);
      settings.versioning = {
        deletionMode: 'keep-nothing'
      };
      async.series([
        server.ensureStarted.bind(server, settings),
        function deleteStream (stepDone) {
          request.del(pathToStream(childStream.id)).query({ mergeEventsWithParent: false })
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: streamsMethodsSchema.del.result
              });
              res.body.streamDeletion.id.should.eql(childStream.id);
              stepDone();
            });
        },
        async function findDeletionInStorage () {
          const event = await mall.events.getOne(user.id, eventOnChildStream.id);
          assert.exists(event);
          event.id.should.eql(eventOnChildStream.id);
          assert.exists(event.deleted);
        },
        async function checkThatHistoryIsDeleted () {
          const events = await mall.events.getHistory(user.id, eventOnChildStream.id);
          events.length.should.be.eql(0);
        }
      ], done);
    });

    it('[4U91] must keep the events\' minimal history when their stream is deleted with ' +
    ' mergeEventsWithParents=false and deletionMode=\'keep-authors\'', function (done) {
      const settings = structuredClone(helpers.dependencies.settings);
      settings.versioning = {
        deletionMode: 'keep-authors'
      };
      async.series([
        server.ensureStarted.bind(server, settings),
        function deleteStream (stepDone) {
          request.del(pathToStream(childStream.id)).query({ mergeEventsWithParent: false })
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: streamsMethodsSchema.del.result
              });
              res.body.streamDeletion.id.should.eql(childStream.id);
              stepDone();
            });
        },
        async function verifyDeletedHeadInStorage () {
          const event = await mall.events.getOne(user.id, eventOnChildStream.id);

          assert.exists(event);
          (Object.keys(event).length).should.eql(integrity.events.isActive ? 5 : 4);
          event.id.should.eql(eventOnChildStream.id);
          assert.exists(event.deleted);
          assert.exists(event.modified);
          assert.exists(event.modifiedBy);
          if (integrity.events.isActive) assert.exists(event.integrity);
        },
        async function verifyDeletedHistoryInStorage () {
          const events = await mall.events.getHistory(user.id, eventOnChildStream.id);

          events.length.should.be.eql(1);
          events.forEach(function (event) {
            (Object.keys(event).length).should.eql(3);
            assert.exists(event.id);
            assert.equal(event.id, eventOnChildStream.id);
            assert.exists(event.modified);
            assert.exists(event.modifiedBy);
          });
        }
      ], done);
    });

    it('[D4CY] must not delete the events\' history when their stream is deleted with' +
    ' mergeEventsWithParents=false and deletionMode=\'keep-everything\'', function (done) {
      const settings = structuredClone(helpers.dependencies.settings);
      settings.versioning = {
        deletionMode: 'keep-everything'
      };
      async.series([
        server.ensureStarted.bind(server, settings),
        function deleteStream (stepDone) {
          request.del(pathToStream(childStream.id)).query({ mergeEventsWithParent: false })
            .end(function (res) {
              validation.check(res, {
                status: 200,
                schema: streamsMethodsSchema.del.result
              });
              res.body.streamDeletion.id.should.eql(childStream.id);
              stepDone();
            });
        },
        async function verifyDeletedHeadInStory () {
          const event = await mall.events.getOne(user.id, eventOnChildStream.id);

          assert.exists(event);
          const expected = structuredClone(eventOnChildStream);
          delete expected.streamId;
          expected.deleted = event.deleted;
          // we can remove tags as it comes from the db
          delete expected.tags;
          integrity.events.set(expected);
          event.should.eql(expected);
        },
        async function checkThatHistoryIsUnchanged () {
          const events = await mall.events.getHistory(user.id, eventOnChildStream.id);

          (events.length).should.eql(1);
          events.forEach(function (event) {
            event.id.should.eql(eventOnChildStream.id);
            if (event.id === testData.events[26].id) {
              // we can remove tags as it comes from the db
              const expected = structuredClone(testData.events[26]);
              delete expected.tags;
              event.should.eql(expected);
            }
          });
        }
      ], done);
    });
  });

  describe('Users', function () {
    const req = require('superagent');
    before(async function () {
      const settings = structuredClone(helpers.dependencies.settings);
      settings.versioning = {
        forceKeepHistory: true
      };
      settings.dnsLess = { isActive: true, publicUrl: 'http://127.0.0.1:3000/' };
      await server.ensureStartedAsync(settings);
    });

    function buildPath (path) {
      return new URL(path, server.url).toString();
    }
    function generateRegisterBody () {
      return {
        username: charlatan.Lorem.characters(7),
        password: charlatan.Lorem.characters(7),
        email: charlatan.Internet.email(),
        appId: charlatan.Lorem.characters(7),
        insurancenumber: charlatan.Number.number(3),
        phoneNumber: charlatan.Number.number(3)
      };
    }
    function extractToken (apiEndpoint) {
      const hostname = apiEndpoint.split('//')[1];
      return hostname.split('@')[0];
    }

    it('[4ETL] must allow reusing unique values after they are in history', async () => {
      /**
       * 1. create user
       * 2. change unique field value
       * 3. ensure it is there in history
       * 4. create user with same unique value - must pass
       */

      // 1.
      const user1 = generateRegisterBody();
      const res = await req
        .post(buildPath('/users'))
        .send(user1);
      const token = extractToken(res.body.apiEndpoint);
      const resEvents = await req
        .get(buildPath(`/${user1.username}/events`))
        .set('Authorization', token)
        .query({ streams: [SystemStreamSerializer.addCustomerPrefixToStreamId('email')] });
      const oldEmailEvent = resEvents.body.events[0];

      // 2.
      await req
        .put(buildPath(`/${user1.username}/events/${oldEmailEvent.id}`))
        .set('Authorization', token)
        .send({
          content: charlatan.Internet.email()
        });

      // 3.
      const resGet = await req
        .get(buildPath(`/${user1.username}/events/${oldEmailEvent.id}`))
        .set('Authorization', token)
        .query({ includeHistory: true });
      assert.equal(resGet.body.history[0].content, oldEmailEvent.content);

      // 4.
      const user2 = _.merge(generateRegisterBody(), { email: oldEmailEvent.content });
      const res2 = await req
        .post(buildPath('/users'))
        .send(user2);
      const token2 = extractToken(res2.body.apiEndpoint);
      const resEvents2 = await req
        .get(buildPath(`/${user2.username}/events`))
        .set('Authorization', token2)
        .query({ streams: [SystemStreamSerializer.addCustomerPrefixToStreamId('email')] });
      const emailEvent = resEvents2.body.events[0];
      assert.equal(emailEvent.content, oldEmailEvent.content);
    });
  });
});
