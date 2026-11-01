/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Tests that exercise auth checks that have been disabled in other tests.

require('test-helpers/src/api-server-tests-config.ts');
const assert = require('node:assert');
const storage = require('storage');
const { databaseFixture } = require('test-helpers');
const { MetadataLoader, MetadataCache } = require('../../src/metadata_cache.ts');
const { getConfig, getLogger } = require('@pryv/boiler');
const { getMall } = require('mall');
const { pubsub } = require('messages');

describe('[METL] Metadata Loader', function () {
  let storageLayer, pryv, mall;
  before(async function () {
    await require('business/src/system-streams/index.ts').init();
    storageLayer = await storage.getStorageLayer();
    pryv = databaseFixture(storageLayer);
    mall = await getMall();
    // Clean stale data from previous runs
    await pryv.context.cleanEverything();
  });

  let loader;
  beforeEach(async () => {
    loader = new MetadataLoader();
    await loader.init(mall, getLogger('metadata-test'));
  });
  const USER_NAME = 'foo';
  const EVENT_ID = 'c1';
  const ACCESS_TOKEN = 'a1';
  afterEach(async function () {
    await pryv.clean();
  });
  // Build the database fixture
  beforeEach(async () => {
    const user = await pryv.user(USER_NAME, {}, function (user) {});
    const stream = await user.stream({ id: 'something' }, function (stream) {});
    await stream.event({ id: EVENT_ID });
    await user.session(ACCESS_TOKEN);
    await user.access({ token: ACCESS_TOKEN, type: 'personal' });
  });

  it('[U6F2] should allow write access to series', function () {
    const metadata = loader.forSeries(USER_NAME, EVENT_ID, ACCESS_TOKEN);
    return metadata.then((metadata) => {
      assert.strictEqual(metadata.canWrite(), true);
    });
  });

  it('[U6F3] an aliased token reaches a series at its alias only; at the username it is an unknown token', async () => {
    const { getUsersRepository } = require('business/src/users/index.ts');
    const { fromCallback } = require('utils');
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(USER_NAME);
    const alias = await usersRepository.mintAlias(USER_NAME, userId);
    try {
      await fromCallback((cb) => storageLayer.accesses.insertOne({ id: userId, username: USER_NAME }, {
        type: 'app',
        name: 'hf-aliased',
        deviceName: 'u6f3',
        token: 'a-aliased',
        alias,
        permissions: [{ streamId: 'something', level: 'contribute' }],
      }, cb));
      const atAlias = await loader.forSeries(alias, EVENT_ID, 'a-aliased');
      assert.strictEqual(atAlias.canWrite(), true);
      const refused = async (name, token) => {
        try {
          await loader.forSeries(name, EVENT_ID, token);
        } catch (err) {
          return { id: err.id, message: err.message };
        }
        return null;
      };
      const atName = await refused(USER_NAME, 'a-aliased');
      assert.deepStrictEqual(atName, { id: 'invalid-access-token', message: 'Cannot find access from token.' });
      assert.deepStrictEqual(atName, await refused(USER_NAME, 'no-such-token'));
    } finally {
      await usersRepository.releaseAlias(alias, userId);
    }
  });
});
describe('[METC] Metadata Cache', function () {
  let config;
  before(async function () {
    config = await getConfig();
  });
  it('[O8AE] returns loaded metadata for N minutes', async () => {
    let n = 0;
    const loaderStub = {
      forSeries: function () {
        n += 1;

        // Use this as a value for now, it serves verification only
        return Promise.resolve(n);
      }
    };

    // stubbing the value of loader here.
    const listenersBefore = pubsub.series.listenerCount(pubsub.SERIES_UPDATE_EVENTID_USERNAME);
    const cache = new MetadataCache(null, loaderStub, config);
    try {
      await cache.init();

      const a = await cache.forSeries('foo', '1234', '5678');
      const b = await cache.forSeries('foo', '1234', '5678');

      assert.strictEqual(a, 1);
      assert.strictEqual(b, 1);
    } finally {
      // Its `series` is null: left subscribed, a series deletion would throw here.
      cache.close();
    }
    assert.strictEqual(pubsub.series.listenerCount(pubsub.SERIES_UPDATE_EVENTID_USERNAME), listenersBefore);
  });
});
