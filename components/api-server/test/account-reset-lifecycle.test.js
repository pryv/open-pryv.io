/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, assert, cuid */

/**
 * [RPLC] Password reset lifecycle: request throttle, hashed single-use
 * tokens (one live per account), and credential revocation on reset and on
 * password change.
 */

const crypto = require('node:crypto');
const nock = require('nock');
const storage = require('storage');
const { fromCallback } = require('utils');
const { useNock } = require('test-helpers/src/nockScope.ts');
const { withInjectedConfig } = require('test-helpers');
const ErrorIds = require('errors').ErrorIds;
const throttle = require('business/src/auth/passwordResetThrottle.ts');
const { getUsersRepository } = require('business/src/users/index.ts');

// A trusted app with a wildcard origin in the test config.
const TRUSTED_APP = 'pryv-test-no-cors';
const LOCAL_IPS = ['127.0.0.1', '::1'];

describe('[RPLC] password reset lifecycle', function () {
  this.timeout(60_000);
  useNock();
  let storageLayer, platformDB;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await storage.getStorageLayer();
    platformDB = require('storages').platformDB;
  });

  beforeEach(async function () {
    await throttle.clearPasswordResetThrottle(null, LOCAL_IPS);
  });

  after(async function () {
    await throttle.clearPasswordResetThrottle(null, LOCAL_IPS);
  });

  async function newUser () {
    const username = 'rplc' + cuid().toLowerCase().slice(1, 12);
    const password = 'rplc-passw0rd';
    const res = await coreRequest.post('/users').send({
      appId: 'rplc-app',
      username,
      password,
      email: username + '@rplc.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en'
    });
    assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
    const userId = await (await storage.getUsersLocalIndex()).getUserId(username);
    return { username, password, userId };
  }

  async function login (user, appId) {
    const res = await coreRequest.post(`/${user.username}/auth/login`).set('Origin', 'https://sw.backloop.dev')
      .send({ username: user.username, password: user.password, appId });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.token;
  }

  async function accessInfoStatus (user, token) {
    const res = await coreRequest.get(`/${user.username}/access-info`).set('Authorization', token);
    return res.status;
  }

  function requestReset (user) {
    return coreRequest.post(`/${user.username}/account/request-password-reset`).send({ appId: TRUSTED_APP });
  }

  function reset (user, resetToken, newPassword) {
    return coreRequest.post(`/${user.username}/account/reset-password`)
      .send({ appId: TRUSTED_APP, resetToken, newPassword });
  }

  // Request a reset through the API and return the mailed token.
  async function requestResetToken (user) {
    const captured = [];
    nock('https://mandrillapp.local').post('/api/1.0/messages/send-template.json')
      .reply(200, (uri, body) => { captured.push(body); return {}; });
    await withInjectedConfig({ services: { email: { enabled: { resetPassword: true } } } }, async () => {
      const res = await requestReset(user);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });
    assert.strictEqual(captured.length, 1);
    return captured[0].message.global_merge_vars.find((v) => v.name === 'RESET_TOKEN').content;
  }

  function generateToken (username) {
    return fromCallback((cb) => storageLayer.passwordResetRequests.generate(username, cb));
  }

  function getRequest (token, username) {
    return fromCallback((cb) => storageLayer.passwordResetRequests.get(token, username, cb));
  }

  it('[RPLC1] a second request for the same account within the cooldown is refused with 429', async function () {
    const user = await newUser();
    const other = await newUser();
    const first = await requestReset(user);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await requestReset(user);
    assert.strictEqual(second.status, 429, JSON.stringify(second.body));
    assert.strictEqual(second.body.error.id, ErrorIds.TooManyAttempts);
    assert.ok(Number(second.headers['retry-after']) > 0, 'Retry-After must be set');
    // The cooldown is per account.
    const forOther = await requestReset(other);
    assert.strictEqual(forOther.status, 200, JSON.stringify(forOther.body));
  });

  it('[RPLC2] an account gets at most five requests per day', async function () {
    const user = await newUser();
    for (let i = 0; i < throttle.ACCOUNT_DAILY_LIMIT; i++) {
      await platformDB.deleteAccessState(throttle.cooldownKey(user.userId));
      const res = await requestReset(user);
      assert.strictEqual(res.status, 200, `request ${i + 1}: ` + JSON.stringify(res.body));
    }
    await platformDB.deleteAccessState(throttle.cooldownKey(user.userId));
    const refused = await requestReset(user);
    assert.strictEqual(refused.status, 429, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.error.id, ErrorIds.TooManyAttempts);
  });

  it('[RPLC3] a client address over its hourly budget is refused for any account', async function () {
    const user = await newUser();
    for (const ip of LOCAL_IPS) {
      await platformDB.setAccessState(throttle.ipKey(ip), { count: throttle.IP_HOURLY_LIMIT }, Date.now() + 60_000);
    }
    const refused = await requestReset(user);
    assert.strictEqual(refused.status, 429, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.error.id, ErrorIds.TooManyAttempts);
  });

  it('[RPLC4] the stored request is keyed by the token hash, never by the token', async function () {
    const user = await newUser();
    const token = await requestResetToken(user);
    const rows = (await fromCallback((cb) => storageLayer.passwordResetRequests.exportAll(cb)))
      .filter((r) => r.username === user.username);
    assert.strictEqual(rows.length, 1);
    assert.notStrictEqual(rows[0]._id, token);
    assert.strictEqual(rows[0]._id, crypto.createHash('sha256').update(token).digest('hex'));
    // A row whose id is a clear token (as stored before) matches nothing.
    await fromCallback((cb) => storageLayer.passwordResetRequests.importAll(
      [{ _id: 'clear-token-' + user.username, username: user.username, expires: new Date(Date.now() + 60_000) }], cb));
    assert.strictEqual(await getRequest('clear-token-' + user.username, user.username), null);
  });

  it('[RPLC5] a new request invalidates the previous token', async function () {
    const user = await newUser();
    const first = await requestResetToken(user);
    await platformDB.deleteAccessState(throttle.cooldownKey(user.userId));
    const second = await requestResetToken(user);
    const stale = await reset(user, first, 'rplc-new-passw0rd');
    assert.strictEqual(stale.status, 401, JSON.stringify(stale.body));
    assert.strictEqual(stale.body.error.id, ErrorIds.InvalidAccessToken);
    const ok = await reset(user, second, 'rplc-new-passw0rd');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  it('[RPLC6] a token is single use, and a refused reset burns it', async function () {
    const user = await newUser();
    let token = await generateToken(user.username);
    await withInjectedConfig({ auth: { passwordComplexityMinLength: 30 } }, async () => {
      const refused = await reset(user, token, 'rplc-short-passw0rd');
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
    });
    const afterRefusal = await reset(user, token, 'rplc-new-passw0rd');
    assert.strictEqual(afterRefusal.status, 401, 'a refused reset must consume the token');

    token = await generateToken(user.username);
    const first = await reset(user, token, 'rplc-new-passw0rd');
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await reset(user, token, 'rplc-other-passw0rd');
    assert.strictEqual(second.status, 401, JSON.stringify(second.body));
    assert.strictEqual(second.body.error.id, ErrorIds.InvalidAccessToken);
  });

  it('[RPLC7] a password change invalidates pending reset tokens', async function () {
    const user = await newUser();
    const personal = await login(user, 'rplc-a');
    const token = await generateToken(user.username);
    const change = await coreRequest.post(`/${user.username}/account/change-password`).set('Authorization', personal)
      .send({ oldPassword: user.password, newPassword: 'rplc-changed-passw0rd' });
    assert.strictEqual(change.status, 200, JSON.stringify(change.body));
    assert.strictEqual(await getRequest(token, user.username), null);
    const res = await reset(user, token, 'rplc-new-passw0rd');
    assert.strictEqual(res.status, 401, JSON.stringify(res.body));
  });

  it('[RPLC8] a reset revokes every personal session and personal access of the account', async function () {
    const user = await newUser();
    const tokenA = await login(user, 'rplc-a');
    const tokenB = await login(user, 'rplc-b');
    const legacy = await fromCallback((cb) => storageLayer.sessions.generate({ username: user.username, appId: 'rplc-legacy' }, null, cb));
    assert.strictEqual(await accessInfoStatus(user, tokenA), 200);
    assert.strictEqual(await accessInfoStatus(user, tokenB), 200);

    const token = await generateToken(user.username);
    const res = await reset(user, token, 'rplc-new-passw0rd');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.strictEqual(await accessInfoStatus(user, tokenA), 403);
    assert.strictEqual(await accessInfoStatus(user, tokenB), 403);
    assert.strictEqual(await fromCallback((cb) => storageLayer.sessions.get(legacy, cb)), null, 'username-only session removed');
    const personal = await fromCallback((cb) => storageLayer.accesses.find({ id: user.userId, username: user.username }, { type: 'personal' }, {}, cb));
    assert.strictEqual(personal.length, 0, 'no live personal access');

    // The new password opens a working session.
    const fresh = await login({ ...user, password: 'rplc-new-passw0rd' }, 'rplc-a');
    assert.strictEqual(await accessInfoStatus(user, fresh), 200);
  });

  it('[RPLC9] a password change keeps the caller\'s session and revokes the others', async function () {
    const user = await newUser();
    const caller = await login(user, 'rplc-a');
    const other = await login(user, 'rplc-b');
    const change = await coreRequest.post(`/${user.username}/account/change-password`).set('Authorization', caller)
      .send({ oldPassword: user.password, newPassword: 'rplc-changed-passw0rd' });
    assert.strictEqual(change.status, 200, JSON.stringify(change.body));
    assert.strictEqual(await accessInfoStatus(user, caller), 200);
    assert.strictEqual(await accessInfoStatus(user, other), 403);
  });

  it('[RPLC10] deleting the account removes its reset requests', async function () {
    const user = await newUser();
    const token = await generateToken(user.username);
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteOne(user.userId, user.username);
    assert.strictEqual(await getRequest(token, user.username), null);
    const rows = (await fromCallback((cb) => storageLayer.passwordResetRequests.exportAll(cb)))
      .filter((r) => r.username === user.username);
    assert.strictEqual(rows.length, 0);
  });
});
