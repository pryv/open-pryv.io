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

/**
 * Tests Socket.IO access to the API.
 */

const timestamp = require('unix-timestamp');
const _ = require('lodash');
const { assert } = require('chai');
const bluebird = require('bluebird');
const async = require('async');
const io = require('socket.io-client');
// explicit require to benefit from static functions
const should = require('should');
const queryString = require('qs');
const charlatan = require('charlatan');
const superagent = require('superagent');

const { context } = require('./test-helpers');
const helpers = require('./helpers');
const ErrorIds = require('errors').ErrorIds;
const server = helpers.dependencies.instanceManager;
const streamsMethodsSchema = require('../src/schema/streamsMethods');
const eventsMethodsSchema = require('../src/schema/eventsMethods');
const validation = helpers.validation;
const testData = helpers.data;
const { integrity } = require('business');
const { ConditionVariable } = require('test-helpers').syncPrimitives;

describe('Socket.IO', function () {
  const user = structuredClone(testData.users[0]);
  const namespace = '/' + user.username;
  const otherUser = testData.users[1];
  let token = null;
  let otherToken = null;
  let cleanupConnections = [];

  // Connects to `namespace` given `queryParams`. Connections are disconnected
  // after each test automatically.
  function connect (namespace, queryParams) {
    const paramsWithNS = queryParams || {};
    const url = server.url + namespace + '?' + queryString.stringify(paramsWithNS);
    const conn = io.connect(url, { forceNew: true });
    cleanupConnections.push(conn);
    return conn;
  }

  // Disconnects all connections in cleanupConnections; then empties it.
  afterEach(() => {
    for (const conn of cleanupConnections) {
      conn.disconnect();
    }
    cleanupConnections = [];
  });

  let ioCons = {};
  // Waits until all the connections stored as properties of `ioCons` are
  // connected.
  function whenAllConnectedDo (callback) {
    const conKeys = Object.keys(ioCons); let conCount = 0;
    conKeys.forEach(function (key) {
      ioCons[key].once('connect', function () {
        conCount++;
        if (conCount === conKeys.length) {
          callback();
        }
      });
    });
  }

  // Reset ioCons to be empty.
  afterEach(() => {
    ioCons = {};
  });

  // Reset database contents for the tests here.
  before(function (done) {
    let request = null; let otherRequest = null;
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      function (stepDone) {
        // have some accesses ready for another account to check notifications
        testData.resetAccesses(stepDone, otherUser, null, true);
      },
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) {
        request = helpers.request(server.url);
        request.login(user, stepDone);
      },
      function (stepDone) {
        otherRequest = helpers.request(server.url);
        otherRequest.login(otherUser, stepDone);
      }
    ], function (err) {
      if (err) {
        return done(err);
      }
      token = request && request.token;
      otherToken = otherRequest && otherRequest.token;
      done();
    });
  });

  beforeEach(function (done) {
    async.series([testData.resetStreams, testData.resetEvents], done);
  });

  it('[25M0] must dynamically create a namespace for the user', function (done) {
    ioCons.con = connect(namespace, { auth: token });
    // We expect communication to work.
    ioCons.con.once('connect', done);
    ioCons.con.once('connect_error', function (err) {
      done(err || new Error('Connection failed.'));
    });
  });

  it('[9ZH8] must send correct CORS headers', async function () {
    const url = server.url +
            '/socket.io/' +
            namespace +
            '?auth=' +
            token +
            '&EIO=4&transport=polling';
    const res = await superagent
      .get(url)
      .set('Origin', 'https://www.bogus.com:6752');
    assert.equal(res.headers['access-control-allow-origin'], 'https://www.bogus.com:6752');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });

  it('[VGKX] must connect with twice user name in the path (DnsLess)', function (done) {
    const dashUser = testData.users[4]; let dashRequest = null;
    async.series([
      function (stepDone) {
        testData.resetAccesses(stepDone, dashUser, null, true);
      },
      function (stepDone) {
        dashRequest = helpers.request(server.url);
        dashRequest.login(dashUser, stepDone);
      },
      function (stepDone) {
        ioCons.con = connect('/' + dashUser.username + '/' + dashUser.username, { auth: testData.accesses[2].token });
        ioCons.con.once('error', function (e) {
          stepDone(e || new Error('Communication failed.'));
        });
        ioCons.con.once('connect', stepDone);
      }
    ], done);
  });

  it('[VGKH] must connect to a user with a dash in the username', function (done) {
    const dashUser = testData.users[4]; let dashRequest = null;
    async.series([
      function (stepDone) {
        testData.resetAccesses(stepDone, dashUser, null, true);
      },
      function (stepDone) {
        dashRequest = helpers.request(server.url);
        dashRequest.login(dashUser, stepDone);
      },
      function (stepDone) {
        ioCons.con = connect('/' + dashUser.username, {
          auth: testData.accesses[2].token
        });
        ioCons.con.once('error', function (e) {
          stepDone(e || new Error('Communication failed.'));
        });
        ioCons.con.once('connect', stepDone);
      }
    ], done);
  });

  it('[OSOT] must refuse connection if no valid access token is provided', function (done) {
    ioCons.con = connect(namespace);
    ioCons.con.once('connect', function () {
      done(new Error('Connecting should have failed'));
    });
    ioCons.con.once('connect_error', function () {
      // We expect failure, so we're done here.
      done();
    });
  });

  describe('calling API methods', function () {
    it('[FI6F] must properly route method call messages for events and return the results, including meta', function (done) {
      ioCons.con = connect(namespace, { auth: token });
      const params = {
        sortAscending: true,
        state: 'all',
        includeDeletions: true,
        modifiedSince: -10000,
        limit: 1000
      };
      ioCons.con.emit('events.get', params, async function (err, result) {
        assert.notExists(err);
        const separatedEvents = validation.separateAccountStreamsAndOtherEvents(result.events);
        result.events = separatedEvents.events;
        validation.checkSchema(result, eventsMethodsSchema.get.result);
        validation.sanitizeEvents(result.events);
        const testEvents = structuredClone(testData.events);
        const chronologicalEvents = _.sortBy(testEvents, 'time');
        const expectedEvents = validation.removeDeletionsAndHistory(chronologicalEvents);
        // lets separate core events from all other events and validate them separatelly
        // validate account streams events
        const actualAccountStreamsEvents = separatedEvents.accountStreamsEvents;
        validation.validateAccountEvents(actualAccountStreamsEvents);
        expectedEvents.forEach(integrity.events.set);
        result.events.should.eql(expectedEvents);
        // check deletions
        const deleted = _.filter(testData.events, { deleted: true });
        for (const el of deleted) {
          const deletion = _.find(result.eventDeletions, { id: el.id });
          should(deletion).not.be.empty();
          should(deletion.deleted).be.true();
        }
        // check untrashed
        const resultEvents = _.sortBy(result.events, 'id');
        const activeTestEvents = _(validation.removeDeletions(testData.events))
          .reject('headId')
          .sortBy('id')
          .value();
        activeTestEvents.forEach(integrity.events.set);
        should(resultEvents).be.eql(activeTestEvents);
        validation.checkMeta(result);
        done();
      });
    });

    it('[O3SW] must properly route method call messages for streams and return the results', function (done) {
      ioCons.con = connect(namespace, { auth: token });
      const expected = structuredClone(testData.streams);
      validation.addStoreStreams(expected);
      ioCons.con.emit('streams.get', { state: 'all' }, function (err, result) {
        assert.notExists(err);
        result.streams = validation.removeAccountStreams(result.streams);
        validation.checkSchema(result, streamsMethodsSchema.get.result);
        result.streams.should.eql(validation.removeDeletions(expected));
        done();
      });
    });

    it('[TO6Z] must accept streamQuery as Javascript Object', function (done) {
      ioCons.con = connect(namespace, { auth: token });
      ioCons.con.emit('events.get', { streams: { any: ['s_0_1'], all: ['s_8'] } }, function (err, res) {
        should(err).be.null();
        should(res.events).not.be.null();
        done();
      });
    });

    it('[NGUZ] must not crash when callers omit the callback', function (done) {
      ioCons.con = connect(namespace, { auth: token });
      ioCons.con.emit('events.get', {} /* no callback here */);
      process.nextTick(function () {
        server.crashed().should.eql(false);
        done();
      });
    });

    it('[ACA3] must fail if the called target does not exist', function (done) {
      ioCons.con = connect(namespace, { auth: token });
      ioCons.con.emit('badTarget.get', {}, function (err) {
        validation.checkSchema(err, validation.schemas.errorResult);
        err.error.id.should.eql(ErrorIds.InvalidMethod);
        done();
      });
    });

    it('[L8WJ] must fail if the called method does not exist', function (done) {
      ioCons.con = connect(namespace, { auth: token });
      ioCons.con.emit('streams.badMethod', {}, function (err) {
        validation.checkSchema(err, validation.schemas.errorResult);
        err.error.id.should.eql(ErrorIds.InvalidMethod);
        done();
      });
    });

    it('[SNCW] must return API errors properly, including meta', function (done) {
      ioCons.con = connect(namespace, { auth: token });
      ioCons.con.emit('events.create', { badParam: 'bad-data' }, function (err /*, result */) {
        validation.checkSchema(err, validation.schemas.errorResult);
        validation.checkMeta(err);
        done();
      });
    });

    it('[744Z] must notify other sockets for the same user about events changes', () => {
      ioCons.con1 = connect(namespace, { auth: token }); // personal access
      ioCons.con2 = connect(namespace, { auth: testData.accesses[2].token }); // "read all" access
      return new Promise((resolve, reject) => {
        ioCons.con2.on('eventsChanged', function () {
          resolve();
        });
        whenAllConnectedDo(function () {
          const params = {
            time: timestamp.fromDate('2012-03-22T10:00'),
            duration: timestamp.duration('3h33m'),
            type: 'test/test',
            streamId: testData.streams[0].id
          };
          ioCons.con1.emit('events.create', params, function (err /*, result */) {
            if (err) { reject(err); }
          });
        });
      });
    });

    it('[GJLT] must notify other sockets for the same user (only) about streams changes', function () {
      ioCons.con1 = connect(namespace, { auth: token }); // personal access
      ioCons.otherCon = connect('/' + otherUser.username, { auth: otherToken });
      return new Promise((resolve, reject) => {
        // We do _not_ want otherCon to be notified.
        ioCons.otherCon.once('streamsChanged', reject);
        // NOTE How to test if no notifications are sent to otherCon? We reject
        //  if we receive one - but have to wait for notifications to get in to
        //  make this effective. Let's sacrifice 100ms.
        setTimeout(resolve, 100);
        // Now create a stream for con1.
        whenAllConnectedDo(function () {
          const params = {
            name: 'Rutabaga',
            parentId: undefined
          };
          ioCons.con1.emit('streams.create', params, (err) => {
            if (err) { reject(err); }
          });
        });
      });
    });

    it('[JC99] must notify on each change', async function () {
      const tokens = [token, testData.accesses[2].token];
      const socketConnections = tokens.map((token) => connect(namespace, { auth: token }));
      const createConnection = socketConnections[0];
      const donePromises = socketConnections.map((conn) => {
        const [promise, cb] = expectNCalls(2);
        conn.on('streamsChanged', cb);
        return promise;
      });
      await createStream(createConnection, { name: 'foo' });
      await createStream(createConnection, { name: 'bar' });
      return bluebird.all(donePromises);
      function createStream (conn, params) {
        return bluebird.fromCallback((cb) => conn.emit('streams.create', params, cb));
      }
    });
  });

  describe('when using an access with a "create-only" permission', function () {
    it('[K2OO] must allow a connection', function (done) {
      let streamId, createOnlyToken;
      async.series([
        function (stepDone) {
          superagent
            .post(server.url + '/' + user.username + '/streams')
            .set('Authorization', token)
            .send({
              id: charlatan.Lorem.word(),
              name: charlatan.Lorem.word()
            })
            .end(function (err, res) {
              assert.notExists(err);
              streamId = res.body.stream.id;
              stepDone();
            });
        },
        function (stepDone) {
          superagent
            .post(server.url + '/' + user.username + '/accesses')
            .set('Authorization', token)
            .send({
              name: charlatan.Lorem.word(),
              type: 'app',
              permissions: [
                {
                  streamId,
                  level: 'create-only'
                }
              ]
            })
            .end(function (err, res) {
              assert.notExists(err);
              createOnlyToken = res.body.access.token;
              stepDone();
            });
        },
        function (stepDone) {
          ioCons.con = connect(namespace, { auth: createOnlyToken });
          ioCons.con.once('connect', function () {
            stepDone();
          });
          ioCons.con.once('error', function (/* err */) {
            stepDone(new Error('Connecting should have failed'));
          });
        }
      ], done);
    });
  });

  describe('when spawning 2 api-server processes, A and B', () => {
    // Servers A and B, length will be 2
    let servers = [];

    before(function () {
      if (!process.env.PRYV_NATS) { this.skip(); }
    });

    // Client connections that we make. If you add your connection here, it
    // will get #close()d.
    let connections;
    beforeEach(() => {
      connections = [];
    });
    // Closes all `connections` after each test.
    afterEach(() => {
      for (const conn of connections) {
        conn.disconnect();
      }
    });

    function sleep (ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Spawns A and B.
    beforeEach(async () => {
      // Stop a few servers here; this is just so that we can maybe reclaim
      // some memory and sockets. Actual cleanup is done in `after()` below.
      if (servers && servers.length > 0) {
        for (const server of servers) { server.stop(); }
      }
      // Spawn two new servers.
      servers = await bluebird.all(context.spawn_multi(2));
      // give a chance to Socket.io to set-up.
      await sleep(1000);
    });

    it('[JJRA] changes made in A notify clients of B', async () => {
      if (token == null) { throw new Error('AF: token must be set'); }
      // Aggregate user data to be more contextual
      const user = {
        username: testData.users[0].username,
        token
      };
      const eventReceived = new ConditionVariable();
      const conn1 = connectTo(servers[0], user);
      const conn2 = connectTo(servers[1], user);
      const msgs = [];
      conn2.on('eventsChanged', () => {
        msgs.push('ec');
        eventReceived.broadcast();
      });
      conn2.on('error', (data) => {
        throw new Error(data);
      });
      await addEvent(conn1);
      if (msgs.length === 0) { await eventReceived.wait(1000); }
      assert.deepEqual(msgs, ['ec']);
    });

    // Connect to `server` using `user` as credentials.
    function connectTo (server, user) {
      const namespace = `/${user.username}`;
      const params = { auth: user.token, resource: namespace };
      const url = server.url(namespace) + `?${queryString.stringify(params)}`;
      const conn = io.connect(url, { forceNew: true });
      // Automatically add all created connections to the cleanup array:
      connections.push(conn);
      return conn;
    }

    // Creates an event, using socket connection `conn`.
    function addEvent (conn) {
      const stream = testData.streams[0];
      const attributes = {
        type: 'mass/kg',
        content: '1',
        streamId: stream.id
      };
      return bluebird.fromCallback((cb) => conn.emit('events.create', attributes, cb));
    }
  });
});

// Returns a tuple of a (promise, callback). The promise fulfills when the
// callback is called `n` times.
/**
 * @param {number} n
 * @returns {[Promise<void>, () => void]}
 */
function expectNCalls (n) {
  let callCount = 0;
  let deferred;
  const promise = new Promise((resolve) => {
    deferred = resolve;
  });
  const fun = () => {
    callCount += 1;
    if (deferred == null) { throw new Error('AF: deferred promise is created synchronously.'); }
    if (callCount >= n) { deferred(); }
  };
  return [promise, fun];
}

/**
 * @typedef {{
 *   name: string;
 *   token: string;
 * }} User
 */

/**
 * @typedef {{
 *   on: (event: string, cb: () => void) => void;
 *   emit: (event: string, params: any, cb: () => void) => void;
 * }} SocketIO$Client
 */
