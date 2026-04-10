/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const cuid = require('cuid');
const { spawnContext, produceStorageConnection, produceSeriesConnection, getTimeDelta } = require('./test-helpers');
const { databaseFixture } = require('test-helpers');

describe('[HFBT] Storing BATCH data in a HF series', function () {
  let database;
  let seriesConn;
  before(async function () {
    database = await produceStorageConnection();
    seriesConn = await produceSeriesConnection();
  });
  describe('[HB01] Use Case: Store data in InfluxDB, Verification on either half', function () {
    let server;
    before(async () => {
      server = await spawnContext.spawn();
    });
    after(() => {
      server.stop();
    });
    let pryv;
    before(function () {
      pryv = databaseFixture(database);
    });
    after(function () {
      pryv.clean();
    });
    // Set up a basic object structure so that we can test. Ids will change with
    // every test run.
    //
    // User(userId)
    //  `- Stream(parentStreamId)
    //  |   `- event(eventId, type='series:mass/kg')
    //  |- Access(accessToken)
    //  `- Session(accessToken)
    //
    let userId, parentStreamId, eventId, accessToken;
    before(() => {
      userId = cuid();
      parentStreamId = cuid();
      eventId = cuid();
      accessToken = cuid();
      return pryv.user(userId, {}, function (user) {
        user.stream({ id: parentStreamId }, function (stream) {
          stream.event({
            id: eventId,
            type: 'series:mass/kg'
          });
        });
        user.access({ token: accessToken, type: 'personal' });
        user.session(accessToken);
      });
    });
    function storeData (data) {
      const request = server.request();
      return request
        .post(`/${userId}/series/batch`)
        .set('authorization', accessToken)
        .send(data)
        .expect(200);
    }
    it('[Q2IS] should store data correctly', async () => {
      const data = {
        format: 'seriesBatch',
        data: [
          {
            eventId,
            data: {
              format: 'flatJSON',
              fields: ['deltaTime', 'value'],
              points: [
                [0, 10.2],
                [1, 12.2],
                [2, 14.2]
              ]
            }
          }
        ]
      };
      const response = await storeData(data);
      const body = response.body;
      if (body == null || body.status == null) { throw new Error(); }
      assert.strictEqual(body.status, 'ok');
      const headers = response.headers;
      assert.match(headers['api-version'], /^\d+\.\d+\.\d+/);
      // Check if the data is really there
      const userName = userId; // identical with id here, but will be user name in general.
      const options = { database: `user.${userName}` };
      const query = `
        SELECT * FROM "event.${eventId}"
      `;
      const result = await seriesConn.query(query, options);
      assert.strictEqual(result.length, 3);
      const expectedValues = [
        [0, 10.2],
        [1, 12.2],
        [2, 14.2]
      ];
      for (const row of result) {
        if (row.time == null || row.value == null) { throw new Error('Should have time and value.'); }
        const [expTimeDelta, expValue] = expectedValues.shift();
        assert.strictEqual(getTimeDelta(row.time), expTimeDelta);
        assert.strictEqual(row.value, expValue);
      }
    });
  });
  describe('[HB02] POST /:user_name/series/batch', () => {
    let server;
    before(async () => {
      server = await spawnContext.spawn();
    });
    after(() => {
      server.stop();
    });
    let pryv;
    before(function () {
      pryv = databaseFixture(database);
    });
    after(function () {
      pryv.clean();
    });
    // Set up a basic object structure so that we can test. Ids will change with
    // every test run.
    //
    // User(userId)
    //  `- Stream(parentStreamId)
    //  |   `- event(eventId, type='series:mass/kg')
    //  |- Access(accessToken)
    //  `- Session(accessToken)
    //
    let userId, parentStreamId, eventId1, eventId2, accessToken, data1, data2;
    before(() => {
      userId = cuid();
      parentStreamId = cuid();
      eventId1 = cuid();
      eventId2 = cuid();
      accessToken = cuid();
      const points = [
        [0, 10.2],
        [1, 12.2],
        [2, 14.2]
      ];
      data1 = {
        eventId: eventId1,
        data: {
          format: 'flatJSON',
          fields: ['deltaTime', 'value'],
          points
        }
      };
      data2 = {
        eventId: eventId2,
        data: {
          format: 'flatJSON',
          fields: ['deltaTime', 'value'],
          points
        }
      };
      return pryv.user(userId, {}, function (user) {
        user.stream({ id: parentStreamId }, function (stream) {
          stream.event({
            id: eventId1,
            type: 'series:mass/kg'
          });
          stream.event({
            id: eventId2,
            type: 'series:mass/kg'
          });
        });
        user.access({ token: accessToken, type: 'personal' });
        user.session(accessToken);
      });
    });
    // Fixes #212
    it('[A3BQ] should return core-metadata in every call', async () => {
      const data = {
        format: 'seriesBatch',
        data: [data1]
      };
      const res = await server
        .request()
        .post(`/${userId}/series/batch`)
        .set('authorization', accessToken)
        .send(data);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.meta !== undefined);
    });
    it("[QHM5] should fail without 'Authorization' header", async () => {
      const data = {
        format: 'seriesBatch',
        data: [data1]
      };
      const response = await server
        .request()
        .post(`/${userId}/series/batch`)
        .send(data);
      assert.strictEqual(response.statusCode, 400);
      const body = response.body;
      assert.strictEqual(body.error.id, 'missing-header');
    });
    describe('[HB03] when the token has no permissions on the event', () => {
      let server;
      before(async () => {
        server = await spawnContext.spawn();
        await server.process.sendToChild('mockAuthentication', false);
      });
      after(() => {
        server.stop();
      });
      it('[R57L] fails', async () => {
        const response = await storeData(server.request(), {
          format: 'seriesBatch',
          data: [data1]
        });
        assert.strictEqual(response.statusCode, 403);
      });
    });
    describe('[HB04] when the token has a "create-only" permission', () => {
      let server;
      before(async () => {
        server = await spawnContext.spawn();
      });
      after(() => {
        server.stop();
      });
      let pryv;
      before(function () {
        pryv = databaseFixture(database);
      });
      after(function () {
        pryv.clean();
      });
      let userId, streamId, createOnlyToken, event;
      before(async () => {
        userId = cuid();
        streamId = cuid();
        createOnlyToken = cuid();
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
      it('[ATAH] should work', async () => {
        const res = await server
          .request()
          .post(`/${userId}/series/batch`)
          .set('authorization', createOnlyToken)
          .send({
            format: 'seriesBatch',
            data: [
              {
                eventId: event.id,
                data: {
                  format: 'flatJSON',
                  fields: ['deltaTime', 'value'],
                  points: [
                    [1, 1],
                    [2, 2]
                  ]
                }
              }
            ]
          });
        assert.equal(res.status, 200);
      });
    });
    describe('[HB05] when using a metadata updater stub', () => {
      beforeEach(async () => {
        await server.process.sendToChild('mockMetadataUpdater');
      });
      afterEach(async () => {
        server.stop();
        server = await spawnContext.spawn();
      });
      it('[OO01] should schedule a metadata update on every store', async () => {
        const data = {
          format: 'seriesBatch',
          data: [data1, data2]
        };
        await storeData(server.request(), data)
          .expect(200);
        const calls = await server.process.sendToChild('getMetadataUpdaterCalls');
        assert.strictEqual(calls.length >= 1, true);
        assert.strictEqual(calls[0].entries.length, 2);
      });
    });
    function storeData (request, data) {
      return request
        .post(`/${userId}/series/batch`)
        .set('authorization', accessToken)
        .send(data);
    }
  });
});

/** @typedef {string | number} DataValue */

/** @typedef {Array<DataValue>} Row */

/**
 * @typedef {{
 *   format: 'flatJSON';
 *   fields: Array<string>;
 *   points: Array<Row>;
 * }} FlatJSONData
 */

/**
 * @typedef {{
 *   eventId: string;
 *   data: FlatJSONData;
 * }} SeriesEnvelope
 */

/**
 * @typedef {{
 *   format: 'seriesBatch';
 *   data: Array<SeriesEnvelope>;
 * }} SeriesBatchEnvelope
 */
