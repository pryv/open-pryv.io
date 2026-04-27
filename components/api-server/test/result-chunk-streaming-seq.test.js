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
      let finished = false;
      // The test's intent is "chunks arrive incrementally", not "within X ms" —
      // 5s is permissive enough for either engine on a busy runner. Pre-2026-04
      // mongo used a 500 ms bound which made the test flaky on slower disks.
      const timeout = 5000;
      res.on('data', function (chunk) {
        if (finished) return;
        if (Date.now() - lastChunkRecievedAt > timeout) {
          finished = true;
          return done(new Error(`It took more than ${timeout}ms between chunks`));
        }
        lastChunkRecievedAt = Date.now();
        chunkCount++;
        jsonString += chunk;
      });
      res.on('end', () => {
        if (finished) return;
        finished = true;
        assert.strictEqual(JSON.parse(jsonString).events.length, N_ITEMS);
        assert.ok(chunkCount >= 3, 'Should receive at least 3 chunks');
        done();
      });
      res.on('error', function (error) {
        if (finished) return;
        finished = true;
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
        let finished = false;
        const timeout = 5000;
        res.on('data', function (chunk) {
          if (finished) return;
          if (Date.now() - lastChunkRecievedAt > timeout) {
            finished = true;
            return callback(new Error(`It took more than ${timeout}ms between chunks`));
          }
          lastChunkRecievedAt = Date.now();
          chunkCount++;
          jsonString += chunk;
        });
        res.on('end', () => {
          if (finished) return;
          finished = true;
          lastChunkRecievedAt = -1;
          assert.strictEqual(JSON.parse(jsonString).updatedEvents.length, N_ITEMS);
          assert.ok(chunkCount >= 3, 'Should receive at least 3 chunks');
          callback();
        });
        res.on('error', function (error) {
          if (finished) return;
          finished = true;
          callback(error);
        });
      }).end();
    })();
  });
});
