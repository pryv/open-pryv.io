/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * accesses.delete must invalidate the access cache AFTER the DB delete commits,
 * and must issue the unset from the authoritative access row even when the entry
 * is not cached on this worker (so a deleted token cannot keep validating on a
 * sibling worker until eviction). This drives a real delete of a shared access
 * that was never authenticated (hence never locally cached) and records the
 * sequence of the repository delete vs the cache unset.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const storage = require('storage');
const cache = require('cache').default;

describe('[ADCO] accesses.delete busts the cache after the delete', function () {
  let username, basePath, personalToken, sharedToken, sharedId, user;
  let accessStorage, fixtures, fixtureUser;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    sharedToken = cuid();
    basePath = '/' + username + '/accesses';
    user = { id: username };
    const storageLayer = await storage.getStorageLayer();
    accessStorage = storageLayer.accesses;
    fixtureUser = await fixtures.user(username);
    await fixtureUser.access({ type: 'personal', token: personalToken });
    await fixtureUser.session(personalToken);
    const shared = await fixtureUser.access({
      id: `shared_${username}`,
      type: 'shared',
      name: 'read all',
      token: sharedToken,
      permissions: [{ streamId: '*', level: 'read' }]
    });
    sharedId = shared.attrs.id;
  });

  after(async function () {
    await new Promise((resolve) => accessStorage.removeAll(user, () => resolve()));
  });

  it('[ADC1] unsets the deleted (not-locally-cached) access from cache, with its real token, after the delete commits', async function () {
    const seq = [];
    const origUnset = cache.unsetAccessLogic;
    const origDelete = accessStorage.delete;
    cache.unsetAccessLogic = function (userId, logic) {
      seq.push({ ev: 'unset', id: logic && logic.id, token: logic && logic.token });
      return origUnset.call(cache, userId, logic);
    };
    accessStorage.delete = function (u, query, cb) {
      return origDelete.call(this, u, query, (err, res) => {
        seq.push({ ev: 'delete-done' });
        cb(err, res);
      });
    };
    try {
      const res = await coreRequest
        .delete(basePath + '/' + sharedId)
        .set('Authorization', personalToken);
      assert.strictEqual(res.status, 200, 'the delete must succeed');
    } finally {
      cache.unsetAccessLogic = origUnset;
      accessStorage.delete = origDelete;
    }

    const deleteIdx = seq.findIndex((e) => e.ev === 'delete-done');
    assert.ok(deleteIdx >= 0, `the repository delete must have run: ${JSON.stringify(seq)}`);
    const sharedUnset = seq.find((e) => e.ev === 'unset' && e.id === sharedId);
    // Pre-fix this is null: the shared token was never authenticated, so the
    // pre-delete cache loop skipped it (cross-worker hole) — the row-sourced,
    // broadcast-always unset is what makes this non-null.
    assert.ok(sharedUnset != null, `the deleted access must be unset from cache: ${JSON.stringify(seq)}`);
    assert.strictEqual(sharedUnset.token, sharedToken, 'the unset must carry the row\'s real token');
    const unsetIdx = seq.findIndex((e) => e.ev === 'unset' && e.id === sharedId);
    assert.ok(unsetIdx > deleteIdx, `the cache unset must follow the delete completion: ${JSON.stringify(seq)}`);
  });
});
