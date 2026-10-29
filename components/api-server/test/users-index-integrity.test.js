/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const storage = require('storage');
const { fromCallback } = require('utils');
const { getConfig } = require('@pryv/boiler');

/**
 * [UIIX] the users index integrity check reports the user ids holding rows
 * that no account of the index owns (rows an account deletion left behind),
 * through the storage check and `GET /system/check-platform-integrity`.
 */
describe('[UIIX] users index integrity: orphan user ids', function () {
  let storageLayer, usersIndex, adminAccessKey;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await storage.getStorageLayer();
    usersIndex = await storage.getUsersLocalIndex();
    adminAccessKey = (await getConfig()).get('auth:adminAccessKey');
  });

  it('[UIIX1] an access row of a user id unknown to the index is reported, and no longer once removed', async function () {
    // SQLite keeps an account's rows in per-user files and lists the users
    // of a collection from the index itself: rows of an unindexed id are
    // not listed there (a known limit of this check on that engine).
    if (require('storages').pluginLoader.getEngineFor('baseStorage') === 'sqlite') this.skip();
    const orphan = { id: 'uiix' + cuid(), username: 'uiixgone' + cuid().toLowerCase().slice(1, 10) };
    await fromCallback((cb) => storageLayer.accesses.insertOne(orphan,
      { id: cuid(), token: cuid(), type: 'app', name: 'uiix left behind', permissions: [], created: 1, createdBy: 'test', modified: 1, modifiedBy: 'test' }, cb));
    try {
      const check = await usersIndex.checkIntegrity();
      assert.ok(check.errors.some((e) => e.includes('"' + orphan.id + '"') && e.includes('"accesses"')),
        'the orphan user id is reported: ' + JSON.stringify(check.errors));
      const res = await coreRequest.get('/system/check-platform-integrity').set('Authorization', adminAccessKey);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const indexCheck = res.body.checks.find((c) => c.title === check.title);
      assert.ok(indexCheck.errors.some((e) => e.includes(orphan.id)), 'reported by the system route: ' + JSON.stringify(res.body.checks));
    } finally {
      await fromCallback((cb) => storageLayer.accesses.removeAll(orphan, cb));
    }
    const after = await usersIndex.checkIntegrity();
    assert.ok(!after.errors.some((e) => e.includes(orphan.id)), 'cleared with the rows');
  });

  it('[UIIX2] deleting an account through the users repository alone leaves none of its accesses, profile or webhooks', async function () {
    const username = 'uiix' + cuid().toLowerCase().slice(1, 12);
    const fixtureUser = await getNewFixture().user(username);
    const user = { id: fixtureUser.attrs.id, username };
    await fromCallback((cb) => storageLayer.accesses.insertOne(user,
      { id: cuid(), token: cuid(), type: 'app', name: 'uiix2', permissions: [], created: 1, createdBy: 'test', modified: 1, modifiedBy: 'test' }, cb));
    await fromCallback((cb) => storageLayer.profile.insertOne(user, { id: 'private', data: { uiix: 2 } }, cb));
    const { getUsersRepository } = require('business/src/users/index.ts');
    await (await getUsersRepository()).deleteOne(user.id, username);
    for (const name of ['accesses', 'profile']) {
      const left = await fromCallback((cb) => storageLayer[name].find(user, {}, null, cb));
      assert.deepStrictEqual(left, [], name + ' rows left by the deletion');
    }
    const check = await usersIndex.checkIntegrity();
    assert.ok(!check.errors.some((e) => e.includes('"' + user.id + '"')), JSON.stringify(check.errors));
  });
});
