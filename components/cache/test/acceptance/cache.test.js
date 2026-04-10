/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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

describe('[CACH] Cache', function () {
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
    assert.ok(appAccess);
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
      assert.ok(cache.getStreams(username, 'local') == null);
      assert.ok(cache.getAccessLogicForToken(username, appAccess.token) == null);
      assert.ok(cache.getAccessLogicForId(username, appAccess.id) == null);
      assert.ok(cache.getUserId(username) == null);
    }

    function isFull () {
      assert.ok(cache.getStreams(username, 'local'));
      assert.ok(cache.getAccessLogicForToken(username, appAccess.token));
      assert.ok(cache.getAccessLogicForId(username, appAccess.id));
      assert.ok(cache.getUserId(username));
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
      assert.strictEqual(res1.status, 200);

      isFull();
      const st2 = hrtime();
      const res2 = await coreRequest.get(streamsPath).set('Authorization', appAccess.token).query({});
      tSecondCallWithCache += hrtime(st2) / loop;
      assert.strictEqual(res2.status, 200);
    }
    config.injectTestConfig({ caching: { isActive: false } }); // deactivate cache
    cache.clear(); // reset cache fully

    let tNoCache = 0; // no-cache at all
    for (let i = 0; i < loop; i++) {
      const st3 = hrtime();
      const res3 = await coreRequest.get(streamsPath).set('Authorization', appAccess.token).query({});
      tNoCache += hrtime(st3) / loop;
      assert.strictEqual(res3.status, 200);
      isEmpty();
    }

    const data = `first-with-cache: ${tFirstCallWithCache}, second-with-cache: ${tSecondCallWithCache}, no-cache: ${tNoCache}  => `;
    assert.ok(tSecondCallWithCache < tFirstCallWithCache, 'second-with-cache streams.get should be faster than first-with-cache' + data);
    if (process.env.IS_CI === 'true') return; // for some reason cache does not bring significant benefits during CI.
    const expectedGainPercent = 15;
    const percentGained = Math.round((tNoCache - tSecondCallWithCache) * 100 / tNoCache);
    assert.ok(percentGained > expectedGainPercent, `cache streams.get should be at least ${expectedGainPercent}% longer than second-with-cache ${data}`);
  });

  it('[XDP6] Cache should reset permissions on stream structure change when moving a stream in and out ', async () => {
    const res1 = await coreRequest.get(eventsPath).set('Authorization', appAccess.token).query({ streams: ['T'] });
    assert.strictEqual(res1.status, 403, 'should fail accessing forbiddden stream');

    // move stream T as child of A
    const res2 = await coreRequest.put(streamsPath + 'T').set('Authorization', personalToken).send({ parentId: 'A' });
    assert.strictEqual(res2.status, 200);

    const res3 = await coreRequest.get(eventsPath).set('Authorization', appAccess.token).query({ streams: ['T'] });
    assert.strictEqual(res3.status, 200, 'should have access to stream once moved into authorized scope');

    // move stream T out of A
    const res4 = await coreRequest.put(streamsPath + 'T').set('Authorization', personalToken).send({ parentId: null });
    assert.strictEqual(res4.status, 200);

    const res5 = await coreRequest.get(eventsPath).set('Authorization', appAccess.token).query({ streams: ['T'] });
    assert.strictEqual(res5.status, 403, 'should not have acces once move out of authorized scope');
  });
});

function hrtime (hrTime) {
  const time = process.hrtime(hrTime);
  if (hrTime == null) return time;
  return time[0] * 1000000000 + time[1];
}
