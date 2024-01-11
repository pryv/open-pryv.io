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

const { assert } = require('chai');
const supertest = require('supertest');
const bluebird = require('bluebird');
const async = require('async');
const fs = require('fs');
const should = require('should'); // explicit require to benefit from static function
const timestamp = require('unix-timestamp');
const _ = require('lodash');

require('./test-helpers');

const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const attachmentsCheck = helpers.attachmentsCheck;
const commonTests = helpers.commonTests;
const validation = helpers.validation;
const ErrorIds = require('errors').ErrorIds;
const eventFilesStorage = helpers.dependencies.storage.user.eventFiles;
const methodsSchema = require('../src/schema/eventsMethods');
const testData = helpers.data;

const { TAG_PREFIX } = require('api-server/src/methods/helpers/backwardCompatibility');
const { integrity } = require('business');
const { getMall } = require('mall');

require('date-utils');

describe('events', function () {
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
  server.on('axon-events-changed', function () { eventsNotifCount++; });

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
            assert.notExists(err);
            access = acc;
            stepDone();
          });
      }
    ], done);
  });

  describe('GET /', function () {
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
            return mall.events.createMany(user.id, additionalEvents);
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
            validation.check(response, {
              status: 200,
              schema: methodsSchema.get.result,
              sanitizeFn: validation.sanitizeEvents,
              sanitizeTarget: 'events',
              body: { events: _.take(_.sortBy(allEvents, 'time').reverse(), 20 - accountStreamsEvents.length) }
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
          validation.check(res, {
            status: 200,
            schema: methodsSchema.get.result,
            sanitizeFn: validation.sanitizeEvents,
            sanitizeTarget: 'events',
            body: {
              events: _.at(testData.events, 9, 7, 6, 4, 3, 2, 1, 0)
            }
          }, done);
        });
      });

    it('[S0M6] must return an error if some of the given streams do not exist', function (done) {
      const params = { streams: ['bad-id-A', 'bad-id-B'] };
      request.get(basePath).query(params).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.UnknownReferencedResource,
          data: params
        }, done);
      });
    });

    it('[R667] must only return events with the given tag when set', function (done) {
      const params = {
        tags: ['super'],
        fromTime: timestamp.now('-48h')
      };
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events: _.at(testData.events, 3, 2, 0)
          }
        }, done);
      });
    });

    it('[KNJY] must only return events with any of the given tags when set', function (done) {
      const params = {
        tags: ['super', 'fragilistic'],
        fromTime: timestamp.now('-48h')
      };
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 200,
          schema: methodsSchema.get.result,
          sanitizeFn: validation.sanitizeEvents,
          sanitizeTarget: 'events',
          body: {
            events: _.at(testData.events, 11, 3, 2, 0)
          }
        }, done);
      });
    });

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
            events: _.at(testData.events, 12, 4, 2)
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
        res.body.events.should.containEql(testData.events[8]); // activity/test
        res.body.events.should.containEql(testData.events[9]); // activity/pryv
        done();
      });
    });

    it('[4TWI] must refuse unsupported event types', function (done) {
      const params = {
        types: ['activity/asd asd'],
        state: 'all'
      };
      request.get(basePath).query(params).end(function (res) {
        validation.check(res, {
          status: 400,
          id: ErrorIds.invalidParametersFormat
        }, done);
      });
    });

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
              events: _.at(testData.events, 1, 2, 3)
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
        res.body.events.should.not.containEql(testData.events[27]);
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
            events: _.at(testData.events, 2)
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
            events: _.sortBy(validation.removeDeletionsAndHistory(testData.events), 'time')
              .reverse()
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
            events
          }
        }, done);
      });
    });

    it('[C3HU] must return an error if withDeletions is given as parameter', function (done) {
      const params = {
        state: 'all',
        modifiedSince: timestamp.now('-45m'),
        includeDeletions: true,
        withDeletions: true
      };

      request.get(basePath).query(params).end(async function (res) {
        res.body.should.have.property('error');
        res.body.error.should.have.property('id', 'invalid-parameters-format');
        done();
      });
    });

    it('[B766] must include event deletions (since that time) when requested', function (done) {
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

      request.get(basePath).query(params).end(async function (res) {
        try {
          // lets separate core events from all other events and validate them separatelly
          const separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
          res.body.events = separatedEvents.events;
          const actualAccountStreamsEvents = separatedEvents.accountStreamsEvents;
          validation.validateAccountEvents(actualAccountStreamsEvents);
          await bluebird.fromCallback(
            (cb) => validation.check(res, {
              status: 200,
              schema: methodsSchema.get.result,
              sanitizeFn: validation.sanitizeEvents,
              sanitizeTarget: 'events',
              body: {
                events,
                eventDeletions
              }
            }, cb));
          done();
        } catch (error) {
          done(error);
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
            events
          }
        }, done);
      });
    });

    it('[68IL] must return an error if no access token is provided', function (done) {
      commonTests.checkAccessTokenAuthentication(server.url, basePath, done);
    });
  });

  describe('GET /<event id>/<file id>', function () {
    before(resetEvents);

    it('[F29M] must return the attached file with the correct headers', function (done) {
      const event = testData.events[0];
      const attachment = event.attachments[0];

      request.get(path(event.id) + '/' + attachment.id).end(function (res) {
        res.statusCode.should.eql(200);

        res.headers.should.have.property('content-type', attachment.type);
        res.headers.should.have.property('content-length', attachment.size.toString());

        done();
      });
    });

    it('[PP6G] must return readToken in attachments', function (done) {
      const event = testData.events[0];

      request.get(path(event.id) + '/').end(function (res) {
        res.statusCode.should.eql(200);
        res.body.event.should.have.property('attachments');
        res.body.event.attachments.forEach(attachment => {
          attachment.should.have.property('readToken');
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
                res.statusCode.should.eql(200);

                res.headers.should.have.property('content-type', att.type);
                res.headers.should.have.property('content-length', att.size.toString());

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
              res.statusCode.should.eql(200);
              res.headers.should.have.property('content-type', att.type);
              res.headers.should.have.property('content-length', att.size.toString());
              res.headers.should.have.property('content-disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(att.fileName));
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
              res.statusCode.should.eql(200);

              res.headers.should.have.property('content-type', att.type);
              res.headers.should.have.property('content-length', att.size.toString());

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
              .query({ sortAscending: true, streams: [event.streamId] })
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
                res.statusCode.should.eql(200);
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

  describe('POST /', function () {
    beforeEach(resetEvents);

    it('[1GR6] must create an event with the sent data, returning it', function (done) {
      const data = {
        time: timestamp.fromDate('2012-03-22T10:00'),
        duration: timestamp.duration('55m'),
        type: 'temperature/celsius',
        content: 36.7,
        streamIds: [testData.streams[0].id],
        tags: [' patapoumpoum ', '   ', ''], // must trim and ignore empty tags
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
      const processedTags = ['patapoumpoum'];
      const processedStreamIds = data.streamIds.concat(processedTags.map(t => TAG_PREFIX + t));
      const expected = structuredClone(data);
      expected.tags = processedTags;
      expected.streamIds = processedStreamIds;
      expected.streamId = data.streamIds[0];

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
            assert.exists(event);
            assert.notEqual(event.created, data.created);
            assert.notEqual(event.createdBy, data.createdBy);
            assert.notEqual(event.modified, data.modified);
            assert.notEqual(event.modifiedBy, data.modifiedBy);
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
            eventsNotifCount.should.eql(1, 'events notifications');
            stepDone();
          });
        },
        async function verifyEventData () {
          const events = await mall.events.get(user.id, {});

          events.length.should.eql(originalCount + 1, 'events');

          const expected = structuredClone(data);

          expected.streamId = expected.streamIds[0];
          expected.id = createdEventId;
          expected.streamIds = expected.streamIds.concat(['patapoumpoum'].map(t => TAG_PREFIX + t));
          delete expected.tags; // tags are not stored anymore
          expected.created = expected.modified = created;
          expected.createdBy = expected.modifiedBy = access.id;
          const actual = _.find(events, function (event) {
            return event.id === createdEventId;
          });
          actual.streamId = actual.streamIds[0];
          validation.checkStoredItem(actual, 'event');
          validation.checkObjectEquality(actual, expected);
        }
      ], done);
    });

    it('[QSBV] must set the event\'s time to "now" if missing', function (done) {
      const data = {
        streamIds: [testData.streams[2].id],
        type: 'mass/kg',
        content: 10.7
      };
      request.post(basePath).send(data).end(function (res) {
        const expectedTimestamp = timestamp.now();

        validation.check(res, {
          status: 201,
          schema: methodsSchema.create.result
        });

        // allow 1 second of lag
        res.body.event.time.should.be.within(expectedTimestamp - 1, expectedTimestamp);

        done();
      });
    });

    it('[6BVW] must accept explicit null for optional fields', function (done) {
      const data = {
        type: 'test/null',
        streamIds: [testData.streams[2].id],
        duration: null,
        content: null,
        description: null,
        clientData: null,
        tags: null,
        trashed: null
      };
      request.post(basePath).send(data).end(function (res) {
        validation.check(res, {
          status: 201,
          schema: methodsSchema.create.result
        }, done);
      });
    });

    it('[D2TH] must refuse events with no stream id', function (done) {
      request.post(basePath).send({ type: testType }).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

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

    it('[DRFA] must only allow ids that are formatted like cuids', function (done) {
      const data = {
        id: 'man, this is a baaad id',
        streamIds: [testData.streams[2].id],
        type: 'test/test'
      };
      request.post(basePath).send(data).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

    it('[O7Y2] must reject tags that are too long', function (done) {
      const bigTag = new Array(600).join('a');
      const data = {
        streamIds: [testData.streams[2].id],
        type: 'generic/count',
        content: 1,
        tags: [bigTag]
      };
      request.post(basePath).send(data).end(function (res) {
        validation.check(res, {
          status: 400,
          id: ErrorIds.invalidParametersFormat,
          data: bigTag
        }, done);
      });
    });

    it('[2885] must fix the tags to an empty array if not set', function (done) {
      const data = { streamId: testData.streams[1].id, type: testType };

      request.post(basePath).send(data).end(function (res) {
        should(res.statusCode).be.eql(201);

        const createdEvent = res.body.event;
        createdEvent.should.have.property('tags');
        createdEvent.tags.should.eql([]);

        done();
      });
    });

    it('[UL6Y] must not stop the running period event if the stream allows overlapping', function (done) {
      const data = {
        streamIds: [testData.streams[1].id],
        duration: timestamp.duration('1h'),
        type: testType,
        tags: []
      };
      async.series([
        function addNew (stepDone) {
          request.post(basePath).send(data).end(function (res) {
            should.not.exist(res.body.stoppedId);
            validation.check(res, {
              status: 201,
              schema: methodsSchema.create.result
            }, stepDone);
          });
        },
        async function verifyData () {
          const event = await mall.events.getOne(user.id, testData.events[11].id);
          // HERE
          // as event comes from storage we will not find "tags"
          const expected = structuredClone(testData.events[11]);
          delete expected.tags;
          event.should.eql(expected);
        }
      ], done);
    });

    it('[FZ4T] must validate the event\'s content if its type is known', function (done) {
      const data = {
        streamIds: [testData.streams[1].id],
        type: 'note/webclip',
        content: {
          url: 'bad-url',
          content: '<p>昔者莊周夢為蝴蝶，栩栩然蝴蝶也，自喻適志與，不知周也。' +
              '俄然覺，則蘧蘧然周也。不知周之夢為蝴蝶與，蝴蝶之夢為周與？周與蝴蝶則必有分矣。' +
              '此之謂物化。</p>'
        }
      };
      request.post(basePath).send(data).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

    // cf. GH issue #42
    it('[EL88] must not fail when validating the content if passing a string instead of an object',
      function (done) {
        const data = {
          streamIds: [testData.streams[1].id],
          type: 'note/webclip',
          content: 'This should be an object'
        };
        request.post(basePath).send(data).end(function (res) {
          validation.checkErrorInvalidParams(res, done);
        });
      });

    it('[JUM6] must return an error if the sent data is badly formatted', function (done) {
      request.post(basePath).send({ badProperty: 'bad value' }).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

    it('[5NEL] must return an error if the associated stream is unknown', function (done) {
      const data = {
        time: timestamp.fromDate('2012-03-22T10:00'),
        type: testType,
        streamIds: ['unknown-stream-id']
      };
      request.post(basePath).send(data).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.UnknownReferencedResource,
          data: { streamIds: data.streamIds }
        }, done);
      });
    });

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

    it('[Q0L6] must return an error if the assigned stream is trashed', function (done) {
      const data = {
        type: testType,
        streamIds: [testData.streams[3].id]
      };
      request.post(basePath).send(data).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidOperation,
          data: { trashedReference: 'streamIds' }
        }, done);
      });
    });

    it('[WUSC] must not fail (500) when sending an array instead of an object', function (done) {
      request.post(basePath).send([{}]).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidParametersFormat
        }, done);
      });
    });

    it('[Z87W] must not accept an empty streamIds array', (done) => {
      request.post(basePath).send({
        streamIds: [],
        type: 'note/txt',
        content: 'i should return an error!'
      }).end(function (res) {
        validation.checkError(res, {
          status: 400,
          id: ErrorIds.InvalidParametersFormat
        }, done);
      });
    });
  });

  describe('POST / (multipart content)', function () {
    beforeEach(resetEvents);

    it('[4CUV] must create a new event with the uploaded files', function (finalDone) {
      const data = {
        time: timestamp.now(),
        type: 'wisdom/test',
        content: {
          chapterOne: '道 可 道 非 常 道...'
        },
        streamIds: [testData.streams[0].id],
        tags: ['houba']
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
          .end(function (res) {
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
              streamIds: data.streamIds.concat(data.tags.map(t => TAG_PREFIX + t))
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
            attachmentsCheck.compareTestAndAttachedFiles(user, createdEvent.id,
              createdEvent.attachments[0].id,
              testData.attachments.document.filename).should.equal('');
            attachmentsCheck.compareTestAndAttachedFiles(user, createdEvent.id,
              createdEvent.attachments[1].id,
              testData.attachments.image.filename).should.equal('');

            eventsNotifCount.should.eql(1, 'events notifications');

            done();
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
        streamIds: [testData.streams[0].id],
        tags: ['bagua']
      };

      request.post(basePath)
        .field('event', JSON.stringify(data))
        .attach('$name.with:special-chars/',
          fs.createReadStream(testData.attachments.document.path),
          { filename: 'file.name.with.many.dots.pdf' })
        .end(function (res) {
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
            streamIds: data.streamIds.concat(data.tags.map(t => TAG_PREFIX + t)),
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
          attachmentsCheck.compareTestAndAttachedFiles(user, createdEvent.id,
            createdEvent.attachments[0].id,
            testData.attachments.document.filename).should.equal('');

          eventsNotifCount.should.eql(1, 'events notifications');

          done();
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

  describe('POST /<event id> (multipart content)', function () {
    beforeEach(resetEvents);

    it('[ZI01] must add the uploaded files to the event as attachments', function (done) {
      const event = testData.events[1];

      request.post(path(event.id))
        .attach('image', testData.attachments.image.path,
          testData.attachments.image.fileName)
        .attach('text', testData.attachments.text.path,
          testData.attachments.text.fileName)
        .end(function (res) {
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
          attachmentsCheck.compareTestAndAttachedFiles(user, event.id,
            updatedEventAttachments[testData.attachments.image.filename].id,
            testData.attachments.image.filename).should.equal('');
          attachmentsCheck.compareTestAndAttachedFiles(user, event.id,
            updatedEventAttachments[testData.attachments.text.filename].id,
            testData.attachments.text.filename).should.equal('');

          eventsNotifCount.should.eql(1, 'events notifications');

          done();
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
          .end(function (res) {
            validation.check(res, {
              status: 200,
              schema: methodsSchema.update.result
            });

            const updatedEvent = validation.sanitizeEvent(res.body.event);
            const expectedAttachments = event.attachments.slice();
            const attData = {
              id: updatedEvent.attachments[updatedEvent.attachments.length - 1].id,
              fileName: testData.attachments.text.filename,
              type: testData.attachments.text.type,
              size: testData.attachments.text.size
            };
            if (integrity.attachments.isActive) attData.integrity = testData.attachments.text.integrity;
            expectedAttachments.push(attData);

            const attachments = updatedEvent.attachments;
            should(attachments.length).be.eql(expectedAttachments.length);

            attachments.should.eql(expectedAttachments);

            attachmentsCheck.compareTestAndAttachedFiles(user, event.id,
              attachments[attachments.length - 1].id,
              testData.attachments.text.filename).should.equal('');

            eventsNotifCount.should.eql(1, 'events notifications');

            done();
          });
      });
  });

  describe('GET /<id>', () => {
    beforeEach(resetEvents);

    it('[8GSS] allows access at level=read', async () => {
      const request = supertest(server.url);
      const access = _.find(testData.accesses, (v) => v.id === 'a_2');
      const event = testData.events[0];

      const response = await request.get(path(event.id))
        .set('authorization', access.token);

      assert.isTrue(response.ok);
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

  describe('PUT /<id>', function () {
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
        tags: [' yippiya ', ' ', ''], // must trim and ignore empty tags
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
            expected.tags = ['yippiya'];
            expected.modified = time;
            expected.modifiedBy = access.id;
            expected.attachments = original.attachments;
            expected.streamIds = data.streamIds.concat(expected.tags.map(t => TAG_PREFIX + t));
            validation.checkObjectEquality(res.body.event, expected);

            eventsNotifCount.should.eql(1, 'events notifications');
            stepDone();
          });
        },
        async function verifyStoredItem () {
          const dbEvent = await mall.events.getOne(user.id, original.id);
          dbEvent.duration.should.eql(data.duration);
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

          should(res.body.event.modified).be.approximately(time, 2);
          const expected = structuredClone(original);
          delete expected.modified;
          expected.modifiedBy = access.id;
          expected.streamId = expected.streamIds[0];
          expected.modified = res.body.event.modified;
          expected.created = res.body.event.created;
          expected.clientData = _.extend(expected.clientData, data.clientData);

          delete expected.clientData.numberProp;
          integrity.events.set(expected);
          validation.checkObjectEquality(res.body.event, expected);

          eventsNotifCount.should.eql(1, 'events notifications');
          done();
        });
      });

    it('[FM3G] must accept explicit null for optional fields', function (done) {
      const data = {
        type: 'test/null',
        duration: null,
        content: null,
        description: null,
        clientData: null,
        tags: null,
        trashed: null
      };
      request.put(path(testData.events[10].id)).send(data)
        .end(function (res) {
          validation.check(res, {
            status: 200,
            schema: methodsSchema.update.result
          }, done);
        });
    });

    it('[BS75] must validate the event\'s content if its type is known', function (done) {
      const data = {
        type: 'position/wgs84',
        content: {
          latitude: 'bad-value',
          longitude: false
        }
      };
      request.put(path(testData.events[2].id)).send(data).end(function (res) {
        validation.checkErrorInvalidParams(res, done);
      });
    });

    it('[FU83] must return an error if the event does not exist', function (done) {
      request.put(path('unknown-id')).send({ time: timestamp.now() }).end(function (res) {
        validation.checkError(res, {
          status: 404,
          id: ErrorIds.UnknownResource
        }, done);
      });
    });

    it('[W2QL] must return an error if the sent data is badly formatted', function (done) {
      request.put(path(testData.events[3].id)).send({ badProperty: 'bad value' })
        .end(function (res) {
          validation.checkErrorInvalidParams(res, done);
        });
    });

    it('[01B2] must return an error if the associated stream is unknown', function (done) {
      request.put(path(testData.events[3].id)).send({ streamIds: ['unknown-stream-id'] })
        .end(function (res) {
          validation.checkError(res, {
            status: 400,
            id: ErrorIds.UnknownReferencedResource,
            data: { streamIds: ['unknown-stream-id'] }
          }, done);
        });
    });

    describe('forbidden updates of protected fields', function () {
      const event = {
        type: 'note/txt',
        content: 'forbidden event update test',
        streamId: testData.streams[0].id
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
                  should(update.id).not.be.equal(forbiddenUpdate.id);
                  should(update.created).not.be.equal(forbiddenUpdate.created);
                  should(update.createdBy).not.be.equal(forbiddenUpdate.createdBy);
                  should(update.modified).not.be.equal(forbiddenUpdate.modified);
                  should(update.modifiedBy).not.be.equal(forbiddenUpdate.modifiedBy);
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

    it('[CUM3] must reject tags that are too long', function (done) {
      const bigTag = new Array(600).join('a');

      request.put(path(testData.events[1].id)).send({ tags: [bigTag] })
        .end(function (res) {
          validation.check(res, {
            status: 400,
            id: ErrorIds.InvalidParametersFormat,
            data: bigTag
          }, done);
        });
    });
  });

  // Fixes #208
  describe('PUT HF/non-HF events', function () {
    const streamId = testData.streams[0].id;
    const normalEvent = { streamIds: [streamId], type: 'activity/plain' };
    const hfEvent = { streamIds: [streamId], type: 'series:activity/plain' };
    let normalEventId;
    let hfEventId;
    const isOpenSource = helpers.dependencies.settings.openSource.isActive;

    before(function (done) {
      if (isOpenSource) {
        this.skip();
        return done();
      }
      async.parallel([
        function createNormalEvent (stepDone) {
          request.post(basePath).send(normalEvent).end(function (res) {
            assert.exists(res.status);
            should(res.status).be.eql(201);

            assert.exists(res.body.event.id);
            normalEventId = res.body.event.id;

            stepDone();
          });
        },
        function createHfEvent (stepDone) {
          request.post(basePath).send(hfEvent).end(function (res) {
            assert.exists(res.status);
            should(res.status).be.eql(201);

            assert.exists(res.body.event.id);
            hfEventId = res.body.event.id;

            stepDone();
          });
        }
      ], done);
    });

    it('[Z7R1] a normal event should not be updated to an hf-event', function (done) {
      request.put(path(normalEventId)).send(hfEvent).end(function (res) {
        assert.exists(res.status);
        should(res.status).be.eql(400);

        assert.exists(res.body.error.id);
        should(res.body.error.id).be.eql('invalid-operation');

        done();
      });
    });

    it('[Z7R2] An hf-event should not be updated to a normal event', function (done) {
      request.put(path(hfEventId)).send(normalEvent).end(function (res) {
        assert.exists(res.status);
        should(res.status).be.eql(400);

        assert.exists(res.body.error.id);
        should(res.body.error.id).be.eql('invalid-operation');

        done();
      });
    });
  });

  describe('DELETE /<event id>/<file id>', function () {
    beforeEach(resetEvents);

    it('[RW8M] must delete the attachment (reference in event + file)', function (done) {
      const event = testData.events[0];
      const fPath = path(event.id) + '/' + event.attachments[0].id;
      request.del(fPath).end(function (res) {
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
        expected.attachments.shift();
        integrity.events.set(expected);
        validation.checkObjectEquality(updatedEvent, expected);

        const time = timestamp.now();
        should(updatedEvent.modified).be.approximately(time, 2);

        const filePath = eventFilesStorage.getAttachmentPath(user.id, event.id,
          event.attachments[0].id);
        fs.existsSync(filePath).should.eql(false, 'deleted file existence');

        eventsNotifCount.should.eql(1, 'events notifications');

        done();
      });
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

  describe('DELETE /<id>', function () {
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
        trashedEvent.trashed.should.eql(true);
        trashedEvent.modified.should.be.within(time - 1, time);
        trashedEvent.modifiedBy.should.eql(access.id);
        validation.checkFilesReadToken(trashedEvent, access, filesReadTokenSecret);

        eventsNotifCount.should.eql(1, 'events notifications');
        done();
      });
    });

    it('[73CD] must delete the event when already trashed including all its attachments', function (done) {
      const id = testData.events[0].id;
      let event;

      async.series([
        async function getEvent () {
          event = await mall.events.getOne(user.id, id);
        },
        async function trashEvent () {
          event.trashed = true;
          await mall.events.update(user.id, event);
        },
        function deleteEvent (stepDone) {
          request.del(path(id)).end(function (res) {
            validation.check(res, {
              status: 200,
              schema: methodsSchema.del.result
            });
            res.body.eventDeletion.should.eql({ id });
            eventsNotifCount.should.eql(1, 'events notifications');
            stepDone();
          });
        },
        async function verifyEventData () {
          const deletedEvents = await mall.events.getDeletions('local', user.id, { deletedSince: 0 });
          const deletion = _.find(deletedEvents, function (event) {
            return event.id === id;
          });
          assert.exists(deletion);
          const expected = { id, deleted: deletion.deleted };
          integrity.events.set(expected);
          validation.checkObjectEquality(deletion.integrity, expected.integrity);

          const dirPath = eventFilesStorage.getEventPath(user.id, id);
          fs.existsSync(dirPath).should.eql(false, 'deleted event directory existence');
        }
      ],
      done
      );
    });
  });

  function resetEvents (done) {
    eventsNotifCount = 0;
    async.series([
      testData.resetEvents,
      testData.resetAttachments
    ], done);
  }
});
