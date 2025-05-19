/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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

const cuid = require('cuid');
const assert = require('chai').assert;

const { produceMongoConnection, context } = require('./test-helpers');
const { databaseFixture } = require('test-helpers');
const { getConfig } = require('@pryv/boiler');

const http = require('http');
const superagent = require('superagent');
const { promisify } = require('util');

const N_ITEMS = 2000;
describe('events streaming with ' + N_ITEMS + ' entries', function () {
  this.timeout(60 * 2 * 1000);

  let mongoFixtures;
  let isFerret;
  before(async function () {
    mongoFixtures = databaseFixture(await produceMongoConnection());
    const config = await getConfig();
    isFerret = config.get('database:isFerret');
  });

  let apiServer;
  before(async function () {
    apiServer = await context.spawn();
  });

  let user, username, streamId, appAccessToken;
  before(async function () {
    username = 'test-stream';
    streamId = 'test';
    appAccessToken = cuid();
    user = await mongoFixtures.user(username, {});
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
      assert.equal(res.headers['content-type'], 'application/json');
      assert.equal(res.headers['transfer-encoding'], 'chunked');
      res.setEncoding('utf8');
      let jsonString = '';
      let chunkCount = 0;
      const timeout = isFerret ? 10000 : 500; // Ferret is Slower
      res.on('data', function (chunk) {
        if (Date.now() - lastChunkRecievedAt > timeout) throw new Error(`It took more that ${timeout}ms between chunks`);
        lastChunkRecievedAt = Date.now();
        chunkCount++;
        jsonString += chunk;
      });
      res.on('end', () => {
        assert.equal(JSON.parse(jsonString).events.length, N_ITEMS);
        assert.isAtLeast(chunkCount, 3, 'Should receive at least 3 chunks');
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
    assert.isTrue(resultTrash.body?.stream?.trashed);

    let lastChunkRecievedAt = Date.now();

    await promisify(function (callback) {
      http.request(options, function (res) {
        assert.equal(res.headers['content-type'], 'application/json');
        assert.equal(res.headers['transfer-encoding'], 'chunked');
        res.setEncoding('utf8');
        let jsonString = '';
        let chunkCount = 0;
        const timeout = isFerret ? 10000 : 500; // Ferret is Slower
        res.on('data', function (chunk) {
          if (Date.now() - lastChunkRecievedAt > timeout) throw new Error(`It took more that ${timeout}ms between chunks`);
          lastChunkRecievedAt = Date.now();
          chunkCount++;
          jsonString += chunk;
        });
        res.on('end', () => {
          lastChunkRecievedAt = -1;
          assert.equal(JSON.parse(jsonString).updatedEvents.length, N_ITEMS);
          assert.isAtLeast(chunkCount, 3, 'Should receive at least 3 chunks');
          callback();
        });
        res.on('error', function (error) {
          callback(error);
        });
      }).end();
    })();
  });
});
