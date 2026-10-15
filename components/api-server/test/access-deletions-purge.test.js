/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const timestamp = require('unix-timestamp');
const { getPlatform } = require('platform');
const accessIndex = require('platform/src/accessIndex.ts');
const { purgeAccessDeletionRecords } = require('business/src/accesses/deletionRecordsPurge.ts');

/**
 * The opt-in purge of access deletion records, on the real storage engine:
 * a record deleted before the retention goes with its version rows and its
 * index row; a recent record and the live accesses stay.
 */
describe('[ADPG] access deletion records purge', function () {
  this.timeout(30000);
  let fixtures, username, userId, personalToken, platform, accesses;

  function call (fn) {
    return new Promise((resolve, reject) => fn((err, res) => (err != null ? reject(err) : resolve(res))));
  }

  async function createApp (name) {
    const res = await coreRequest.post(`/${username}/accesses`).set('Authorization', personalToken)
      .send({ name, type: 'app', permissions: [{ streamId: 'adpg', level: 'read' }] });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.access;
  }

  async function deleteApp (id) {
    const res = await coreRequest.delete(`/${username}/accesses/${id}`).set('Authorization', personalToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }

  async function deletionIds () {
    const res = await coreRequest.get(`/${username}/accesses`).set('Authorization', personalToken).query({ includeDeletions: true });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return (res.body.accessDeletions || []).map((a) => a.id);
  }

  function purge (retentionDays) {
    return purgeAccessDeletionRecords({
      accesses,
      listUsers: async () => [{ id: userId, username }],
      deleteIndexRow: (id) => accessIndex.deleteAccessIndexRow(platform, id),
      retentionDays
    });
  }

  before(async function () {
    await initTests();
    await initCore();
    platform = await getPlatform();
    accesses = require('storages').storageLayer.accesses;
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username);
    userId = user.attrs.id;
    await user.stream({ id: 'adpg', name: 'Adpg' });
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
  });

  after(async function () {
    await fixtures.clean();
  });

  it('[ADP1] removes an old record, its versions and its index row; keeps recent records and live accesses', async function () {
    const old = await createApp('adpg-old-' + cuid());
    const upd = await coreRequest.put(`/${username}/accesses/${old.id}`).set('Authorization', personalToken)
      .send({ name: 'adpg-old-renamed-' + cuid() });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    // an updated access is addressed by its current version id
    await deleteApp(upd.body.access.id);
    const recent = await createApp('adpg-recent-' + cuid());
    await deleteApp(recent.id);
    const live = await createApp('adpg-live-' + cuid());

    // the old record was deleted 40 days ago
    const user = { id: userId, username };
    await call((cb) => accesses.updateMany(user, { id: old.id }, { $set: { deleted: timestamp.now() - 40 * 24 * 3600 } }, cb));
    const versionsBefore = await accesses.findHistory(user, old.id);
    assert.ok(versionsBefore.length > 0, 'the update left a version row');
    assert.ok(await accessIndex.getAccessIndex(platform, old.id) != null);

    const result = await purge(30);
    assert.strictEqual(result.records, 1, JSON.stringify(result));
    assert.strictEqual(result.versions, versionsBefore.length, JSON.stringify(result));
    assert.strictEqual(result.failed, 0);

    const ids = await deletionIds();
    assert.ok(!ids.includes(old.id), 'old record purged');
    assert.ok(ids.includes(recent.id), 'recent record kept');
    assert.deepStrictEqual(await accesses.findHistory(user, old.id), []);
    assert.strictEqual(await accessIndex.getAccessIndex(platform, old.id), null);
    assert.ok(await accessIndex.getAccessIndex(platform, recent.id) != null, 'recent index row kept');

    const get = await coreRequest.get(`/${username}/accesses`).set('Authorization', personalToken);
    assert.ok(get.body.accesses.some((a) => a.id === live.id), 'live access kept');

    // nothing left to purge
    const again = await purge(30);
    assert.strictEqual(again.records, 0);
  });

  it('[ADP2] an index row that cannot be removed keeps the record for the next pass', async function () {
    const old = await createApp('adpg-kept-' + cuid());
    await deleteApp(old.id);
    const user = { id: userId, username };
    await call((cb) => accesses.updateMany(user, { id: old.id }, { $set: { deleted: timestamp.now() - 40 * 24 * 3600 } }, cb));
    const result = await purgeAccessDeletionRecords({
      accesses,
      listUsers: async () => [{ id: userId, username }],
      deleteIndexRow: async () => { throw new Error('platform down'); },
      retentionDays: 30,
      logger: { warn: () => {} }
    });
    assert.strictEqual(result.records, 0);
    assert.strictEqual(result.failed, 1);
    assert.ok((await deletionIds()).includes(old.id), 'record kept');
    assert.strictEqual((await purge(30)).records, 1, 'removed on the next pass');
  });
});
