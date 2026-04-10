/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Tests pertaining to storing data in a hf series.

const assert = require('node:assert');
const cuid = require('cuid');
const lodash = require('lodash');
const awaiting = require('awaiting');
const timestamp = require('unix-timestamp');

const { spawnContext, produceStorageConnection, produceSeriesConnection, getTimeDelta } = require('./test-helpers');
const { databaseFixture } = require('test-helpers');
const apiServerContext = require('api-server/test/test-helpers').context;
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('store_data.test');
const { getMall } = require('mall');
const { getUsersRepository } = require('business/src/users');
describe('[SDHF] Storing data in a HF series', function () {
  let database, pryv;
  let mall;
  let seriesConn;
  before(async function () {
    database = await produceStorageConnection();
    mall = await getMall();
    pryv = databaseFixture(database);
    seriesConn = await produceSeriesConnection();
  });
  describe('[SD01] Use Case: Store data in InfluxDB, Verification on either half', function () {
    let server;
    before(async () => {
      logger.debug('spawning');
      server = await spawnContext.spawn();
    });
    after(() => {
      server.stop();
    });
    after(function () {
      pryv.clean();
    });
    const nowEvent = timestamp.now();
    // Set up a few ids that we'll use for testing. NOTE that these ids will
    // change on every test run.
    let userId, parentStreamId, secondStreamId, eventId, accessToken, secondStreamToken;
    before(async () => {
      userId = cuid();
      parentStreamId = cuid();
      secondStreamId = cuid();
      eventId = cuid();
      accessToken = cuid();
      secondStreamToken = cuid();
      logger.debug('build fixture');
      const user = await pryv.user(userId, {});
      await user.stream({ id: secondStreamId });
      await user.stream({ id: parentStreamId });
      await user.event({
        id: eventId,
        type: 'series:mass/kg',
        time: nowEvent,
        streamIds: [parentStreamId, secondStreamId]
      });
      await user.access({ token: accessToken, type: 'personal' });
      await user.session(accessToken);
      await user.access({
        token: secondStreamToken,
        type: 'app',
        permissions: [
          {
            streamId: secondStreamId,
            level: 'create-only'
          }
        ]
      });
    });
    function storeData (data, token) {
      logger.debug('storing some data', data);
      // Insert some data into the events series:
      const postData = {
        format: 'flatJSON',
        fields: Object.keys(data),
        points: [Object.values(data)]
      };
      const request = server.request();
      return request
        .post(`/${userId}/events/${eventId}/series`)
        .set('authorization', token)
        .send(postData)
        .expect(200);
    }
    it('[ZUBI] should convert timestamp to deltaTime', async () => {
      const nowPlus1Sec = nowEvent + 1;
      await storeData({ timestamp: nowPlus1Sec, value: 80.3 }, accessToken);
      // Check if the data is really there
      const userName = userId; // identical with id here, but will be user name in general.
      const options = { database: `user.${userName}` };
      const query = `
        SELECT * FROM "event.${eventId}"
      `;
      const result = await seriesConn.query(query, options);
      const row = result[0];
      if (row.time == null || row.value == null) { throw new Error('Should have time and value.'); }
      assert.strictEqual(getTimeDelta(row.time), 1);
      assert.strictEqual(row.value, 80.3);
    });
    it('[GZIZ] should store data correctly', async () => {
      const response = await storeData({ deltaTime: 1, value: 80.3 }, accessToken);
      const body = response.body;
      if (body == null || body.status == null) { throw new Error(); }
      assert.strictEqual(body.status, 'ok');
      // Check if the data is really there
      const userName = userId; // identical with id here, but will be user name in general.
      const options = { database: `user.${userName}` };
      const query = `
        SELECT * FROM "event.${eventId}"
      `;
      const result = await seriesConn.query(query, options);
      const row = result[0];
      if (row.time == null || row.value == null) { throw new Error('Should have time and value.'); }
      assert.strictEqual(getTimeDelta(row.time), 1);
      assert.strictEqual(row.value, 80.3);
    });
    it('[KC15] should return data once stored', async () => {
      const userName = userId;
      const dbName = `user.${userName}`;
      await cycleDatabase(dbName);
      // Store data via HFS API (engine-agnostic)
      await storeData({ deltaTime: 2, value: 1234 }, accessToken);
      await queryData();
      function cycleDatabase (dbName) {
        return seriesConn
          .dropDatabase(dbName)
          .then(() => seriesConn.createDatabase(dbName));
      }
      function queryData () {
        const request = server.request();
        return (request
          .get(`/${userId}/events/${eventId}/series`)
          .set('authorization', accessToken)
          .query({
            fromDeltaTime: '1',
            toDeltaTime: '3'
          })
          .expect(200)
          .then((res) => {
            const points = res.body.points || [];
            assert.ok(points.length > 0);
            assert.deepEqual(points[0], [2, 1234]);
          }));
      }
    });
    it("[YALY] should accept a request when the authorized permission is on the event's 2nd streamId", async () => {
      await storeData({ deltaTime: 10, value: 54 }, secondStreamToken);
    });
  });
  describe('[SD02] UPDATE and DELETE on handling event affect the serie', function () {
    this.timeout(5000);
    // TODO Worry about deleting data that we stored in earlier tests.
    let hfServer;
    let apiServer;
    // Spawns a server.
    before(async () => {
      logger.debug('spawning');
      hfServer = await spawnContext.spawn();
      apiServer = await apiServerContext.spawn();
    });
    after(() => {
      hfServer.stop();
      apiServer.stop();
    });
    after(function () {
      pryv.clean();
    });
    let userId, parentStreamId, accessToken;
    before(() => {
      userId = cuid();
      parentStreamId = cuid();
      accessToken = cuid();
      logger.debug('build fixture');
      return pryv.user(userId, {}, function (user) {
        user.stream({ id: parentStreamId }, function () { });
        user.access({ token: accessToken, type: 'personal' });
        user.session(accessToken);
      });
    });
    // Tries to store `data` in an event with attributes `attrs`. Returns
    // true if the whole operation is successful.
    //
    async function tryStore (attrs, header, data) {
      const effectiveAttrs = lodash.merge({ streamIds: [parentStreamId], time: timestamp.now() }, attrs);
      const usersRepository = await getUsersRepository();
      const user = await usersRepository.getUserById(userId);
      assert.ok(user);
      const event = await mall.events.create(user.id, effectiveAttrs);
      const requestData = {
        format: 'flatJSON',
        fields: header,
        points: data
      };
      const request = hfServer.request();
      const response = await request
        .post(`/${userId}/events/${event.id}/series`)
        .set('authorization', accessToken)
        .send(requestData);
      if (response.statusCode !== 200) {
        logger.debug('Failed to store data, debug report:');
        logger.debug('response.body', response.body);
      }
      logger.debug('Enter these commands into influx CLI to inspect the data:');
      logger.debug(`  use "user.${user.id}"`);
      logger.debug(`  select * from "event.${event.id}"`);
      logger.debug(`  show field keys from "event.${event.id}"`);
      return {
        ok: response.statusCode === 200,
        user,
        event,
        status: response.statusCode,
        body: response.body
      };
    }
    async function storeData (eventId, data) {
      const request = hfServer.request();
      const response = await request
        .post(`/${userId}/events/${eventId}/series`)
        .set('authorization', accessToken)
        .send(data);
      return response;
    }
    it('[UD1C] moving event in time does empty the cache', async () => {
      // This is visible if after moving the "timestamp" sugar is valid
      // 1 - Create an event with some values
      const result = await tryStore({ type: 'series:angular-speed/rad-s' }, ['deltaTime', 'value'], [
        [1, 1],
        [2, 2],
        [3, 3]
      ]);
      // move event to tomorrow
      const newEventTime = timestamp.now() + 60 * 60 * 24;
      await apiServer
        .request()
        .put('/' + result.user.username + '/events/' + result.event.id)
        .set('authorization', accessToken)
        .send({ time: newEventTime });
      // There is the need to syncronize separate services, otherwise the new
      // reference time is taken from the cache instead of mongodb (cache is not invalidated on time)
      await awaiting.delay(500);
      // add Data using timestamp sugar
      await storeData(result.event.id, {
        format: 'flatJSON',
        fields: ['timestamp', 'value'],
        points: [
          [newEventTime + 4, 4],
          [newEventTime + 5, 5],
          [newEventTime + 6, 6]
        ]
      });
      // check Data
      const request = hfServer.request();
      return (request
        .get(`/${result.user.username}/events/${result.event.id}/series`)
        .set('authorization', accessToken)
        .query({})
      // .then((res) => console.log(require('util').inspect(res.body, { depth: null })))
        .expect(200)
        .then((res) => {
          const points = res.body.points || [];
          assert.ok(points.length > 0);
          assert.deepEqual(points[5], [6, 6]);
        }));
    });
    it('[UD2C] trashed event cannot be written to', async () => {
      // This is visible if after moving the "timestamp" sugar is valid
      // 1 - Create an event with some values
      const result = await tryStore({ type: 'series:angular-speed/rad-s' }, ['deltaTime', 'value'], [
        [1, 1],
        [2, 2],
        [3, 3]
      ]);
      // move event to tomorrow
      const newEventTime = timestamp.now() + 60 * 60 * 24;
      await apiServer
        .request()
        .delete('/' + result.user.username + '/events/' + result.event.id)
        .set('authorization', accessToken);
      // wait a moment before checking if event was deleted correctly
      await awaiting.delay(500);
      // add Data using timestamp sugar
      const result2 = await storeData(result.event.id, {
        format: 'flatJSON',
        fields: ['timestamp', 'value'],
        points: [
          [newEventTime + 4, 4],
          [newEventTime + 5, 5],
          [newEventTime + 6, 6]
        ]
      });
      assert.strictEqual(result2.status, 400);
      const error = result2.body.error;
      assert.strictEqual(error.id, 'invalid-operation');
      assert.strictEqual(typeof error.message, 'string');
      assert.strictEqual(error.message, `The referenced event "${result.event.id}" is trashed.`);
      assert.deepEqual(error.data, { trashedReference: 'eventId' });
    });
    it('[ZTG6] deleted events deletes series', async function () {
      // This is visible if after moving the "timestamp" sugar is valid
      // 1 - Create an event with some values
      const result = await tryStore({ type: 'series:angular-speed/rad-s' }, ['deltaTime', 'value'], [
        [1, 1],
        [2, 2],
        [3, 3]
      ]);
      const delete1 = await apiServer
        .request()
        .delete('/' + result.user.username + '/events/' + result.event.id)
        .set('authorization', accessToken);
      assert.strictEqual(delete1.status, 200);
      const query = `select * from "event.${result.event.id}"`;
      const opts = {
        database: `user.${result.user.id}`
      };
      const rows = await seriesConn.query(query, opts);
      assert.strictEqual(rows.length, 3);
      const delete2 = await apiServer
        .request()
        .delete('/' + result.user.username + '/events/' + result.event.id)
        .set('authorization', accessToken);
      assert.strictEqual(delete2.status, 200);
      await awaiting.delay(100);
      const rows2 = await seriesConn.query(query, opts);
      assert.strictEqual(rows2.length, 0);
    });
  });
  describe('[SD03] POST /events/EVENT_ID/series', function () {
    // TODO Worry about deleting data that we stored in earlier tests.
    let server;
    describe('[SD31] bypassing authentication', () => {
      const EVENT_ID = 'EVENTID';
      function storeData (data) {
        const request = server.request();
        const response = request
          .post(`/USERNAME/events/${EVENT_ID}/series`)
          .set('authorization', 'AUTH_TOKEN')
          .send(data);
        return response;
      }
      function queryData () {
        const request = server.request();
        const response = request
          .get(`/USERNAME/events/${EVENT_ID}/series`)
          .set('authorization', 'KEN SENT ME')
          .query({
            fromTime: '1481677844',
            toTime: '1481677850'
          });
        return response.expect(200).then((res) => {
          return res.body;
        });
      }
      function produceData () {
        return {
          format: 'flatJSON',
          fields: ['deltaTime', 'value'],
          points: [
            [0, 14.1],
            [1, 14.2],
            [2, 14.3]
          ]
        };
      }
      describe('[SD32] with auth success', function () {
        before(async () => {
          logger.debug('spawning');
          server = await spawnContext.spawn();
        });
        after(() => {
          server.stop();
        });
        // Bypass authentication check: Succeed always
        beforeEach(function () {
          server.process.sendToChild('mockAuthentication', true);
        });
        it('[N3PM] stores data into InfluxDB', function () {
          const data = produceData();
          return storeData(data)
            .expect(200)
            .then(queryData)
            .then((response) => {
              // Verify HTTP response content
              assert.ok(response);
              assert.deepEqual(response.fields, ['deltaTime', 'value']);
              assert.deepEqual(response.points, data.points);
            });
        });
        // Fixes #212
        it('[TL0D] should return core-metadata in every call', async function () {
          const data = produceData();
          const res = await storeData(data);
          assert.strictEqual(res.status, 200);
          assert.ok(res.body.meta);
        });
        it('[RESC] should reject non-JSON bodies', function () {
          const response = server
            .request()
            .post(`/USERNAME/events/${EVENT_ID}/series`)
            .set('authorization', 'AUTH_TOKEN')
            .type('form')
            .send({ format: 'flatJSON' });
          return response.expect(400);
        });
        it('[KT1R] responds with headers that allow CORS on OPTIONS', async () => {
          const request = server.request();
          const response = await request
            .options(`/USERNAME/events/${EVENT_ID}/series`)
            .set('origin', 'https://foo.bar.baz')
            .set('authorization', 'AUTH_TOKEN')
            .send();
          assert.strictEqual(response.statusCode, 200);
          const headers = response.headers;
          assert.strictEqual(headers['access-control-allow-credentials'], 'true');
          assert.strictEqual(headers['access-control-allow-origin'], 'https://foo.bar.baz');
        });
        it('[H1CG] responds with headers that allow CORS on POST', async () => {
          const request = server.request();
          const response = await request
            .post(`/USERNAME/events/${EVENT_ID}/series`)
            .set('origin', 'https://foo.bar.baz')
            .set('authorization', 'AUTH_TOKEN')
            .send({});
          assert.strictEqual(response.statusCode, 400);
          const headers = response.headers;
          assert.strictEqual(headers['access-control-allow-credentials'], 'true');
          assert.strictEqual(headers['access-control-allow-origin'], 'https://foo.bar.baz');
        });
        describe('[SD33] when request is malformed', function () {
          malformed('format is not flatJSON', {
            format: 'JSON',
            fields: ['deltaTime', 'value'],
            points: [
              [0, 14.1],
              [1, 14.2],
              [2, 14.3]
            ]
          }, '96HC');
          malformed('matrix is not square - not enough fields', {
            format: 'flatJSON',
            fields: ['deltaTime', 'value'],
            points: [[0, 14.1], [1], [2, 14.3]]
          }, '38W3');
          malformed('no negative deltaTime', {
            format: 'flatJSON',
            fields: ['deltaTime', 'value'],
            points: [
              [-1, 14.1],
              [1, 14.2],
              [2, 14.3]
            ]
          }, 'GJL5');
          malformed('value types are not all valid', {
            format: 'flatJSON',
            fields: ['deltaTime', 'value'],
            points: [
              [0, 14.1],
              [1, 'foobar'],
              [2, 14.3]
            ]
          }, 'GJL4');
          malformed('missing deltaTime column', {
            format: 'flatJSON',
            fields: ['value'],
            points: [[14.1], [13.2], [14.3]]
          }, 'JJRO');
          malformed('missing value column for a simple input', {
            format: 'flatJSON',
            fields: ['deltaTime'],
            points: [[0], [1], [2]]
          }, 'LKFG');
          function malformed (text, data, testID) {
            it(`[${testID}] should be rejected (${text})`, function () {
              return storeData(data)
                .expect(400)
                .then((res) => {
                  const error = res.body.error;
                  assert.strictEqual(error.id, 'invalid-request-structure');
                });
            });
          }
        });
        describe('[SD34] when using a metadata updater stub', () => {
          beforeEach(async () => {
            await server.process.sendToChild('mockMetadataUpdater');
          });
          afterEach(async () => {
            // Since we modified the test server, spawn a new one that is clean.
            server.stop();
            server = await spawnContext.spawn();
          });
          it('[GU3L] should schedule a metadata update on every store', async () => {
            const data = produceData();
            await storeData(data).expect(200);
            const calls = await server.process.sendToChild('getMetadataUpdaterCalls');
            assert.strictEqual(calls.length >= 1, true);
          });
        });
      });
      describe('[SD35] with auth failure', function () {
        before(async () => {
          logger.debug('spawning');
          server = await spawnContext.spawn();
        });
        after(() => {
          server.stop();
        });
        // Bypass authentication check: Fail always
        beforeEach(async function () {
          await server.process.sendToChild('mockAuthentication', false);
        });
        it('[NLAW] refuses invalid/unauthorized accesses', function () {
          const data = produceData();
          return storeData(data)
            .expect(403)
            .then((res) => {
              const error = res.body.error;
              assert.strictEqual(error.id, 'forbidden');
              assert.strictEqual(typeof error.message, 'string');
            });
        });
      });
    });
    describe('[SD36] storing data in different formats', () => {
      // Spawns a server.
      before(async () => {
        logger.debug('spawning');
        server = await spawnContext.spawn();
      });
      after(() => {
        server.stop();
      });
      after(function () {
        pryv.clean();
      });
      let userId, parentStreamId, accessToken;
      before(() => {
        userId = cuid();
        parentStreamId = cuid();
        accessToken = cuid();
        logger.debug('build fixture');
        return pryv.user(userId, {}, function (user) {
          user.stream({ id: parentStreamId }, function () { });
          user.access({ token: accessToken, type: 'personal' });
          user.session(accessToken);
        });
      });
      // Tries to store `data` in an event with attributes `attrs`. Returns
      // true if the whole operation is successful.
      //
      async function tryStore (attrs, header, data) {
        const effectiveAttrs = lodash.merge({ streamIds: [parentStreamId], time: timestamp.now() }, attrs);
        const usersRepository = await getUsersRepository();
        const user = await usersRepository.getUserById(userId);
        assert.ok(user);
        const event = await mall.events.create(user.id, effectiveAttrs);
        const requestData = {
          format: 'flatJSON',
          fields: header,
          points: data
        };
        const request = server.request();
        const response = await request
          .post(`/${userId}/events/${event.id}/series`)
          .set('authorization', accessToken)
          .send(requestData);
        if (response.statusCode !== 200) {
          logger.debug('Failed to store data, debug report:');
          logger.debug('response.body', response.body);
        }
        logger.debug('Enter these commands into influx CLI to inspect the data:');
        logger.debug(`  use "user.${user.id}"`);
        logger.debug(`  select * from "event.${event.id}"`);
        logger.debug(`  show field keys from "event.${event.id}"`);
        return {
          ok: response.statusCode === 200,
          user,
          event,
          status: response.statusCode,
          body: response.body
        };
      }
      it('[Y3BL] stores data of any basic type', async () => {
        const now = 6;
        const result = await tryStore({ type: 'series:angular-speed/rad-s' }, ['deltaTime', 'value'], [
          [now - 3, 1],
          [now - 2, 2],
          [now - 1, 3]
        ]);
        assert.strictEqual(result.ok, true);
      });
      it('[3WGH] stores data of complex types', async () => {
        const now = 6;
        const { ok } = await tryStore({ type: 'series:ratio/generic' }, ['deltaTime', 'value', 'relativeTo'], [
          [now - 3, 1, 2],
          [now - 2, 2, 2],
          [now - 1, 3, 2]
        ]);
        assert.strictEqual(ok, true);
      });
      it("[1NDB] doesn't accept data in non-series format", async () => {
        const now = 6;
        const { ok, body } = await tryStore({ type: 'angular-speed/rad-s' }, ['deltaTime', 'value'], [
          [now - 3, 1],
          [now - 2, 2],
          [now - 1, 3]
        ]);
        assert.strictEqual(ok, false);
        const error = body.error;
        assert.strictEqual(error.id, 'invalid-operation');
      });
      it('[YMHK] stores strings', async () => {
        const aLargeString = '2222222'.repeat(100);
        const now = 20;
        const result = await tryStore({ type: 'series:call/telephone' }, ['deltaTime', 'value'], [[now - 10, aLargeString]]);
        assert.strictEqual(result.ok, true);
      });
      it('[ZL7C] stores floats', async () => {
        const now = 10000000;
        const aHundredRandomFloats = lodash.times(100, (idx) => [
          now - 100 + idx,
          Math.random() * 1e6
        ]);
        const result = await tryStore({ type: 'series:mass/kg' }, ['deltaTime', 'value'], aHundredRandomFloats);
        assert.strictEqual(result.ok, true);
        const query = `select * from "event.${result.event.id}"`;
        const opts = {
          database: `user.${result.user.id}`
        };
        const rows = await seriesConn.query(query, opts);
        assert.strictEqual(rows.length, aHundredRandomFloats.length);
        for (const [exp, act] of lodash.zip(aHundredRandomFloats, rows)) {
          if (act.time == null) { throw new Error('AF: time cannot be null'); }
          const timestamp = getTimeDelta(act.time);
          if (typeof exp[1] !== 'number') { throw new Error('AF: ridiculous flow inference removal'); }
          const expectedTs = Number(exp[0]);
          const expectedValue = Number(exp[1]);
          assert.ok(Math.abs(expectedTs - timestamp) <= 0.1);
          assert.ok(Math.abs(expectedValue - act.value) <= 0.001);
        }
      });
    });
    describe('[SD37] complex types such as ratio/generic', () => {
      // Spawns a server.
      before(async () => {
        logger.debug('spawning');
        server = await spawnContext.spawn();
      });
      after(() => {
        server.stop();
      });
      after(function () {
        pryv.clean();
      });
      // Database fixture: `eventId` will contain the event that has a type
      // 'series:ratio/generic'
      let userId, parentStreamId, ratioEventId, positionEventId, accessToken;
      before(() => {
        userId = cuid();
        parentStreamId = cuid();
        ratioEventId = cuid();
        positionEventId = cuid();
        accessToken = cuid();
        return pryv.user(userId, {}, function (user) {
          user.stream({ id: parentStreamId }, function (stream) {
            stream.event({
              id: ratioEventId,
              type: 'series:ratio/generic'
            });
            stream.event({
              id: positionEventId,
              type: 'series:position/wgs84'
            });
          });
          user.access({ token: accessToken, type: 'personal' });
          user.session(accessToken);
        });
      });
      // Tries to store complex `data` in the event identified by `eventId`.
      //
      async function tryStore (header, data, eventId) {
        const response = await storeOp(header, data, eventId);
        return response.statusCode === 200;
      }
      // Attempts a store operation and expects to fail. Returns details on
      // the error.
      async function failStore (header, data, eventId) {
        const response = await storeOp(header, data, eventId);
        assert.notStrictEqual(response.statusCode, 200);
        const body = response.body;
        const error = body.error;
        return {
          status: response.statusCode,
          id: error.id,
          message: error.message
        };
      }
      async function storeOp (header, data, eventId) {
        eventId = eventId || ratioEventId;
        const requestData = {
          format: 'flatJSON',
          fields: header,
          points: data
        };
        const request = server.request();
        const response = await request
          .post(`/${userId}/events/${eventId}/series`)
          .set('authorization', accessToken)
          .send(requestData);
        return response;
      }
      describe('[SD38] null fields', () => {
        it('[7UZT] accept null fields', async () => {
          const headers = ['deltaTime', 'latitude', 'longitude', 'speed'];
          const data = [
            [1, 2, 3, 4],
            [2, 2, 3, null],
            [3, 2, 3, 4]
          ];
          const res = await storeOp(headers, data, positionEventId);
          assert.strictEqual(res.body.status, 'ok');
        });
        it('[7UTT] do not accept null for required fields', async () => {
          const headers = ['deltaTime', 'latitude', 'longitude', 'speed'];
          const data = [
            [1, 2, 3, 4],
            [2, 2, null, 5],
            [3, 2, 3, 4]
          ];
          const res = await storeOp(headers, data, positionEventId);
          assert.ok(res.body.error);
          assert.strictEqual(res.body.error.id, 'invalid-request-structure');
        });
      });
      describe('[SD39] when not all required fields are given', () => {
        const now = 6;
        const args = [
          ['deltaTime', 'value'],
          [
            [now - 3, 1],
            [now - 2, 2],
            [now - 1, 3]
          ]
        ];
        it('[FNDT] refuses to store when not all required fields are given', async () => {
          assert.strictEqual(await tryStore(...args), false);
        });
        it('[H525] returns error id "invalid-request-structure"', async () => {
          const { status, id, message } = await failStore(...args);
          assert.strictEqual(status, 400);
          assert.strictEqual(id, 'invalid-request-structure');
          assert.strictEqual(message, '"fields" field must contain valid field names for the series type.');
        });
      });
      it('[DTZ2] refuses to store when deltaTime is present twice (ambiguous!)', async () => {
        const now = 6;
        assert.strictEqual(await tryStore(['deltaTime', 'deltaTime', 'value', 'relativeTo'], [
          [now - 3, now - 6, 1, 1],
          [now - 2, now - 5, 2, 2],
          [now - 1, now - 4, 3, 3]
        ]), false);
      });
      it('[UU4R] refuses to store when other fields are present twice (ambiguous!)', async () => {
        const now = 6;
        assert.strictEqual(await tryStore(['deltaTime', 'value', 'value', 'relativeTo'], [
          [now - 3, 3, 1, 1],
          [now - 2, 2, 2, 2],
          [now - 1, 1, 3, 3]
        ]), false);
      });
      describe("[SD40] when field names don't match the type", () => {
        const now = 6;
        const args = [
          ['deltaTime', 'value', 'relativeFrom'],
          [
            [now - 3, 3, 1],
            [now - 2, 2, 2],
            [now - 1, 1, 3]
          ]
        ];
        it("[AJMS] refuses to store when field names don't match the type", async () => {
          assert.strictEqual(await tryStore(...args), false);
        });
        it('[7CR7] returns the error message with the id "invalid-request-structure"', async () => {
          const { status, id, message } = await failStore(...args);
          assert.strictEqual(status, 400);
          assert.strictEqual(id, 'invalid-request-structure');
          assert.strictEqual(message, '"fields" field must contain valid field names for the series type.');
        });
      });
    });
    describe('[SD41] complex types such as position/wgs84', () => {
      // Spawns a server.
      before(async () => {
        logger.debug('spawning');
        server = await spawnContext.spawn();
      });
      after(() => {
        server.stop();
      });
      after(function () {
        pryv.clean();
      });
      // Database fixture: `eventId` will contain the event that has a type
      // 'series:ratio/generic'
      let userId, parentStreamId, eventId, accessToken;
      before(() => {
        userId = cuid();
        parentStreamId = cuid();
        eventId = cuid();
        accessToken = cuid();
        logger.debug('build fixture');
        return pryv.user(userId, {}, function (user) {
          user.stream({ id: parentStreamId }, function (stream) {
            stream.event({
              id: eventId,
              type: 'series:position/wgs84'
            });
          });
          user.access({ token: accessToken, type: 'personal' });
          user.session(accessToken);
        });
      });
      // Tries to store complex `data` in the event identified by `eventId`.
      //
      async function tryStore (header, data) {
        const requestData = {
          format: 'flatJSON',
          fields: header,
          points: data
        };
        const request = server.request();
        const response = await request
          .post(`/${userId}/events/${eventId}/series`)
          .set('authorization', accessToken)
          .send(requestData);
        return response.statusCode === 200;
      }
      it('[UDHO] allows storing any number of optional fields, on each request', async () => {
        const now = 6;
        assert.strictEqual(await tryStore(['deltaTime', 'latitude', 'longitude', 'altitude'], [
          [now - 3, 1, 2, 3],
          [now - 2, 2, 3, 4],
          [now - 1, 3, 4, 5]
        ]), true);
        assert.strictEqual(await tryStore(['deltaTime', 'latitude', 'longitude', 'altitude', 'speed'], [
          [now - 3, 1, 2, 3, 160],
          [now - 2, 2, 3, 4, 170],
          [now - 1, 3, 4, 5, 180]
        ]), true);
      });
      it('[JDTH] refuses unknown fields', async () => {
        const now = 6;
        assert.strictEqual(await tryStore(['deltaTime', 'latitude', 'longitude', 'depth'], [
          [now - 3, 1, 2, 3],
          [now - 2, 2, 3, 4],
          [now - 1, 3, 4, 5]
        ]), false);
      });
    });
    describe('[SD42] using a "create-only" permissions', () => {
      before(async () => {
        server = await spawnContext.spawn();
      });
      after(() => {
        server.stop();
      });
      after(function () {
        pryv.clean();
      });
      let userId, streamId, createOnlyToken, event;
      before(async () => {
        userId = cuid();
        streamId = cuid();
        createOnlyToken = cuid();
        logger.debug('build fixture');
        const user = await pryv.user(userId, {});
        user.access({
          token: createOnlyToken,
          type: 'app',
          permissions: [
            {
              streamId,
              level: 'create-only'
            }
          ]
        });
        const stream = await user.stream({ id: streamId }, function () { });
        event = await stream.event({
          type: 'series:mass/kg'
        });
        event = event.attrs;
      });
      it('[YCGZ] should work', async () => {
        const res = await server
          .request()
          .post(`/${userId}/events/${event.id}/series`)
          .set('authorization', createOnlyToken)
          .send({
            format: 'flatJSON',
            fields: ['deltaTime', 'value'],
            points: [
              [1, 1],
              [2, 2]
            ]
          });
        assert.strictEqual(res.status, 200);
      });
    });
  });
});

/** @typedef {Array<string>} Header */

/** @typedef {Array<Row>} Rows */

/** @typedef {Array<DataPoint>} Row */

/** @typedef {string | number | boolean} DataPoint */

/**
 * @typedef {{
 *   ok: boolean;
 *   user: {
 *     id: string;
 *   };
 *   event: {
 *     id: string;
 *   };
 *   status: number;
 *   body: any;
 * }} TryOpResult
 */

/**
 * @typedef {{
 *   status: number;
 *   id: string;
 *   message: string;
 * }} ErrorDocument
 */
