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

/* global cache, describe, before, after, it, assert, cuid, config, initTests, initCore, coreRequest, getNewFixture, charlatan */

const STREAMS = {
  A: {},
  A1: { parentId: 'A' },
  A2: { parentId: 'A' },
  B: {},
  B1: { parentId: 'B' },
  B2: { parentId: 'B' },
  T: { }
};

describe('Cache', function () {
  let user, username, password, access, appAccess;
  let personalToken;
  let mongoFixtures;
  let accessesPath, eventsPath, streamsPath;

  const streamId = 'yo';
  before(async function () {
    await initTests();
    await initCore();
    password = cuid();
    mongoFixtures = getNewFixture();
    user = await mongoFixtures.user(charlatan.Lorem.characters(7), {
      password
    });

    username = user.attrs.username;

    for (const [streamId, streamData] of Object.entries(STREAMS)) {
      const stream = {
        id: streamId,
        name: 'stream ' + streamId,
        parentId: streamData.parentId
      };
      await user.stream(stream);
    }

    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    personalToken = access.attrs.token;
    await user.session(personalToken);
    user = user.attrs;
    accessesPath = '/' + username + '/accesses/';
    eventsPath = '/' + username + '/events/';
    streamsPath = '/' + username + '/streams/';

    const res = await coreRequest.post(accessesPath)
      .set('Authorization', personalToken)
      .send({ type: 'app', name: 'app access', token: 'app-token', permissions: [{ streamId: 'A', level: 'manage' }] });
    appAccess = res.body.access;
    assert.exists(appAccess);
  });

  after(async function () {
    await mongoFixtures.clean();
  });

  function validGet (path) { return coreRequest.get(path).set('Authorization', appAccess.token); }
  function validPost (path) { return coreRequest.post(path).set('Authorization', appAccess.token); }

  before(async () => {
    await validGet(eventsPath);
    await validPost(eventsPath)
      .send({ streamIds: [streamId], type: 'count/generic', content: 2 });
    await validGet(eventsPath);
    await validGet(eventsPath)
      .query({ streams: ['other'] });
  });

  this.beforeEach(() => {
    // make sure config is clean;
    config.injectTestConfig({});
    cache.clear(); // clear & reload configuration
  });

  it('[FELT] Second get stream must be faster that first one', async () => {
    function isEmpty () {
      assert.notExists(cache.getStreams(username, 'local'));
      assert.notExists(cache.getAccessLogicForToken(username, appAccess.token));
      assert.notExists(cache.getAccessLogicForId(username, appAccess.id));
      assert.notExists(cache.getUserId(username));
    }

    function isFull () {
      assert.exists(cache.getStreams(username, 'local'));
      assert.exists(cache.getAccessLogicForToken(username, appAccess.token));
      assert.exists(cache.getAccessLogicForId(username, appAccess.id));
      assert.exists(cache.getUserId(username));
    }

    // loop 3 times and calculate average time
    let tFirstCallWithCache = 0;
    let tSecondCallWithCache = 0;
    const loop = 3;
    for (let i = 0; i < loop; i++) {
      cache.clear(); // reset cache fully
      isEmpty();
      const st1 = hrtime();
      const res1 = await coreRequest.get(streamsPath).set('Authorization', appAccess.token).query({});
      tFirstCallWithCache += hrtime(st1) / loop;
      assert.equal(res1.status, 200);

      isFull();
      const st2 = hrtime();
      const res2 = await coreRequest.get(streamsPath).set('Authorization', appAccess.token).query({});
      tSecondCallWithCache += hrtime(st2) / loop;
      assert.equal(res2.status, 200);
    }
    config.injectTestConfig({ caching: { isActive: false } }); // deactivate cache
    cache.clear(); // reset cache fully

    let tNoCache = 0; // no-cache at all
    for (let i = 0; i < loop; i++) {
      const st3 = hrtime();
      const res3 = await coreRequest.get(streamsPath).set('Authorization', appAccess.token).query({});
      tNoCache += hrtime(st3) / loop;
      assert.equal(res3.status, 200);
      isEmpty();
    }

    const data = `first-with-cache: ${tFirstCallWithCache}, second-with-cache: ${tSecondCallWithCache}, no-cache: ${tNoCache}  => `;
    assert.isBelow(tSecondCallWithCache, tFirstCallWithCache, 'second-with-cache streams.get should be faster than first-with-cache' + data);
    if (process.env.IS_CI === 'true') return; // for some reason cache does not bring significant benefits during CI.
    const expectedGainPercent = 15;
    const percentGained = Math.round((tNoCache - tSecondCallWithCache) * 100 / tNoCache);
    assert.isAbove(percentGained, expectedGainPercent, `cache streams.get should be at least ${expectedGainPercent}% longer than second-with-cache ${data}`);
  });

  it('[XDP6] Cache should reset permissions on stream structure change when moving a stream in and out ', async () => {
    const res1 = await coreRequest.get(eventsPath).set('Authorization', appAccess.token).query({ streams: ['T'] });
    assert.equal(res1.status, 403, 'should fail accessing forbiddden stream');

    // move stream T as child of A
    const res2 = await coreRequest.put(streamsPath + 'T').set('Authorization', personalToken).send({ parentId: 'A' });
    assert.equal(res2.status, 200);

    const res3 = await coreRequest.get(eventsPath).set('Authorization', appAccess.token).query({ streams: ['T'] });
    assert.equal(res3.status, 200, 'should have access to stream once moved into authorized scope');

    // move stream T out of A
    const res4 = await coreRequest.put(streamsPath + 'T').set('Authorization', personalToken).send({ parentId: null });
    assert.equal(res4.status, 200);

    const res5 = await coreRequest.get(eventsPath).set('Authorization', appAccess.token).query({ streams: ['T'] });
    assert.equal(res5.status, 403, 'should not have acces once move out of authorized scope');
  });
});

function hrtime (hrTime) {
  const time = process.hrtime(hrTime);
  if (hrTime == null) return time;
  return time[0] * 1000000000 + time[1];
}
