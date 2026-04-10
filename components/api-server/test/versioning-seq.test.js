/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const async = require('async');
const _ = require('lodash');
const charlatan = require('charlatan');
const cuid = require('cuid');
const assert = require('node:assert');

const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const validation = helpers.validation;
const eventsMethodsSchema = require('../src/schema/eventsMethods');
const streamsMethodsSchema = require('../src/schema/streamsMethods');
const testData = helpers.dynData({ prefix: 'vers' });
const { addCustomerPrefixToStreamId } = require('test-helpers/src/systemStreamFilters');
const { integrity } = require('business');
const { getMall } = require('mall');

require('date-utils');

describe('[VERS] Versioning', function () {
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
    // Clean up the personal access created by login
    const accessStorage = helpers.dependencies.storage.user.accesses;
    accessStorage.removeOne(user, { token: request.token }, (err) => {
      if (err) return done(err);
      const settings = structuredClone(helpers.dependencies.settings);
      settings.versioning = {
        forceKeepHistory: false,
        deletionMode: 'keep-nothing'
      };
      server.ensureStarted(settings, done);
    });
  });

  after(async function () {
    await testData.cleanup();
  });

  const eventWithHistory = testData.events[16];
  const trashedEventWithHistory = testData.events[19];
  const eventWithNoHistory = testData.events[22];
  const eventOnChildStream = testData.events[25];

  const normalStream = testData.streams[7];
  const childStream = normalStream.children[0];

  describe('[VE01] Events', function () {
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
        assert.ok(events.length > 0);
        events.forEach(function (event) {
          assert.ok(event.headId == null);
        });
        done();
      });
    });

    describe('[VE02] deletionMode', function () {
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
                assert.strictEqual(res.body.eventDeletion.id, trashedEventWithHistory.id);
                stepDone();
              });
            },
            async function findDeletionInStorageAndCheckThatHistoryIsDeleted () {
              const event = await mall.events.getOne(user.id, trashedEventWithHistory.id);
              const eventHistory = await mall.events.getHistory(user.id, trashedEventWithHistory.id);
              assert.strictEqual(eventHistory.length, 0); // empty history
              assert.ok(event.deleted);
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
              assert.ok(deletedEvent);

              assert.strictEqual(Object.keys(deletedEvent).length, integrity.events.isActive ? 5 : 4);
              assert.strictEqual(deletedEvent.id, trashedEventWithHistory.id);
              assert.ok(deletedEvent.deleted);
              assert.ok(deletedEvent.modified);
              assert.ok(deletedEvent.modifiedBy);
              if (integrity.events.isActive) assert.ok(deletedEvent.integrity);

              const eventHistory = await mall.events.getHistory(user.id, trashedEventWithHistory.id);
              assert.strictEqual(eventHistory.length, 2);
              eventHistory.forEach(function (event) {
                // integrity is lost
                assert.strictEqual(Object.keys(event).length, 3);
                assert.ok(event.id);
                assert.strictEqual(event.id, trashedEventWithHistory.id);
                assert.ok(event.modified);
                assert.ok(event.modifiedBy);
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
            assert.ok(event);
            const expected = structuredClone(trashedEventWithHistory);

            expected.deleted = event.deleted;
            integrity.events.set(expected);
            assert.deepStrictEqual(event, expected);
          },
          async function checkThatHistoryIsUnchanged () {
            const eventHistory = await mall.events.getHistory(user.id, trashedEventWithHistory.id);

            // TODO clean this test
            const checked = { first: false, second: false };
            assert.strictEqual(eventHistory.length, 2);
            eventHistory.forEach(function (event) {
              if (event.modified === testData.events[20].modified) {
                const expected = structuredClone(testData.events[20]);
                expected.id = expected.headId;
                delete expected.headId;
                assert.deepStrictEqual(event, expected);
                checked.first = true;
              } else if (event.modified === testData.events[21].modified) {
                const expected = structuredClone(testData.events[21]);
                expected.id = expected.headId;
                delete expected.headId;
                assert.deepStrictEqual(event, expected);
                checked.second = true;
              }
            });
            assert.deepStrictEqual(checked, { first: true, second: true });
          }
        ], done);
      });
    });

    describe('[VE03] events.getOne', function () {
      it('[YRI7] must not return an event\'s history when calling getOne with includeHistory flag off',
        function (done) {
          request.get(pathToEvent(eventWithHistory.id)).query({ includeHistory: false }).end(
            function (res) {
              validation.check(res, {
                status: 200,
                schema: eventsMethodsSchema.getOne.result
              });
              assert.ok(res.body.history == null);
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
              assert.ok(res.body.history);

              done();
            }
          );
        });
    });

    describe('[VE04] forceKeepHistory is OFF', function () {
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
                assert.ok(res.body);
                assert.strictEqual(res.body.history.length, 0);
                stepDone();
              });
          }
        ], done);
      });
    });

    describe('[VE05] forceKeepHistory is ON', function () {
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
                  assert.ok(res.body);
                  assert.ok(res.body.history);
                  assert.strictEqual(res.body.history.length, 2);
                  const history = res.body.history;
                  let time = 0;
                  history.forEach(function (previousVersion) {
                    assert.strictEqual(previousVersion.id, eventWithNoHistory.id);
                    // check sorted by modified field
                    if (time !== 0) {
                      assert.ok(previousVersion.modified > time);
                    }
                    time = previousVersion.modified;
                    assert.deepStrictEqual(_.omit(previousVersion, ['modified', 'modifiedBy', 'content', 'integrity']),
                      _.omit(eventWithNoHistory, ['modified', 'modifiedBy', 'content', 'integrity']));
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
                  assert.ok(res.body);
                  assert.ok(res.body.history);
                  assert.strictEqual(res.body.history.length, 1);
                  const previousVersion = res.body.history[0];
                  assert.strictEqual(previousVersion.id, eventWithNoHistory.id);
                  assert.deepStrictEqual(_.omit(previousVersion, ['modified', 'modifiedBy', 'trashed', 'integrity']),
                    _.omit(eventWithNoHistory, ['modified', 'modifiedBy', 'integrity']));
                  stepDone();
                });
          }
        ], done);
      });
    });
  });

  describe('[VE06] Streams', function () {
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
              assert.strictEqual(res.body.streamDeletion.id, childStream.id);
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
              assert.strictEqual(event.streamIds[0], normalStream.id);
              const history = res.body.history;
              assert.ok(history);
              assert.strictEqual(history.length, 2);
              history.forEach(function (previousVersion) {
                assert.strictEqual(previousVersion.id, eventOnChildStream.id);
                assert.strictEqual(previousVersion.streamIds[0], childStream.id);
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
              assert.strictEqual(res.body.streamDeletion.id, childStream.id);
              stepDone();
            });
        },
        async function findDeletionInStorage () {
          const event = await mall.events.getOne(user.id, eventOnChildStream.id);
          assert.ok(event);
          assert.strictEqual(event.id, eventOnChildStream.id);
          assert.ok(event.deleted);
        },
        async function checkThatHistoryIsDeleted () {
          const events = await mall.events.getHistory(user.id, eventOnChildStream.id);
          assert.strictEqual(events.length, 0);
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
              assert.strictEqual(res.body.streamDeletion.id, childStream.id);
              stepDone();
            });
        },
        async function verifyDeletedHeadInStorage () {
          const event = await mall.events.getOne(user.id, eventOnChildStream.id);

          assert.ok(event);
          assert.strictEqual(Object.keys(event).length, integrity.events.isActive ? 5 : 4);
          assert.strictEqual(event.id, eventOnChildStream.id);
          assert.ok(event.deleted);
          assert.ok(event.modified);
          assert.ok(event.modifiedBy);
          if (integrity.events.isActive) assert.ok(event.integrity);
        },
        async function verifyDeletedHistoryInStorage () {
          const events = await mall.events.getHistory(user.id, eventOnChildStream.id);

          assert.strictEqual(events.length, 1);
          events.forEach(function (event) {
            assert.strictEqual(Object.keys(event).length, 3);
            assert.ok(event.id);
            assert.strictEqual(event.id, eventOnChildStream.id);
            assert.ok(event.modified);
            assert.ok(event.modifiedBy);
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
              assert.strictEqual(res.body.streamDeletion.id, childStream.id);
              stepDone();
            });
        },
        async function verifyDeletedHeadInStory () {
          const event = await mall.events.getOne(user.id, eventOnChildStream.id);

          assert.ok(event);
          const expected = structuredClone(eventOnChildStream);
          expected.deleted = event.deleted;
          integrity.events.set(expected);
          assert.deepStrictEqual(event, expected);
        },
        async function checkThatHistoryIsUnchanged () {
          const events = await mall.events.getHistory(user.id, eventOnChildStream.id);

          assert.strictEqual(events.length, 1);
          events.forEach(function (event) {
            assert.strictEqual(event.id, eventOnChildStream.id);
            if (event.id === testData.events[26].id) {
              const expected = structuredClone(testData.events[26]);
              assert.deepStrictEqual(event, expected);
            }
          });
        }
      ], done);
    });
  });

  describe('[VE07] Users', function () {
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
        // Use cuid for unique username to avoid parallel test conflicts
        username: 'vers' + cuid.slug().toLowerCase(),
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
        .query({ streams: [addCustomerPrefixToStreamId('email')] });
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
      assert.strictEqual(resGet.body.history[0].content, oldEmailEvent.content);

      // 4.
      const user2 = _.merge(generateRegisterBody(), { email: oldEmailEvent.content });
      const res2 = await req
        .post(buildPath('/users'))
        .send(user2);
      const token2 = extractToken(res2.body.apiEndpoint);
      const resEvents2 = await req
        .get(buildPath(`/${user2.username}/events`))
        .set('Authorization', token2)
        .query({ streams: [addCustomerPrefixToStreamId('email')] });
      const emailEvent = resEvents2.body.events[0];
      assert.strictEqual(emailEvent.content, oldEmailEvent.content);
    });
  });
});
