/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const cuid = require('cuid');
const assert = require('node:assert');

const { produceStorageConnection, context } = require('./test-helpers');
const { databaseFixture } = require('test-helpers');
const http = require('http');
const superagent = require('superagent');
const { promisify } = require('util');

const N_ITEMS = 2000;
const STORAGE_ENGINE = process.env.STORAGE_ENGINE;
describe('[EVST] events streaming with ' + N_ITEMS + ' entries', function () {
  this.timeout(60 * 2 * 1000);

  let fixtures;
  before(async function () {
    fixtures = databaseFixture(await produceStorageConnection());
  });

  let apiServer;
  before(async function () {
    apiServer = await context.spawn();
  });

  let user, username, streamId, appAccessToken;
  before(async function () {
    username = 'test-stream-' + cuid.slug();
    streamId = 'test';
    appAccessToken = cuid();
    user = await fixtures.user(username, {});
    await user.stream({
      id: streamId
    });
    await user.access({
      type: 'app',
      token: appAccessToken,
      permissions: [{
        streamId: '*',
        level: 'manage'
      }]
    });
    // load lots of events
    for (let i = 0; i < N_ITEMS; i++) {
      await user.event({
        streamIds: [streamId],
        type: 'count/step',
        content: 1
      });
    }
  });

  after(async function () {
    if (fixtures) await fixtures.clean();
    await apiServer.stop();
  });

  it('[SE1K] Streams events', function (done) {
    const options = {
      host: apiServer.host,
      port: apiServer.port,
      path: '/' + username + '/events?limit=' + N_ITEMS + '&auth=' + appAccessToken,
      method: 'GET'
    };

    let lastChunkRecievedAt = Date.now();
    http.request(options, function (res) {
      assert.strictEqual(res.headers['content-type'], 'application/json');
      assert.strictEqual(res.headers['transfer-encoding'], 'chunked');
      res.setEncoding('utf8');
      let jsonString = '';
      let chunkCount = 0;
      const timeout = STORAGE_ENGINE === 'postgresql' ? 5000 : 500;
      res.on('data', function (chunk) {
        if (Date.now() - lastChunkRecievedAt > timeout) throw new Error(`It took more that ${timeout}ms between chunks`);
        lastChunkRecievedAt = Date.now();
        chunkCount++;
        jsonString += chunk;
      });
      res.on('end', () => {
        assert.strictEqual(JSON.parse(jsonString).events.length, N_ITEMS);
        assert.ok(chunkCount >= 3, 'Should receive at least 3 chunks');
        done();
      });
      res.on('error', function (error) {
        done(error);
      });
    }).end();
  });

  it('[XZGB] Streams deleted in sent as chunked', async function () {
    const options = {
      host: apiServer.host,
      port: apiServer.port,
      path: '/' + username + '/streams/' + streamId + '?mergeEventsWithParent=false&auth=' + appAccessToken,
      method: 'DELETE'
    };

    const resultTrash = await superagent.delete(`http://${options.host}:${options.port}${options.path}`);
    assert.strictEqual(resultTrash.body?.stream?.trashed, true);

    let lastChunkRecievedAt = Date.now();

    await promisify(function (callback) {
      http.request(options, function (res) {
        assert.strictEqual(res.headers['content-type'], 'application/json');
        assert.strictEqual(res.headers['transfer-encoding'], 'chunked');
        res.setEncoding('utf8');
        let jsonString = '';
        let chunkCount = 0;
        const timeout = STORAGE_ENGINE === 'postgresql' ? 5000 : 500;
        res.on('data', function (chunk) {
          if (Date.now() - lastChunkRecievedAt > timeout) throw new Error(`It took more that ${timeout}ms between chunks`);
          lastChunkRecievedAt = Date.now();
          chunkCount++;
          jsonString += chunk;
        });
        res.on('end', () => {
          lastChunkRecievedAt = -1;
          assert.strictEqual(JSON.parse(jsonString).updatedEvents.length, N_ITEMS);
          assert.ok(chunkCount >= 3, 'Should receive at least 3 chunks');
          callback();
        });
        res.on('error', function (error) {
          callback(error);
        });
      }).end();
    })();
  });
});
