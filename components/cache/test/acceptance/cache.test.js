/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global cache, describe, before, after, it, assert, cuid, config, initTests, initCore, coreRequest, getNewFixture, charlatan, withInjectedConfig */

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
  let fixtures;
  let accessesPath, eventsPath, streamsPath;

  const streamId = 'yo';
  before(async function () {
    // Starting the core and filling the fixture can outlast mocha's default
    // 2 s in a loaded full-matrix run.
    this.timeout(20000);
    await initTests();
    await initCore();
    password = cuid();
    fixtures = getNewFixture();
    user = await fixtures.user(charlatan.Lorem.characters(7), {
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
      .send({ type: 'app', name: 'app access', token: 'app-access-token', permissions: [{ streamId: 'A', level: 'manage' }] });
    appAccess = res.body.access;
    assert.ok(appAccess);
  });

  after(async function () {
    await fixtures.clean();
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

  it('[FELT] A second streams.get is served from the cache: no stream storage read', async function () {
    // Deterministic, on both engines: the stream storage reads are counted
    // (a timing comparison only held on PostgreSQL, and not on loaded hosts).
    const streamsStorage = (await require('storage').getStorageLayer()).streams;
    const find = streamsStorage.find;
    let reads = 0;
    streamsStorage.find = function (...args) {
      reads++;
      return find.apply(this, args);
    };
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

    try {
      cache.clear(); // reset cache fully
      isEmpty();
      reads = 0;
      const res1 = await coreRequest.get(streamsPath).set('Authorization', appAccess.token).query({});
      assert.strictEqual(res1.status, 200);
      assert.ok(reads > 0, 'a miss reads the stream storage');

      isFull();
      reads = 0;
      const res2 = await coreRequest.get(streamsPath).set('Authorization', appAccess.token).query({});
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(reads, 0, 'a hit reads nothing from the stream storage');
      assert.deepStrictEqual(res2.body.streams, res1.body.streams);

      await withInjectedConfig({ caching: { isActive: false } }, async () => {
        cache.clear(); // reset cache fully
        for (let i = 0; i < 2; i++) {
          reads = 0;
          const res3 = await coreRequest.get(streamsPath).set('Authorization', appAccess.token).query({});
          assert.strictEqual(res3.status, 200);
          assert.ok(reads > 0, 'without the cache every call reads the stream storage');
          isEmpty();
        }
      });
    } finally {
      streamsStorage.find = find;
    }
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

  it('[CDLB] Recording the deletion of a live stream drops it from the cached tree', async () => {
    const { getMall } = require('mall');
    const mall = await getMall();
    const id = 'cdlb-' + cuid();
    await mall.streams.create(user.id, { id, name: id });
    const res1 = await coreRequest.get(streamsPath).set('Authorization', personalToken);
    assert.strictEqual(res1.status, 200);
    assert.ok(res1.body.streams.some((s) => s.id === id), 'the new stream is listed');
    assert.ok(cache.getStreams(user.id, 'local'), 'the tree is cached');

    await mall.streams.create(user.id, { id, deleted: Date.now() / 1000 });

    const res2 = await coreRequest.get(streamsPath).set('Authorization', personalToken);
    assert.strictEqual(res2.status, 200);
    assert.ok(!res2.body.streams.some((s) => s.id === id), 'the deleted stream is no longer listed');
  });
});
