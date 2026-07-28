/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { getConfig } = require('@pryv/boiler');
const { getPlatform } = require('platform');
const accessIndex = require('platform/src/accessIndex.ts');

/**
 * End-to-end coverage for the access reverse-index mutation hooks. Accesses
 * are created / updated / deleted through the API (so the hooks that populate
 * the index run), and the resulting index rows are read back directly from the
 * platform store. The read side (GET /system/accesses/:accessId) is covered in
 * system.test.js, where the /system admin surface is exercised.
 *
 * Tests run in the default hashed piiMode (test harness sets a pepper), so the
 * owning user is stored as a `usernameToken`, never plaintext.
 */
describe('[ACIX] access reverse-index population hooks', function () {
  let fixtures, username, personalToken, platform, usernameToken;

  before(async function () {
    await initTests();
    await initCore();
    await getConfig();
    platform = await getPlatform();
    fixtures = getNewFixture();
    username = cuid();
    usernameToken = platform.hashFor('username', username);
    const user = await fixtures.user(username);
    personalToken = cuid();
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    await user.stream({ id: 'sx', name: 'Sx' });
  });

  after(async function () {
    await fixtures.context.cleanEverything();
  });

  async function createAppAccess (name) {
    const res = await coreRequest.post(`/${username}/accesses`).set('Authorization', personalToken)
      .send({ name, type: 'app', permissions: [{ streamId: 'sx', level: 'read' }] });
    assert.strictEqual(res.status, 201, 'app access created');
    return res.body.access;
  }

  it('[ACIX01] create indexes the access (base id, owning user token, no token/name)', async function () {
    const access = await createAppAccess('app-a');
    const entry = await accessIndex.getAccessIndex(platform, access.id);
    assert.ok(entry != null, 'index row written on create');
    assert.strictEqual(entry.accessId, access.id);
    assert.strictEqual(entry.type, 'app');
    assert.ok(entry.deleted == null);
    assert.strictEqual(entry.usernameToken, usernameToken, 'owning user stored as hashed token');
    assert.ok(!('username' in entry), 'no plaintext username in hashed mode');
    assert.ok(!('token' in entry), 'access token never stored');
    assert.ok(!('name' in entry), 'access name never stored');
    // The row bytes carry neither the secret token nor the name.
    const raw = JSON.stringify(entry);
    assert.ok(!raw.includes(access.token));
  });

  it('[ACIX02] update refreshes the index (lastModified bumps, created preserved)', async function () {
    const access = await createAppAccess('app-b');
    const before = await accessIndex.getAccessIndex(platform, access.id);
    const upd = await coreRequest.put(`/${username}/accesses/${access.id}`).set('Authorization', personalToken)
      .send({ name: 'app-b-renamed' });
    assert.strictEqual(upd.status, 200);
    const after = await accessIndex.getAccessIndex(platform, access.id);
    assert.ok(after != null);
    assert.strictEqual(after.created, before.created, 'created is stable across updates');
    assert.ok(after.lastModified >= before.lastModified, 'lastModified refreshed');
  });

  it('[ACIX03] delete leaves a resolvable tombstone (deleted set, row retained)', async function () {
    const access = await createAppAccess('app-c');
    assert.ok(await accessIndex.getAccessIndex(platform, access.id) != null);
    const del = await coreRequest.delete(`/${username}/accesses/${access.id}`).set('Authorization', personalToken);
    assert.strictEqual(del.status, 200);
    const entry = await accessIndex.getAccessIndex(platform, access.id);
    assert.ok(entry != null, 'row retained after deletion for post-hoc breach scoping');
    assert.ok(entry.deleted != null, 'deleted timestamp set');
    assert.strictEqual(entry.accessId, access.id);
  });

  it('[ACIX04] login indexes the personal access, and re-login reindexes it', async function () {
    const luser = cuid();
    const lpass = cuid();
    await fixtures.user(luser, { password: lpass });
    const login1 = await coreRequest.post(`/${luser}/auth/login`).set('Origin', 'https://sw.backloop.dev')
      .send({ username: luser, password: lpass, appId: 'acix-app' });
    assert.strictEqual(login1.status, 200, JSON.stringify(login1.body));
    const tok = login1.body.token;
    const list1 = await coreRequest.get(`/${luser}/accesses`).set('Authorization', tok);
    const personal = list1.body.accesses.find((a) => a.type === 'personal' && a.name === 'acix-app');
    assert.ok(personal, 'personal access exists after login');
    const entry1 = await accessIndex.getAccessIndex(platform, personal.id);
    assert.ok(entry1 != null, 'login-created personal access is indexed');
    assert.strictEqual(entry1.type, 'personal');
    // Re-login rotates the token -> updatePersonalAccess -> reindex (L1).
    const login2 = await coreRequest.post(`/${luser}/auth/login`).set('Origin', 'https://sw.backloop.dev')
      .send({ username: luser, password: lpass, appId: 'acix-app' });
    assert.strictEqual(login2.status, 200);
    const entry2 = await accessIndex.getAccessIndex(platform, personal.id);
    assert.ok(entry2 != null && entry2.lastModified >= entry1.lastModified, 'reindexed on token rotation');
  });

  it('[ACIX05] user erasure (default) removes the index rows', async function () {
    const euser = cuid();
    const eu = await fixtures.user(euser);
    const ep = cuid();
    await eu.access({ token: ep, type: 'personal' });
    await eu.session(ep);
    await eu.stream({ id: 'se', name: 'Se' });
    const res = await coreRequest.post(`/${euser}/accesses`).set('Authorization', ep)
      .send({ name: 'erase-me', type: 'app', permissions: [{ streamId: 'se', level: 'read' }] });
    assert.strictEqual(res.status, 201);
    const accId = res.body.access.id;
    assert.ok(await accessIndex.getAccessIndex(platform, accId) != null, 'indexed before erasure');
    const { getUsersLocalIndex } = require('storage');
    const idx = await getUsersLocalIndex();
    const userId = await idx.getUserId(euser);
    const { getUsersRepository } = require('business/src/users/index.ts');
    const repo = await getUsersRepository();
    await repo.deleteOne(userId, euser);
    assert.strictEqual(await accessIndex.getAccessIndex(platform, accId), null, 'index rows removed on erasure (Art.17)');
  });
});
