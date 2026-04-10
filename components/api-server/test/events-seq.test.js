/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const supertest = require('supertest');
const async = require('async');
const fs = require('fs');
const timestamp = require('unix-timestamp');
const _ = require('lodash');

require('./test-helpers');

const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const attachmentsCheck = helpers.attachmentsCheck;
const commonTests = helpers.commonTests;
const validation = helpers.validation;
const ErrorIds = require('errors').ErrorIds;
const methodsSchema = require('../src/schema/eventsMethods');
const testData = helpers.dynData({ prefix: 'evnt' });
const addCorrectAttachmentIds = testData.addCorrectAttachmentIds;

const { integrity } = require('business');
const { getMall } = require('mall');

require('date-utils');

describe('[EVNT] events', function () {
  const user = structuredClone(testData.users[0]);
  const basePath = '/' + user.username + '/events';
  const testType = 'test/test';
  // these must be set after server instance started
  let request = null;
  let access = null;
  const filesReadTokenSecret = helpers.dependencies.settings.auth.filesReadTokenSecret;

  let mall;

  before(async function () {
    mall = await getMall();
  });

  function path (id, base) {
    return (base || basePath) + '/' + id;
  }

  // to verify data change notifications
  let eventsNotifCount;
  server.on('test-events-changed', function () { eventsNotifCount++; });

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetStreams,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      },
      function (stepDone) {
        helpers.dependencies.storage.user.accesses.findOne(user, { token: request.token },
          null, function (err, acc) {
            assert.ok(err == null);
            access = acc;
            stepDone();
          });
      }
    ], done);
  });

  after(async function () {
    await testData.cleanup();
  });

  describe('[EV01] GET /', function () {
    before(resetEvents);

    it('[WC8C] must return the last 20 non-trashed events (sorted descending) by default',
      function (done) {
        const additionalEvents = [];
        for (let i = 0; i < 50; i++) {
          additionalEvents.push({
            id: (100 + i).toString(),
            time: timestamp.now('-' + (48 + i) + 'h'),
            type: testType,
            streamIds: [testData.streams[i % 2].id],
            created: timestamp.now('-' + (48 + i) + 'h'),
            createdBy: 'test',
            modified: timestamp.now('-' + (48 + i) + 'h'),
            modifiedBy: 'test'
          });
        }
        let response;
        let allEvents;
        let accountStreamsEvents;
        async.series([
          async function createEvents () {
            for (const event of additionalEvents) await mall.events.create(user.id, event);
          },
          function getDefault (stepDone) {
            request.get(basePath).end(function (res) {
              response = res;
              allEvents = additionalEvents
                .concat(validation.removeDeletionsAndHistory(testData.events))
                .filter(function (e) {
                  return !e.trashed && !_.some(testData.streams, containsTrashedEventStream);
                  function containsTrashedEventStream (stream) {
                    return (stream.trashed && stream.id === e.streamIds[0]) ||
                      _.some(stream.children, containsTrashedEventStream);
                  }
                });
              stepDone();
            });
          },
          function separateAccountEventAndAllOtherEvents (stepDone) {
            // lets separate core events from all other events and validate them separatelly
            const separatedEvents = validation.separateAccountStreamsAndOtherEvents(response.body.events);
            response.body.events = separatedEvents.events;
            accountStreamsEvents = separatedEvents.accountStreamsEvents;
            stepDone();
          },
          function checkResponse (stepDone) {
            const allEventsCorrected = addCorrectAttachmentIds(allEvents);
            const body = { events: _.take(_.sortBy(allEventsCorrected, 'time').reverse(), 20 - accountStreamsEvents.length) };

            validation.check(response, {
              status: 200,
              schema: methodsSchema.get.result,
              sanitizeFn: validation.sanitizeEvents,
              sanitizeTarget: 'events',
              body
            }, stepDone);
          },
          testData.resetEvents
        ], done);
      });

    it('[U8U9] must only return events for the given streams (incl. sub-streams) when set',
      function (done) {
        const params = {
          streams: [testData.streams[0].id, testData.streams[2].id],
          fromTime: timestamp.now('-48h'),
          sortAscending: false // explicitly set default value to check it works too...
        };
        request.get(basePath).query(params).end(function (res) {
          const correctedEvents = addCorrectAttachmentIds(_.at(testData.events, 9, 7, 6, 4, 3, 2, 1, 0));
          validation.check(res, {
            status: 200,
            schema: methodsSchema.get.result,
            sanitizeFn: validation.sanitizeEvents,
            sanitizeTarget: 'events',
            body: {
              events: correctedEvents
            }
          }, done);
        });
      });

    // [S0M6] Duplicate of events-patternc.test.js [PC03] - removed

    it('[QR4I] must only return events of any of the given types when set', function (done) {
      const params = {
        types: ['picture/attached', 'note/webclip'],
        state: 'all'
      };
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events: addCorrectAttachmentIds(_.at(testData.events, 12, 4, 2))
          }
        }, done);
      });
    });

    it('[TWP8] must (unofficially) support a wildcard for event types', function (done) {
      const params = {
        types: ['activity/*'],
        state: 'all'
      };
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events'
        });
        assert.ok(res.body.events.some(e => e.id === testData.events[8].id)); // activity/test
        assert.ok(res.body.events.some(e => e.id === testData.events[9].id)); // activity/pryv
        done();
      });
    });

    // [4TWI] Duplicate of events-patternc.test.js [PC05] - removed

    it('[7MOU] must only return events in the given time period sorted ascending when set',
      function (done) {
        const params = {
          // must also include already started but overlapping events
          fromTime: timestamp.add(testData.events[1].time, '58m'),
          toTime: testData.events[3].time,
          sortAscending: true
        };
        request.get(basePath).query(params).end(function (res) {
          validation.check(res, {
            status: 200,
            schema: methodsSchema.get.result,
            sanitizeFn: validation.sanitizeEvents,
            sanitizeTarget: 'events',
            body: {
              events: addCorrectAttachmentIds(_.at(testData.events, 1, 2, 3))
            }
          }, done);
        });
      });

    it('[W5IT] must take into account fromTime and toTime even if set to 0', function (done) {
      const params = {
        fromTime: 0,
        toTime: 0
      };
      const events = testData.events.filter(function (e) {
        return e.time === 0;
      });
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events
          }
        }, done);
      });
    });

    it('[Y6SY] must take into account modifiedSince even if set to 0', function (done) {
      const params = {
        modifiedSince: 0
      };

      request.get(basePath).query(params).end(function (res) {
        const separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
        res.body.events = separatedEvents.events;
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result
        });
        assert.ok(!res.body.events.some(e => e.id === testData.events[27].id));
        done();
      });
    });

    it('[QNDP] must properly exclude period events completed before the given period', function (done) {
      const params = {
        fromTime: testData.events[1].time + testData.events[1].duration + 1,
        toTime: timestamp.add(testData.events[3].time, '-1m')
      };
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events: addCorrectAttachmentIds(_.at(testData.events, 2))
          }
        }, done);
      });
    });

    it('[5UFW] must return ongoing events started before the given time period', function (done) {
      const params = {
        streams: [testData.streams[0].id],
        fromTime: testData.events[9].time + 1,
        toTime: timestamp.now()
      };
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events: _.at(testData.events, 9)
          }
        }, done);
      });
    });

    it('[S9J4] must only return events in the given paging range when set', function (done) {
      request.get(basePath).query({ state: 'all', skip: 1, limit: 3 }).end(function (res) {
        const events = (validation.removeDeletionsAndHistory(testData.events)).sort(function (a, b) {
          return (b.time - a.time);
        }).slice(1, 4);
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events
          }
        }, done);
      });
    });

    it('[915E] must return only trashed events when requested', function (done) {
      request.get(basePath).query({ state: 'trashed' }).end(function (res) {
        const events = (validation.removeDeletionsAndHistory(testData.events)).sort(function (a, b) {
          return (b.time - a.time);
        });
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: { events: _.filter(events, { trashed: true }) }
        }, done);
      });
    });

    it('[6H0Z] must return all events (trashed or not) when requested', function (done) {
      request.get(basePath).query({ state: 'all', limit: 1000 }).end(function (res) {
        // lets separate core events from all other events and validate them separatelly
        const separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
        res.body.events = separatedEvents.events;
        const actualAccountStreamsEvents = separatedEvents.accountStreamsEvents;
        validation.validateAccountEvents(actualAccountStreamsEvents);

        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events: addCorrectAttachmentIds(_.sortBy(validation.removeDeletionsAndHistory(testData.events), 'time')
              .reverse())
          }
        }, done);
      });
    });

    it('[JZYF] must return only events modified since the given time when requested', function (done) {
      const params = {
        state: 'all',
        modifiedSince: timestamp.now('-45m')
      };
      let events = validation.removeDeletionsAndHistory(testData.events).filter(function (e) {
        return e.modified >= timestamp.now('-45m');
      });
      events = events.sort(function (a, b) {
        return (b.time - a.time);
      });
      request.get(basePath).query(params).end(async function (res) {
        // lets separate core events from all other events and validate them separatelly
        const separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
        res.body.events = separatedEvents.events;
        const actualAccountStreamsEvents = separatedEvents.accountStreamsEvents;
        validation.validateAccountEvents(actualAccountStreamsEvents);

        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events: addCorrectAttachmentIds(events)
          }
        }, done);
      });
    });

    // [C3HU] Duplicate of events-patternc.test.js [PC11] - removed

    it('[B766] must include event deletions (since that time) when requested', async function () {
      const params = {
        state: 'all',
        modifiedSince: timestamp.now('-45m'),
        includeDeletions: true
      };
      let events = structuredClone(testData.events).sort(function (a, b) {
        return (b.time - a.time);
      });
      const eventDeletions = events.filter(function (e) {
        return (e.deleted && e.deleted > timestamp.now('-45m'));
      }).map(function (e) {
        if (e.type != null) {
          return { id: e.id, deleted: e.deleted };
        }
        return e;
      });

      events = validation.removeDeletionsAndHistory(events).filter(function (e) {
        return (e.modified >= timestamp.now('-45m'));
      });

      const res = await request.get(basePath).query(params);
      // lets separate core events from all other events and validate them separately
      const separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
      res.body.events = separatedEvents.events;
      const actualAccountStreamsEvents = separatedEvents.accountStreamsEvents;
      validation.validateAccountEvents(actualAccountStreamsEvents);
      validation.check(res, {
        status: 200,
        schema: methodsSchema.get.result,
        sanitizeFn: validation.sanitizeEvents,
        sanitizeTarget: 'events',
        body: {
          events: addCorrectAttachmentIds(events),
          eventDeletions
        }
      });
    });

    it('[V72A] must only return running period event(s) when requested', function (done) {
      const params = {
        running: true
      };
      const events = validation.removeDeletionsAndHistory(testData.events).filter(function (e) {
        return e.duration === null;
      }).sort(function (a, b) {
        return b.time - a.time;
      });
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events: addCorrectAttachmentIds(events)
          }
        }, done);
      });
    });

    it('[68IL] must return an error if no access token is provided', function (done) {
      commonTests.checkAccessTokenAuthentication(server.url, basePath, done);
    });
  });

  describe('[EV02] GET /<event id>/<file id>', function () {
    before(resetEvents);

    it('[F29M] must return the attached file with the correct headers', function (done) {
      const event = testData.events[0];
      const attachment = event.attachments[0];
      const effectiveAttachmentId = testData.dynCreateAttachmentIdMap[event.id][0].id;

      request.get(path(event.id) + '/' + effectiveAttachmentId).end(function (res) {
        assert.strictEqual(res.statusCode, 200);

        assert.strictEqual(res.headers['content-type'], attachment.type);
        assert.strictEqual(res.headers['content-length'], attachment.size.toString());

        done();
      });
    });

    it('[PP6G] must return readToken in attachments', function (done) {
      const event = testData.events[0];

      request.get(path(event.id) + '/').end(function (res) {
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.body.event.attachments);
        res.body.event.attachments.forEach(attachment => {
          assert.ok(attachment.readToken);
        });

        done();
      });
    });

    it('[NL65] must accept a secure read token in the query string instead of the `"Authorization" header',
      function (done) {
        const event = testData.events[0];
        const attIndex = 0;
        async.waterfall([
          function retrieveAttachmentInfo (stepDone) {
            request.get(basePath).query({ sortAscending: true, streams: event.streamIds[0] }).end(function (res) {
              stepDone(null, res.body.events[0].attachments[attIndex]);
            });
          },
          function retrieveAttachedFile (att, stepDone) {
            request.get(path(event.id) + '/' + att.id)
              .unset('Authorization')
              .query({ readToken: att.readToken })
              .end(function (res) {
                assert.strictEqual(res.statusCode, 200);

                assert.strictEqual(res.headers['content-type'], att.type);
                assert.strictEqual(res.headers['content-length'], att.size.toString());

                stepDone();
              });
          }
        ], done);
      });

    it('[ZDY4] must accept special chars in Content-Disposition header', function (done) {
      const event = testData.events[0];
      const attIndex = 1;
      async.waterfall([
        function retrieveAttachmentInfo (stepDone) {
          request.get(basePath).query({ sortAscending: true, streams: event.streamIds[0] }).end(function (res) {
            stepDone(null, res.body.events[0].attachments[attIndex]);
          });
        },
        function retrieveAttachedFile (att, stepDone) {
          request.get(path(event.id) + '/' + att.id)
            .unset('Authorization')
            .query({ readToken: att.readToken })
            .end(function (res) {
              assert.strictEqual(res.statusCode, 200);
              assert.strictEqual(res.headers['content-type'], att.type);
              assert.strictEqual(res.headers['content-length'], att.size.toString());
              assert.strictEqual(res.headers['content-disposition'], 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(att.fileName));
              stepDone();
            });
        }
      ], done);
    });

    it('[TN27] must allow a filename path suffix after the file id', function (done) {
      const event = testData.events[0];
      const attIndex = 1;
      async.waterfall([
        function retrieveAttachmentInfo (stepDone) {
          request.get(basePath).query({ sortAscending: true, streams: event.streamIds[0] }).end(function (res) {
            stepDone(null, res.body.events[0].attachments[attIndex]);
          });
        },
        function retrieveAttachedFile (att, stepDone) {
          request.get(path(event.id) + '/' + att.id + '/' + att.fileName)
            .unset('Authorization')
            .query({ readToken: att.readToken })
            .end(function (res) {
              assert.strictEqual(res.statusCode, 200);

              assert.strictEqual(res.headers['content-type'], att.type);
              assert.strictEqual(res.headers['content-length'], att.size.toString());

              stepDone();
            });
        }
      ], done);
    });

    it('[LOUB] must allow any filename (including special characters)', function (done) {
      const event = testData.events[0];
      const attIndex = 1;
      async.waterfall(
        [
          function retrieveAttachmentInfo (stepDone) {
            request
              .get(`/${user.username}/events/${event.id}`)
              .query({ sortAscending: true, streams: [event.streamIds[0]] })
              .end(function (res) {
                stepDone(null, res.body.event.attachments[attIndex]);
              });
          },
          function retrieveAttachedFile (att, stepDone) {
            request
              .get(
                path(event.id) +
                  '/' +
                  att.id +
                  '/1Q84%20%28Livre%201%20-%20Avril-juin%29%20-%20Murakami%2CHaruki.mobi'
              )
              .unset('Authorization')
              .query({ readToken: att.readToken })
              .end(function (res) {
                assert.strictEqual(res.statusCode, 200);
                stepDone();
              });
          }
        ],
        done
      );
    });

    it('[9NJ0] must refuse an invalid file read token', function (done) {
      const event = testData.events[0];
      request.get(path(event.id) + '/' + event.attachments[0].id)
        .unset('Authorization')
        .query({ readToken: access.id + '-Bad-HMAC' })
        .end(function (res) {
          validation.checkError(res, {
            status: 401,
            id: ErrorIds.InvalidAccessToken
          }, done);
        });
    });

    it('[9HNM] must refuse auth via the regular "auth" query string parameter', function (done) {
      const event = testData.events[0];
      request.get(path(event.id) + '/' + event.attachments[0].id)
        .unset('Authorization')
        .query({ auth: access.token })
        .end(function (res) {
          validation.checkError(res, {
            status: 401,
            id: ErrorIds.InvalidAccessToken
          }, done);
        });
    });

    it('[MMCZ] must return a proper error if trying to get an unknown attachment', function (done) {
      const event = testData.events[0];
      request.get(path(event.id) + '/unknown-file-id').end(function (res) {
        validation.checkError(res, {
          status: 404,
          id: ErrorIds.UnknownResource
        }, done);
      });
    });
  });

  describe('[EV03] POST /', function () {
    beforeEach(resetEvents);

    it('[1GR6] must create an event with the sent data, returning it', function (done) {
      const data = {
        time: timestamp.fromDate('2012-03-22T10:00'),
        duration: timestamp.duration('55m'),
        type: 'temperature/celsius',
        content: 36.7,
        streamIds: [testData.streams[0].id],
        description: 'Test description',
        clientData: {
          testClientDataField: 'testValue'
        },
        // check if properly ignored
        created: timestamp.now('-1h'),
        createdBy: 'should-be-ignored',
        modified: timestamp.now('-1h'),
        modifiedBy: 'should-be-ignored'
      };
      const expected = structuredClone(data);

      let originalCount;
      let createdEventId;
      let created;

      async.series([
        async function countInitialEvents () {
          const events = await mall.events.get(user.id, {});
          originalCount = events.length;
        },
        function addNewEvent (stepDone) {
          request.post(basePath).send(data).end(function (res) {
            const event = res?.body.event;
            assert.ok(event);
            assert.notStrictEqual(event.created, data.created);
            assert.notStrictEqual(event.createdBy, data.createdBy);
            assert.notStrictEqual(event.modified, data.modified);
            assert.notStrictEqual(event.modifiedBy, data.modifiedBy);
            expected.created = event.created;
            expected.createdBy = event.createdBy;
            expected.modified = event.modified;
            expected.modifiedBy = event.modifiedBy;
            expected.id = event.id;
            integrity.events.set(expected);
            validation.check(res, {
              status: 201,
              schema: methodsSchema.create.result,
              body: { event: expected }
            });
            created = timestamp.now();
            createdEventId = res.body.event.id;
            assert.strictEqual(eventsNotifCount, 1, 'events notifications');
            stepDone();
          });
        },
        async function verifyEventData () {
          const events = await mall.events.get(user.id, {});

          assert.strictEqual(events.length, originalCount + 1, 'events');

          const expected = structuredClone(data);

          expected.id = createdEventId;
          expected.created = expected.modified = created;
          expected.createdBy = expected.modifiedBy = access.id;
          const actual = _.find(events, function (event) {
            return event.id === createdEventId;
          });
          validation.checkStoredItem(actual, 'event');
          validation.checkObjectEquality(actual, expected);
        }
      ], done);
    });

    // [QSBV] Duplicate of events-patternc.test.js [PC21] - removed
    // [6BVW] Duplicate of events-patternc.test.js [PC22] - removed
    // [D2TH] Duplicate of events-patternc.test.js [PC23] - removed

    it('[WN86] must return a correct error if an event with the same id already exists', function (done) {
      const data = {
        id: testData.events[0].id,
        streamIds: [testData.streams[2].id],
        type: 'test/test'
      };
      request.post(basePath).send(data).end(function (res) {
        validation.checkError(res, {
          status: 409,
          id: ErrorIds.ItemAlreadyExists,
          data: { id: data.id }
        }, done);
      });
    });

    it('[94PW] must not allow reuse of deleted ids (unlike streams)', function (done) {
      const data = {
        id: testData.events[13].id, // existing deletion
        streamIds: [testData.streams[2].id],
        type: 'test/test'
      };
      request.post(basePath).send(data).end(function (res) {
        validation.checkError(res, {
          status: 409,
          id: ErrorIds.ItemAlreadyExists,
          data: { id: data.id }
        }, done);
      });
    });

    // [DRFA] Duplicate of events-patternc.test.js [PC25] - removed

    it('[UL6Y] must not stop the running period event if the stream allows overlapping', function (done) {
      const data = {
        streamIds: [testData.streams[1].id],
        duration: timestamp.duration('1h'),
        type: testType
      };
      async.series([
        function addNew (stepDone) {
          request.post(basePath).send(data).end(function (res) {
            assert.ok(res.body.stoppedId == null);
            validation.check(res, {
              status: 201,
              schema: methodsSchema.create.result
            }, stepDone);
          });
        },
        async function verifyData () {
          const event = await mall.events.getOne(user.id, testData.events[11].id);
          const expected = structuredClone(testData.events[11]);
          assert.deepStrictEqual(event, expected);
        }
      ], done);
    });

    // [FZ4T] Duplicate of events-patternc.test.js [PC28] - removed
    // [EL88] Duplicate of events-patternc.test.js [PC34] - removed
    // [JUM6] Duplicate of events-patternc.test.js [PC29] - removed
    // [5NEL] Duplicate of events-patternc.test.js [PC30] - removed

    it('[3S2T] must allow the event\'s period overlapping existing periods when the stream allows it',
      function (done) {
        const data = {
          streamIds: [testData.streams[1].id],
          time: timestamp.add(testData.events[11].time, '-15m'),
          duration: timestamp.duration('5h30m'),
          type: testType
        };
        request.post(basePath).send(data).end(function (res) {
          validation.check(res, {
            status: 201,
            schema: methodsSchema.create.result
          }, done);
        });
      });

    // [Q0L6] Duplicate of events-patternc.test.js [PC31] - removed
    // [WUSC] Duplicate of events-patternc.test.js [PC32] - removed
    // [Z87W] Duplicate of events-patternc.test.js [PC33] - removed
  });

  describe('[EV04] POST / (multipart content)', function () {
    beforeEach(resetEvents);

    it('[4CUV] must create a new event with the uploaded files', function (finalDone) {
      const data = {
        time: timestamp.now(),
        type: 'wisdom/test',
        content: {
          chapterOne: '道 可 道 非 常 道...'
        },
        streamIds: [testData.streams[0].id]
      };
      async.series([
        postEventsWithAttachments,
        checkEvents
      ], finalDone);

      let createdEvent; // set by postEventsWithAttachments reused by checkEvents
      let expected; // set by postEventsWithAttachments reused by checkEvents
      function postEventsWithAttachments (done) {
        request.post(basePath)
          .field('event', JSON.stringify(data))
          .attach('document', testData.attachments.document.path,
            testData.attachments.document.filename)
          .attach('image', testData.attachments.image.path,
            testData.attachments.image.filename)
          .end(async function (res) {
            try {
              validation.check(res, {
                status: 201,
                schema: methodsSchema.create.result
              });

              createdEvent = res.body.event;

              validation.checkFilesReadToken(createdEvent, access, filesReadTokenSecret);
              validation.sanitizeEvent(createdEvent);
              expected = _.extend(data, {
                id: createdEvent.id,
                integrity: createdEvent.integrity,
                attachments: [
                  {
                    id: createdEvent.attachments[0].id,
                    fileName: testData.attachments.document.filename,
                    type: testData.attachments.document.type,
                    size: testData.attachments.document.size,
                    integrity: testData.attachments.document.integrity
                  },
                  {
                    id: createdEvent.attachments[1].id,
                    fileName: testData.attachments.image.filename,
                    type: testData.attachments.image.type,
                    size: testData.attachments.image.size,
                    integrity: testData.attachments.image.integrity
                  }
                ],
                streamIds: data.streamIds
              });

              expected.created = createdEvent.created;
              expected.createdBy = createdEvent.createdBy;
              expected.modified = createdEvent.modified;
              expected.modifiedBy = createdEvent.modifiedBy;
              if (!integrity.attachments.isActive) {
                delete expected.attachments[0].integrity;
                delete expected.attachments[1].integrity;
              }
              if (!integrity.events.isActive) {
                delete expected.integrity;
              }
              integrity.events.set(expected);
              validation.checkObjectEquality(createdEvent, expected);

              // check attached files
              assert.strictEqual(await attachmentsCheck.compareTestAndAttachedFiles(user, createdEvent.id,
                createdEvent.attachments[0].id,
                testData.attachments.document.filename), true);
              assert.strictEqual(await attachmentsCheck.compareTestAndAttachedFiles(user, createdEvent.id,
                createdEvent.attachments[1].id,
                testData.attachments.image.filename), true);

              assert.strictEqual(eventsNotifCount, 1, 'events notifications');

              done();
            } catch (e) {
              done(e);
            }
          });
      }

      function checkEvents (done) {
        request.get(basePath + '/' + createdEvent.id).end(function (res) {
          validation.checkObjectEquality(validation.sanitizeEvent(res.body.event), expected);
          done();
        });
      }
    });

    it('[HROI] must properly handle part names containing special chars (e.g. ".", "$")', function (done) {
      const data = {
        time: timestamp.now(),
        type: 'wisdom/test',
        content: {
          principles: '三頂三圓三虛。。。'
        },
        streamIds: [testData.streams[0].id]
      };

      request.post(basePath)
        .field('event', JSON.stringify(data))
        .attach('$name.with:special-chars/',
          fs.createReadStream(testData.attachments.document.path),
          { filename: 'file.name.with.many.dots.pdf' })
        .end(async function (res) {
          try {
            validation.check(res, {
              status: 201,
              schema: methodsSchema.create.result
            });

            const createdEvent = validation.sanitizeEvent(res.body.event);
            const expected = _.extend(data, {
              id: createdEvent.id,
              attachments: [
                {
                  id: createdEvent.attachments[0].id,
                  fileName: 'file.name.with.many.dots.pdf',
                  type: testData.attachments.document.type,
                  size: testData.attachments.document.size,
                  integrity: testData.attachments.document.integrity
                }
              ],
              streamIds: data.streamIds,
              integrity: createdEvent.integrity
            });

            if (!integrity.attachments.isActive) {
              delete expected.attachments[0].integrity;
            }
            if (!integrity.events.isActive) {
              delete expected.integrity;
            }
            validation.checkObjectEquality(createdEvent, expected);

            // check attached files
            assert.strictEqual(await attachmentsCheck.compareTestAndAttachedFiles(user, createdEvent.id,
              createdEvent.attachments[0].id,
              testData.attachments.document.filename), true);

            assert.strictEqual(eventsNotifCount, 1, 'events notifications');

            done();
          } catch (e) {
            done(e);
          }
        });
    });

    it('[0QGV] must return an error if the non-file content part is not JSON', function (done) {
      request.post(basePath)
        .field('event', '<bad>data</bad>')
        .attach('file', testData.attachments.text.path, testData.attachments.text.fileName)
        .end(function (res) {
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidRequestStructure
          }, done);
        });
    });

    it('[R8ER] must return an error if there is more than one non-file content part', function (done) {
      request.post(basePath)
        .field('event',
          JSON.stringify({ streamIds: [testData.streams[0].id], type: testType }))
        .field('badPart', 'text')
        .end(function (res) {
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.InvalidRequestStructure
          }, done);
        });
    });
  });

  describe('[EV05] POST /<event id> (multipart content)', function () {
    beforeEach(resetEvents);

    it('[ZI01] must add the uploaded files to the event as attachments', function (done) {
      const event = testData.events[1];

      request.post(path(event.id))
        .attach('image', testData.attachments.image.path,
          testData.attachments.image.fileName)
        .attach('text', testData.attachments.text.path,
          testData.attachments.text.fileName)
        .end(async function (res) {
          try {
            validation.check(res, {
              status: 200,
              schema: methodsSchema.update.result
            });

            const updatedEvent = res.body.event;
            validation.checkFilesReadToken(updatedEvent, access, filesReadTokenSecret);
            validation.sanitizeEvent(updatedEvent);

            const updatedEventAttachments = {};
            updatedEvent.attachments.forEach(function (attachment) {
              updatedEventAttachments[attachment.fileName] = attachment;
            });

            const expected = structuredClone(event);
            expected.attachments = [];
            updatedEvent.attachments.forEach(function (attachment) {
              if (attachment.fileName === testData.attachments.image.filename) {
                const attData = {
                  id: attachment.id,
                  fileName: testData.attachments.image.filename,
                  type: testData.attachments.image.type,
                  size: testData.attachments.image.size
                };
                if (integrity.attachments.isActive) attData.integrity = testData.attachments.image.integrity;
                expected.attachments.push(attData);
              }
              if (attachment.fileName === testData.attachments.text.filename) {
                const attData = {
                  id: attachment.id,
                  fileName: testData.attachments.text.filename,
                  type: testData.attachments.text.type,
                  size: testData.attachments.text.size
                };
                if (integrity.attachments.isActive) attData.integrity = testData.attachments.text.integrity;
                expected.attachments.push(attData);
              }
            });
            expected.modified = updatedEvent.modified;
            expected.modifiedBy = access.id;
            integrity.events.set(expected);

            validation.checkObjectEquality(updatedEvent, expected);

            // check attached files
            assert.strictEqual(await attachmentsCheck.compareTestAndAttachedFiles(user, event.id,
              updatedEventAttachments[testData.attachments.image.filename].id,
              testData.attachments.image.filename), true);
            assert.strictEqual(await attachmentsCheck.compareTestAndAttachedFiles(user, event.id,
              updatedEventAttachments[testData.attachments.text.filename].id,
              testData.attachments.text.filename), true);

            assert.strictEqual(eventsNotifCount, 1, 'events notifications');

            done();
          } catch (e) {
            done(e);
          }
        });
    });

    it('[EUZM] must add the uploaded files to the event without replacing existing attachments',
      function (done) {
        const event = testData.events[0];

        request
          .post(path(event.id))
          .attach('text',
            testData.attachments.text.path,
            testData.attachments.text.fileName)
          .end(async function (res) {
            try {
              validation.check(res, {
                status: 200,
                schema: methodsSchema.update.result
              });

              const updatedEvent = validation.sanitizeEvent(res.body.event);
              const expectedAttachments = event.attachments.slice();

              // reset new attachment id after creation
              for (let i = 0; i < expectedAttachments.length; i++) expectedAttachments[i].id = updatedEvent.attachments[i].id;

              const attData = {
                id: updatedEvent.attachments[updatedEvent.attachments.length - 1].id,
                fileName: testData.attachments.text.filename,
                type: testData.attachments.text.type,
                size: testData.attachments.text.size
              };
              if (integrity.attachments.isActive) attData.integrity = testData.attachments.text.integrity;
              expectedAttachments.push(attData);

              const attachments = updatedEvent.attachments;
              assert.strictEqual(attachments.length, expectedAttachments.length);
              assert.deepStrictEqual(attachments, expectedAttachments);

              assert.strictEqual(await attachmentsCheck.compareTestAndAttachedFiles(user, event.id,
                attachments[attachments.length - 1].id,
                testData.attachments.text.filename), true);

              assert.strictEqual(eventsNotifCount, 1, 'events notifications');

              done();
            } catch (e) {
              done(e);
            }
          });
      });
  });

  describe('[EV06] GET /<id>', () => {
    beforeEach(resetEvents);

    it('[8GSS] allows access at level=read', async () => {
      const request = supertest(server.url);
      const access = testData.accesses[2];
      const event = testData.events[0];

      const response = await request.get(path(event.id))
        .set('authorization', access.token);

      assert.strictEqual(response.ok, true);
      assert.strictEqual(response.body.event.id, event.id);
    });
    it('[IBO4] denies access without authorization', async () => {
      const request = supertest(server.url);
      const event = testData.events[0];

      const response = await request
        .get(path(event.id));

      assert.strictEqual(response.status, 401);
    });
  });

  describe('[EV07] PUT /<id>', function () {
    beforeEach(resetEvents);

    it('[4QRU] must modify the event with the sent data', function (done) {
      const original = testData.events[0];
      let time;
      const data = {
        time: timestamp.add(original.time, '-15m'),
        duration: timestamp.add(original.duration, '15m'),
        type: testType,
        content: 'test',
        streamIds: [testData.streams[0].children[0].id],
        description: 'New description',
        clientData: {
          clientField: 'client value'
        }
      };
      async.series([
        function update (stepDone) {
          request.put(path(original.id)).send(data).end(function (res) {
            time = timestamp.now();
            validation.check(res, {
              status: 200,
              schema: methodsSchema.update.result
            });

            validation.checkFilesReadToken(res.body.event, access, filesReadTokenSecret);
            validation.sanitizeEvent(res.body.event);

            const expected = structuredClone(data);
            expected.id = original.id;
            expected.modified = time;
            expected.modifiedBy = access.id;
            expected.attachments = testData.dynCreateAttachmentIdMap[expected.id];
            validation.checkObjectEquality(res.body.event, expected);

            assert.strictEqual(eventsNotifCount, 1, 'events notifications');
            stepDone();
          });
        },
        async function verifyStoredItem () {
          const dbEvent = await mall.events.getOne(user.id, original.id);
          assert.strictEqual(dbEvent.duration, data.duration);
        }
      ], done);
    });

    it('[6B05] must add/update/remove the specified client data fields without touching the others',
      function (done) {
        const original = testData.events[1];
        let time;
        const data = {
          clientData: {
            booleanProp: true, // add
            stringProp: 'Where Art Thou?', // update
            numberProp: null // delete
          }
        };

        request.put(path(original.id)).send(data).end(function (res) {
        // BUG Depending on when we do this inside any given second, by the time
        // we call timestamp.now here, we already have a different second than
        // we had when we made the request. -> Random test success.
          time = timestamp.now();
          validation.check(res, {
            status: 200,
            schema: methodsSchema.update.result
          });

          assert.ok(Math.abs(res.body.event.modified - time) <= 2);
          const expected = structuredClone(original);
          delete expected.modified;
          expected.modifiedBy = access.id;
          expected.modified = res.body.event.modified;
          expected.created = res.body.event.created;
          expected.clientData = _.extend(expected.clientData, data.clientData);

          delete expected.clientData.numberProp;
          integrity.events.set(expected);
          validation.checkObjectEquality(res.body.event, expected);

          assert.strictEqual(eventsNotifCount, 1, 'events notifications');
          done();
        });
      });

    // [FM3G] Duplicate of events-patternc.test.js [PC52] - removed
    // [BS75] Duplicate of events-patternc.test.js [PC53] - removed
    // [FU83] Duplicate of events-patternc.test.js [PC54] - removed
    // [W2QL] Duplicate of events-patternc.test.js [PC55] - removed
    // [01B2] Duplicate of events-patternc.test.js [PC56] - removed

    describe('[EV08] forbidden updates of protected fields', function () {
      const event = {
        type: 'note/txt',
        content: 'forbidden event update test',
        streamIds: [testData.streams[0].id]
      };
      let eventId;

      beforeEach(function (done) {
        request.post(basePath).send(event).end(function (res) {
          validation.check(res, {
            status: 201,
            schema: methodsSchema.create.result
          });
          eventId = res.body.event.id;
          done();
        });
      });

      it('[MPUA] must prevent updating attachments',
        function (done) {
          const forbiddenUpdate = {
            attachments: []
          };

          async.series([
            function instanciateServerWithStrictMode (stepDone) {
              setIgnoreProtectedFieldUpdates(false, stepDone);
            },
            function testForbiddenUpdate (stepDone) {
              request.put(path(eventId)).send(forbiddenUpdate)
                .end(function (res) {
                  validation.checkError(res, {
                    status: 403,
                    id: ErrorIds.Forbidden
                  }, stepDone);
                });
            }
          ], done);
        });

      it('[L15U] must prevent update of protected fields and throw a forbidden error in strict mode',
        function (done) {
          const forbiddenUpdate = {
            id: 'forbidden',
            attachments: [],
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
              request.put(path(eventId)).send(forbiddenUpdate)
                .end(function (res) {
                  validation.checkError(res, {
                    status: 403,
                    id: ErrorIds.Forbidden
                  }, stepDone);
                });
            }
          ], done);
        });

      it('[6NZ7] must prevent update of protected fields and log a warning in non-strict mode',
        function (done) {
          const forbiddenUpdate = {
            id: 'forbidden',
            attachments: [],
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
              request.put(path(eventId)).send(forbiddenUpdate)
                .end(function (res) {
                  validation.check(res, {
                    status: 200,
                    schema: methodsSchema.update.result
                  });
                  const update = res.body.event;
                  assert.notStrictEqual(update.id, forbiddenUpdate.id);
                  assert.notStrictEqual(update.created, forbiddenUpdate.created);
                  assert.notStrictEqual(update.createdBy, forbiddenUpdate.createdBy);
                  assert.notStrictEqual(update.modified, forbiddenUpdate.modified);
                  assert.notStrictEqual(update.modifiedBy, forbiddenUpdate.modifiedBy);
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

  // Fixes #208
  describe('[EV09] PUT HF/non-HF events', function () {
    const streamId = testData.streams[0].id;
    const normalEvent = { streamIds: [streamId], type: 'activity/plain' };
    const hfEvent = { streamIds: [streamId], type: 'series:activity/plain' };
    let normalEventId;
    let hfEventId;
    before(function (done) {
      async.parallel([
        function createNormalEvent (stepDone) {
          request.post(basePath).send(normalEvent).end(function (res) {
            assert.ok(res.status);
            assert.strictEqual(res.status, 201);

            assert.ok(res.body.event.id);
            normalEventId = res.body.event.id;

            stepDone();
          });
        },
        function createHfEvent (stepDone) {
          request.post(basePath).send(hfEvent).end(function (res) {
            assert.ok(res.status);
            assert.strictEqual(res.status, 201);

            assert.ok(res.body.event.id);
            hfEventId = res.body.event.id;

            stepDone();
          });
        }
      ], done);
    });

    it('[Z7R1] a normal event should not be updated to an hf-event', function (done) {
      request.put(path(normalEventId)).send(hfEvent).end(function (res) {
        assert.ok(res.status);
        assert.strictEqual(res.status, 400);

        assert.ok(res.body.error.id);
        assert.strictEqual(res.body.error.id, 'invalid-operation');

        done();
      });
    });

    it('[Z7R2] An hf-event should not be updated to a normal event', function (done) {
      request.put(path(hfEventId)).send(normalEvent).end(function (res) {
        assert.ok(res.status);
        assert.strictEqual(res.status, 400);

        assert.ok(res.body.error.id);
        assert.strictEqual(res.body.error.id, 'invalid-operation');

        done();
      });
    });
  });

  describe('[EV10] DELETE /<event id>/<file id>', function () {
    beforeEach(resetEvents);

    it('[RW8M] must delete the attachment (reference in event + file)', async function () {
      const event = testData.events[0];
      const attachmentId = testData.dynCreateAttachmentIdMap[event.id][0].id;
      const fPath = path(event.id) + '/' + attachmentId;
      const res = await request.del(fPath);
      validation.check(res, {
        status: 200,
        schema: methodsSchema.update.result
      });

      const updatedEvent = res.body.event;
      validation.checkFilesReadToken(updatedEvent, access, filesReadTokenSecret);
      validation.sanitizeEvent(updatedEvent);
      const expected = structuredClone(testData.events[0]);
      expected.attachments = expected.attachments.slice();
      // NOTE We cannot be sure that we still are at the exact same second that
      // we were just now when we did the call. So don't use time here, test
      // for time delta below.
      delete expected.modified;
      expected.modifiedBy = access.id;
      expected.modified = updatedEvent.modified;
      expected.attachments = structuredClone(testData.dynCreateAttachmentIdMap[event.id]);
      expected.attachments.shift();
      integrity.events.set(expected);
      validation.checkObjectEquality(updatedEvent, expected);

      const time = timestamp.now();
      assert.ok(Math.abs(updatedEvent.modified - time) <= 2);

      try {
        await mall.events.getAttachment(user.id, { id: event.id }, event.attachments[0].id);
        throw new Error('Should not find attachment');
      } catch (err) {
        assert.strictEqual(err.id, 'unknown-resource');
      }

      assert.strictEqual(eventsNotifCount, 1, 'events notifications');
    });

    it('[ZLZN] must return an error if not existing', function (done) {
      request.del(path(testData.events[0].id) + '/unknown.file').end(function (res) {
        validation.checkError(res, {
          status: 404,
          id: ErrorIds.UnknownResource
        }, done);
      });
    });
  });

  describe('[EV11] DELETE /<id>', function () {
    beforeEach(resetEvents);

    it('[AT5Y] must flag the event as trashed', function (done) {
      const id = testData.events[0].id;
      let time;

      request.del(path(id)).end(function (res) {
        time = timestamp.now();
        validation.check(res, {
          status: 200,
          schema: methodsSchema.del.result
        });

        const trashedEvent = res.body.event;
        assert.strictEqual(trashedEvent.trashed, true);
        assert.ok(trashedEvent.modified >= time - 1 && trashedEvent.modified <= time);
        assert.strictEqual(trashedEvent.modifiedBy, access.id);
        validation.checkFilesReadToken(trashedEvent, access, filesReadTokenSecret);

        assert.strictEqual(eventsNotifCount, 1, 'events notifications');
        done();
      });
    });

    it('[73CD] must delete the event when already trashed including all its attachments', function (done) {
      const eventId = testData.events[0].id;
      let event;

      async.series([
        async function getEvent () {
          event = await mall.events.getOne(user.id, eventId);
        },
        async function trashEvent () {
          event.trashed = true;
          await mall.events.update(user.id, event);
        },
        function deleteEvent (stepDone) {
          request.del(path(eventId)).end(function (res) {
            validation.check(res, {
              status: 200,
              schema: methodsSchema.del.result
            });
            assert.deepStrictEqual(res.body.eventDeletion, { id: eventId });
            assert.strictEqual(eventsNotifCount, 1, 'events notifications');
            stepDone();
          });
        },
        async function verifyEventData () {
          const deletedEvents = await mall.events.getDeletions('local', user.id, { deletedSince: 0 });
          const deletion = _.find(deletedEvents, function (event) {
            return event.id === eventId;
          });
          assert.ok(deletion);
          const expected = { id: eventId, deleted: deletion.deleted };
          integrity.events.set(expected);
          validation.checkObjectEquality(deletion.integrity, expected.integrity);
          for (const attachment of event.attachments) {
            try {
              await mall.events.getAttachment(user.id, { id: eventId }, attachment.id);
              throw new Error('Should not find attachment');
            } catch (err) {
              assert.strictEqual(err.id, 'unknown-resource');
            }
          }
        }
      ],
      done
      );
    });
  });

  function resetEvents (done) {
    eventsNotifCount = 0;
    async.series([
      testData.resetEvents
    ], done);
  }
});
