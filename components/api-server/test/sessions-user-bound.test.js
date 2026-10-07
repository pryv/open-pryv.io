/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, assert, cuid */

const storage = require('storage');
const { fromCallback } = require('utils');

/**
 * [SUBD] A login session belongs to one account (by user id): a session left
 * under a username by a former owner of that name is never handed to the
 * account that holds the name now, nor accepted for it.
 */
describe('[SUBD] login sessions are bound to the account', function () {
  this.timeout(60_000);
  let storageLayer, username, password;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await storage.getStorageLayer();
    username = 'subd' + cuid().toLowerCase().slice(1, 12);
    password = 'subd-passw0rd';
    const res = await coreRequest.post('/users').send({
      appId: 'subd-app',
      username,
      password,
      email: username + '@subd.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en'
    });
    assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
  });

  function generateSession (data) {
    return fromCallback((cb) => storageLayer.sessions.generate(data, null, cb));
  }

  function login (appId) {
    return coreRequest.post(`/${username}/auth/login`).set('Origin', 'https://sw.backloop.dev')
      .send({ username, password, appId });
  }

  it('[SUBD1] a session stored under this username without a user id is not reused at login', async function () {
    const legacy = await generateSession({ username, appId: 'subd-legacy' });
    const res = await login('subd-legacy');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.notStrictEqual(res.body.token, legacy);
  });

  it('[SUBD2] a session of another user id under this username is neither reused nor accepted', async function () {
    const foreign = await generateSession({ username, appId: 'subd-foreign', userId: 'former-owner-id' });
    const res = await login('subd-foreign');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.notStrictEqual(res.body.token, foreign);

    // A personal access of this account carrying that session's id is refused.
    const userId = await (await storage.getUsersLocalIndex()).getUserId(username);
    await fromCallback((cb) => storageLayer.accesses.insertOne({ id: userId, username },
      { id: cuid(), token: foreign, type: 'personal', name: 'subd-planted', permissions: [], created: 1, createdBy: 'test', modified: 1, modifiedBy: 'test' }, cb));
    const info = await coreRequest.get(`/${username}/access-info`).set('Authorization', foreign);
    assert.strictEqual(info.status, 403, JSON.stringify(info.body));
  });

  it('[SUBD4] a session naming no account (no user id, no username) does not validate a personal access', async function () {
    const anonymous = await generateSession({ appId: 'subd-anonymous' });
    const userId = await (await storage.getUsersLocalIndex()).getUserId(username);
    await fromCallback((cb) => storageLayer.accesses.insertOne({ id: userId, username },
      { id: cuid(), token: anonymous, type: 'personal', name: 'subd-anonymous', permissions: [], created: 1, createdBy: 'test', modified: 1, modifiedBy: 'test' }, cb));
    const info = await coreRequest.get(`/${username}/access-info`).set('Authorization', anonymous);
    assert.strictEqual(info.status, 403, JSON.stringify(info.body));
    assert.strictEqual(info.body.error.id, 'invalid-access-token');
  });

  it('[SUBD3] a login session records the account id and is reused by that account', async function () {
    const first = await login('subd-own');
    const second = await login('subd-own');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.body.token, first.body.token, 'same account, same app: the session is reused');
    const data = await fromCallback((cb) => storageLayer.sessions.get(first.body.token, cb));
    assert.strictEqual(typeof data.userId, 'string');
  });
});
