/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [LGLU] a completed login records activity on the personal access.
 *
 * The usage tracker runs `auth.login` under a synthetic access id and so
 * never updates the personal access it issues: a login alone used to leave
 * `lastUsed` untouched until the next call made with the token.
 */

const timestamp = require('unix-timestamp');
const { getStorageLayer } = require('storage');
const { getLastActivity } = require('business/src/accesses/accountActivity.ts');
const { withInjectedConfig } = require('test-helpers');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[LGLU] login records lastUsed', function () {
  this.timeout(20000);

  const PASSWORD = 'lglu-password-123';
  const APP_ID = 'pryv-test-no-cors'; // trusted for any origin in test-config

  let storageLayer;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await getStorageLayer();
  });

  async function freshUser () {
    const username = ('lglu' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await getNewFixture().user(username, { password: PASSWORD });
    return { username, user: { id: fu.attrs.id, username } };
  }

  async function login (username) {
    const res = await coreRequest
      .post('/' + username + '/auth/login')
      .send({ username, password: PASSWORD, appId: APP_ID });
    assert.equal(res.status, 200, 'login: ' + JSON.stringify(res.body));
    return res.body.token;
  }

  function personalAccess (user) {
    return new Promise((resolve, reject) => {
      storageLayer.accesses.findOne(user, { name: APP_ID, type: 'personal' }, null, (err, access) => (err ? reject(err) : resolve(access)));
    });
  }

  it('[LGLU1] a first login creates the personal access with lastUsed set', async function () {
    const { username, user } = await freshUser();
    const before = timestamp.now();
    await login(username);
    const access = await personalAccess(user);
    assert.ok(access != null, 'personal access created');
    assert.equal(typeof access.lastUsed, 'number');
    assert.ok(access.lastUsed >= before - 1 && access.lastUsed <= timestamp.now() + 1, 'lastUsed is the login time');
  });

  it('[LGLU2] a later login moves lastUsed forward on the existing access', async function () {
    const { username, user } = await freshUser();
    await login(username);
    const first = await personalAccess(user);
    // move the stored value into the past so the second login must rewrite it
    await new Promise((resolve, reject) => storageLayer.accesses.updateOne(user, { id: first.id }, { lastUsed: first.lastUsed - 3600 }, (err) => (err ? reject(err) : resolve())));
    await login(username);
    const second = await personalAccess(user);
    assert.equal(second.id, first.id, 'same access');
    assert.ok(second.lastUsed >= first.lastUsed - 1, 'lastUsed refreshed by the login');
  });

  it('[LGLU3] the login counts as account activity', async function () {
    const { username, user } = await freshUser();
    assert.equal(await getLastActivity(storageLayer.accesses, user), null, 'no activity before any login');
    const before = timestamp.now();
    await login(username);
    const activity = await getLastActivity(storageLayer.accesses, user);
    assert.ok(activity != null && activity >= before - 1, 'activity recorded by the login');
  });

  it('[LGLU4] with access tracking off, a login records no lastUsed', async function () {
    const { username, user } = await freshUser();
    await withInjectedConfig({ accessTracking: { isActive: false } }, async () => {
      await login(username);
    });
    const access = await personalAccess(user);
    assert.ok(access != null, 'personal access created');
    assert.ok(access.lastUsed == null, 'lastUsed not set: ' + access.lastUsed);
  });
});
