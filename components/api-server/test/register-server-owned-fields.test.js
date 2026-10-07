/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, assert, cuid */

const { getUsersRepository } = require('business/src/users/index.ts');
const { User } = require('business/src/users/index.ts');
const { ErrorIds } = require('errors');

/**
 * [RGOF] A public registration never sets the new user's id, stored password
 * hash or initial account events: they are the server's. An id already owned
 * by an account is refused before anything is written, and a failed creation
 * never removes another account's data.
 */
describe('[RGOF] registration: server-owned user fields', function () {
  this.timeout(60_000);
  let usersRepository;

  before(async function () {
    await initTests();
    await initCore();
    usersRepository = await getUsersRepository();
  });

  function newName (prefix) {
    return prefix + cuid().toLowerCase().slice(1, 12);
  }

  async function register (fields) {
    const username = fields.username;
    return coreRequest.post('/users').send(Object.assign({
      appId: 'rgof-app',
      password: 'rgof-passw0rd',
      email: username + '@rgof.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en'
    }, fields));
  }

  async function login (username, password) {
    return coreRequest.post(`/${username}/auth/login`).set('Origin', 'https://sw.backloop.dev')
      .send({ username, password, appId: 'rgof-login' });
  }

  it('[RGOF1] ignores a supplied id: the existing account keeps its id, data and password', async function () {
    const existing = newName('rgofa');
    const res1 = await register({ username: existing });
    assert.ok(res1.status === 201 || res1.status === 200, JSON.stringify(res1.body));
    const existingId = await usersRepository.getUserIdForUsername(existing);
    assert.ok(existingId != null);

    const other = newName('rgofb');
    const res2 = await register({ username: other, id: existingId, password: 'rgof-other-passw0rd' });
    assert.ok(res2.status === 201 || res2.status === 200, JSON.stringify(res2.body));
    const otherId = await usersRepository.getUserIdForUsername(other);
    assert.ok(otherId != null);
    assert.notStrictEqual(otherId, existingId, 'the new account got its own id');

    assert.strictEqual(await usersRepository.getUserIdForUsername(existing), existingId);
    const loginExisting = await login(existing, 'rgof-passw0rd');
    assert.strictEqual(loginExisting.status, 200, JSON.stringify(loginExisting.body));
  });

  it('[RGOF2] ignores a supplied passwordHash: the account logs in with its password', async function () {
    const username = newName('rgofc');
    const res = await register({ username, passwordHash: '$2b$10$abcdefghijklmnopqrstuuG4pM5uQ2QfB0Lz3B9uY6Qx8xX1yZ2a' });
    assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
    const ok = await login(username, 'rgof-passw0rd');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  it('[RGOF3] ignores supplied initial account events', async function () {
    const username = newName('rgofd');
    const res = await register({ username, events: [{ streamIds: [':_system:language'], content: 'xx-not-a-language-at-all' }] });
    assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
    const stored = await usersRepository.getUserByUsername(username);
    assert.strictEqual(stored.language, 'en', 'the account field comes from the validated params');
    const ok = await login(username, 'rgof-passw0rd');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  it('[RGOF4] creating a user with an id already owned by an account is refused, and that account is left intact', async function () {
    const existing = newName('rgofe');
    const res1 = await register({ username: existing });
    assert.ok(res1.status === 201 || res1.status === 200, JSON.stringify(res1.body));
    const existingId = await usersRepository.getUserIdForUsername(existing);

    const clash = new User({ id: existingId, username: newName('rgoff'), password: 'rgof-passw0rd', email: 'rgof-clash@rgof.example.com', insurancenumber: '12345', language: 'en' });
    await assert.rejects(() => usersRepository.insertOne(clash), (err) => err.id === ErrorIds.ItemAlreadyExists);

    assert.strictEqual(await usersRepository.getUserIdForUsername(existing), existingId);
    const loginExisting = await login(existing, 'rgof-passw0rd');
    assert.strictEqual(loginExisting.status, 200, JSON.stringify(loginExisting.body));
  });
});
