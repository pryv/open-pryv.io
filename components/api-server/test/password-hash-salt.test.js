/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, assert, cuid */

const bcrypt = require('bcrypt');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getUserAccountStorage } = require('storage');

// `$2b$<cost>$` followed by the 22-character salt.
const SALT_PREFIX_LENGTH = 29;

/**
 * [PWSL] Stored password hashes: every hash carries its own salt, so two
 * accounts with the same password never share a stored hash, and both log in.
 */
describe('[PWSL] stored password hashes carry a per-hash salt', function () {
  this.timeout(60_000);
  let usersRepository, userAccountStorage;

  before(async function () {
    await initTests();
    await initCore();
    usersRepository = await getUsersRepository();
    userAccountStorage = await getUserAccountStorage();
  });

  function newName (prefix) {
    return prefix + cuid().toLowerCase().slice(1, 12);
  }

  async function register (username, password) {
    const res = await coreRequest.post('/users').send({
      appId: 'pwsl-app',
      username,
      password,
      email: username + '@pwsl.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en'
    });
    assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
    return await usersRepository.getUserIdForUsername(username);
  }

  async function login (username, password) {
    return coreRequest.post(`/${username}/auth/login`).set('Origin', 'https://sw.backloop.dev')
      .send({ username, password, appId: 'pwsl-login' });
  }

  it('[PWSL1] two accounts registered with the same password get different salts, and both log in', async function () {
    const password = 'pwsl-same-passw0rd';
    const nameA = newName('pwsla');
    const nameB = newName('pwslb');
    const idA = await register(nameA, password);
    const idB = await register(nameB, password);

    const hashA = await userAccountStorage.getPasswordHash(idA);
    const hashB = await userAccountStorage.getPasswordHash(idB);
    assert.ok(typeof hashA === 'string' && typeof hashB === 'string');
    assert.notStrictEqual(hashA.slice(0, SALT_PREFIX_LENGTH), hashB.slice(0, SALT_PREFIX_LENGTH));
    assert.strictEqual(bcrypt.getRounds(hashA), 10);
    assert.strictEqual(bcrypt.getRounds(hashB), 10);

    const loginA = await login(nameA, password);
    assert.strictEqual(loginA.status, 200, JSON.stringify(loginA.body));
    const loginB = await login(nameB, password);
    assert.strictEqual(loginB.status, 200, JSON.stringify(loginB.body));
  });
});
