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
const path = require('path');
const timestamp = require('unix-timestamp');
const _ = require('lodash');
const { assert } = require('chai');

require('./test-helpers');
const helpers = require('./helpers');
const treeUtils = require('utils').treeUtils;
const server = helpers.dependencies.instanceManager;
const validation = helpers.validation;
const testData = helpers.data;
const { integrity } = require('business');
const { getConfig } = require('@pryv/boiler');

let isAuditActive = false;

describe('[ACCP] Access permissions', function () {
  before(async () => {
    const config = await getConfig();
    isAuditActive = (!config.get('openSource:isActive')) && config.get('audit:active');
  });

  const user = Object.assign({}, testData.users[0]);
  let request = null; // must be set after server instance started
  const filesReadTokenSecret = helpers.dependencies.settings.auth.filesReadTokenSecret;

  function token (testAccessIndex) {
    return testData.accesses[testAccessIndex].token;
  }

  function getAllStreamIdsByToken (testAccessIndex) {
    const tokenStreamIds = [];
    testData.accesses[testAccessIndex].permissions.forEach(function (p) {
      tokenStreamIds.push(p.streamId);
    });
    return treeUtils.expandIds(testData.streams, tokenStreamIds);
  }

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) { request = helpers.request(server.url); stepDone(); }
    ], done);
  });

  describe('Events', function () {
    before(function (done) {
      async.series([
        testData.resetStreams,
        testData.resetAttachments
      ], done);
    });

    beforeEach(testData.resetEvents);

    const basePath = '/' + user.username + '/events';

    function reqPath (id) {
      return basePath + '/' + id;
    }

    it('[1AK1] `get` must only return events in accessible streams', function (done) {
      const params = {
        limit: 100, // i.e. all
        state: 'all'
      };
      const streamIds = getAllStreamIdsByToken(1);

      const events = validation.removeDeletionsAndHistory(testData.events).filter(function (e) {
        return streamIds.indexOf(e.streamIds[0]) >= 0;
      }).sort(function (a, b) {
        return b.time - a.time;
      });
      request.get(basePath, token(1)).query(params).end(function (res) {
        validation.checkFilesReadToken(res.body.events, testData.accesses[1],
          filesReadTokenSecret);
        validation.sanitizeEvents(res.body.events);
        events.forEach(integrity.events.set);
        res.body.events.should.eql(events);
        done();
      });
    });

    it('[NKI5] `get` must return all events when permissions are defined for "all streams" (*)',
      function (done) {
        const params = {
          limit: 100, // i.e. all
          state: 'all'
        };
        request.get(basePath, token(2)).query(params).end(function (res) {
          validation.checkFilesReadToken(res.body.events, testData.accesses[2],
            filesReadTokenSecret);
          validation.sanitizeEvents(res.body.events);
          res.body.events = validation.removeAccountStreamsEvents(res.body.events);
          res.body.events.should.eql(validation.removeDeletionsAndHistory(testData.events).sort(
            function (a, b) {
              return b.time - a.time;
            }
          ));
          done();
        });
      });

    it('[5360] `get` (or any request) must alternatively accept the access token in the query string',
      function (done) {
        const query = {
          auth: token(1),
          streams: [testData.streams[2].children[0].id],
          state: 'all'
        };
        request.get(basePath, token(1)).unset('Authorization').query(query).end(function (res) {
          const expectedEvent = _.cloneDeep(testData.events[8]);
          expectedEvent.streamId = expectedEvent.streamIds[0];
          res.body.events.should.eql([expectedEvent]);
          done();
        });
      });

    it('[KTM1] must forbid getting an attached file if permissions are insufficient', function (done) {
      const event = testData.events[0];
      const attachment = event.attachments[0];
      request.get(reqPath(event.id) + '/' + attachment.id, token(3)).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    it('[2773] must forbid creating events for \'read-only\' streams', function (done) {
      const params = {
        type: 'test/test',
        streamId: testData.streams[0].id
      };
      request.post(basePath, token(1)).send(params).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    it('[ZKZZ] must forbid updating events for \'read-only\' streams', function (done) {
      // also check recursive permissions
      request.put(reqPath(testData.events[0].id), token(1)).send({ content: {} }).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    it('[4H62] must forbid deleting events for \'read-only\' streams', function (done) {
      request.del(reqPath(testData.events[1].id), token(1)).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    it('[Y38T] must allow creating events for \'contribute\' streams', function (done) {
      const data = {
        time: timestamp.now('-5h'),
        duration: timestamp.duration('1h'),
        type: 'test/test',
        streamId: testData.streams[1].id
      };
      request.post(basePath, token(1)).send(data).end(function (res) {
        res.statusCode.should.eql(201);
        done();
      });
    });
  });

  describe('Streams', function () {
    before(testData.resetEvents);

    beforeEach(testData.resetStreams);

    const basePath = '/' + user.username + '/streams';

    function reqPath (id) {
      return basePath + '/' + id;
    }

    // note: personal (i.e. full) access is implicitly covered by streams/events tests

    it('[BSFP] `get` must only return streams for which permissions are defined', function (done) {
      request.get(basePath, token(1)).query({ state: 'all' }).end(async function (res) {
        const expectedStreamids = [testData.streams[0].id, testData.streams[1].id, testData.streams[2].children[0].id];
        if (isAuditActive) {
          expectedStreamids.push(':_audit:access-a_1');
        }
        assert.exists(res.body.streams);
        res.body.streams.length.should.eql(expectedStreamids.length);
        for (const stream of res.body.streams) {
          assert.include(expectedStreamids, stream.id);
        }
        done();
      });
    });

    it('[R4IA] must forbid creating child streams in \'read-only\' streams', function (done) {
      const data = {
        name: 'Tai Ji',
        parentId: testData.streams[0].id
      };
      request.post(basePath, token(1)).send(data).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    it('[KHI7] must forbid creating child streams in \'contribute\' streams', function (done) {
      const data = {
        name: 'Xing Yi',
        parentId: testData.streams[1].id
      };
      request.post(basePath, token(1)).send(data).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    it('[MCDP] must forbid deleting child streams in \'contribute\' streams', function (done) {
      request.del(reqPath(testData.streams[1].children[0].id), token(1)).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    it('[7B6P] must forbid updating \'contribute\' streams', function (done) {
      request.put(reqPath(testData.streams[1].id), token(1)).send({ name: 'Ba Gua' })
        .end(function (res) {
          validation.checkErrorForbidden(res, done);
        });
    });

    it('[RG5R] must forbid deleting \'contribute\' streams', function (done) {
      request.del(reqPath(testData.streams[1].id), token(1)).query({ mergeEventsWithParent: true })
        .end(function (res) {
          validation.checkErrorForbidden(res, done);
        });
    });

    it('[21AZ] must not allow creating child streams in trashed \'managed\' streams', function (done) {
      const data = {
        name: 'Dzogchen',
        parentId: testData.streams[2].children[0].id
      };
      request.post(basePath, token(1)).send(data).end(function (res) {
        res.statusCode.should.eql(400);
        done();
      });
    });

    it('[O1AZ] must allow creating child streams in \'managed\' streams', function (done) {
      const data = {
        name: 'Dzogchen',
        parentId: testData.streams[2].children[1].id
      };
      request.post(basePath, token(6)).send(data).end(function (res) {
        res.statusCode.should.eql(201);
        done();
      });
    });

    it('[5QPU] must forbid moving streams into non-\'managed\' parent streams', function (done) {
      const update = { parentId: testData.streams[1].id };
      request.put(reqPath(testData.streams[2].children[0].id), token(1))
        .send(update).end(function (res) {
          validation.checkErrorForbidden(res, done);
        });
    });

    it('[KP1Q] must allow deleting child streams in \'managed\' streams', function (done) {
      request.del(reqPath(testData.streams[2].children[0].children[0].id), token(1))
        .end(function (res) {
          res.statusCode.should.eql(200); // trashed -> considered an update
          done();
        });
    });

    it('[HHSS] must recursively apply permissions to the streams\' child streams', function (done) {
      const data = {
        name: 'Zen',
        parentId: testData.streams[0].children[0].id
      };
      request.post(basePath, token(1)).send(data).end(function (res) {
        validation.checkErrorForbidden(res, done);
      });
    });

    it('[NJ1A] must allow access to all streams when no specific stream permissions are defined',
      function (done) {
        const expected = validation.removeDeletions(_.cloneDeep(testData.streams));
        validation.addStoreStreams(expected);
        request.get(basePath, token(2)).query({ state: 'all' }).end(function (res) {
          res.body.streams = validation.removeAccountStreams(res.body.streams);
          res.body.streams.should.eql(expected);
          done();
        });
      });
  });

  describe('Auth and change tracking', function () {
    before(testData.resetStreams);

    beforeEach(testData.resetEvents);

    const basePath = '/' + user.username + '/events';
    const sharedAccessIndex = 1;
    const callerId = 'test-caller-id';
    const auth = token(sharedAccessIndex) + ' ' + callerId;
    const newEventData = {
      type: 'test/test',
      streamId: testData.streams[1].id
    };

    it('[YE49] must handle optional caller id in auth (in addition to token)', function (done) {
      request.post(basePath, auth).send(newEventData).end(function (res) {
        res.statusCode.should.eql(201);
        const event = res.body.event;
        const expectedAuthor = testData.accesses[sharedAccessIndex].id + ' ' + callerId;
        event.createdBy.should.eql(expectedAuthor);
        event.modifiedBy.should.eql(expectedAuthor);
        done();
      });
    });

    describe('custom auth step (e.g. to validate/parse caller id)', function () {
      const fileName = 'customAuthStepFn.js';
      const srcPath = path.join(__dirname, 'permissions.fixtures', fileName);
      const destPath = path.join(__dirname, '../../../custom-extensions', fileName);

      before(function (done) {
        async.series([
          function setupCustomAuthStep (stepDone) {
            fs.readFile(srcPath, function (err, data) {
              if (err) { return stepDone(err); }

              fs.writeFile(destPath, data, stepDone);
            });
          },
          server.restart.bind(server)
        ], function (err) {
          if (err) done(err);

          if (!fs.existsSync(destPath)) { throw new Error('Failed creating :' + destPath); }

          done();
        });
      });

      after(function (done) {
        async.series([
          function teardownCustomAuthStep (stepDone) {
            fs.unlink(destPath, stepDone);
          },
          server.restart.bind(server)
        ], done);
      });

      it('[IA9K] must be supported and deny access when failing', function (done) {
        request.post(basePath, auth).send(newEventData).end(function (res) {
          validation.checkErrorInvalidAccess(res, done);
        });
      });

      it('[H58R] must allow access when successful', function (done) {
        const successAuth = token(sharedAccessIndex) + ' Georges (unparsed)';
        request.post(basePath, successAuth).send(newEventData).end(function (res) {
          res.statusCode.should.eql(201);
          const event = res.body.event;
          const expectedAuthor = testData.accesses[sharedAccessIndex].id + ' Georges (parsed)';
          event.createdBy.should.eql(expectedAuthor);
          event.modifiedBy.should.eql(expectedAuthor);
          done();
        });
      });

      it('[H58Z] must allow access whith "callerid" headers', function (done) {
        const successAuth = token(sharedAccessIndex);
        request.post(basePath, successAuth)
          .set('callerid', 'Georges (unparsed)')
          .send(newEventData).end(function (err, res) {
            assert.notExists(err);
            res.statusCode.should.eql(201);
            const event = res.body.event;
            const expectedAuthor = testData.accesses[sharedAccessIndex].id + ' Georges (parsed)';
            event.createdBy.should.eql(expectedAuthor);
            event.modifiedBy.should.eql(expectedAuthor);
            done();
          });
      });

      it('[ISE4] must fail properly (i.e. not granting access) when the custom function crashes', function (done) {
        const crashAuth = token(sharedAccessIndex) + ' Please Crash';
        request.post(basePath, crashAuth).send(newEventData).end(function (res) {
          res.statusCode.should.eql(500);
          done();
        });
      });

      it('[P4OM] must validate the custom function at startup time', async () => {
        const srcPath = path.join(__dirname, 'permissions.fixtures', 'customAuthStepFn.invalid.js');
        fs.writeFileSync(destPath, fs.readFileSync(srcPath)); // Copy content of srcPath file to destPath
        try {
          await server.restartAsync();
        } catch (error) {
          assert.isNotNull(error);
          assert.exists(error.message);
          assert.match(error.message, /Server failed/);
        }
      });
    });
  });
});
