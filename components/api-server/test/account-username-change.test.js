/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[UCHG] account.changeUsername (secondary username)', function () {
  const PASSWORD = 'test-password-1';
  const APP_ID = 'pryv-test-no-cors'; // trusted for any origin in test-config

  let username;
  let personalToken;
  let witnessToken; // an app access created under the original username

  async function login (uname) {
    const res = await coreRequest
      .post('/' + uname + '/auth/login')
      .send({ username: uname, password: PASSWORD, appId: APP_ID });
    assert.equal(res.status, 200, 'login: ' + JSON.stringify(res.body));
    return res.body.token;
  }

  async function freshUser () {
    const uname = cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const fu = await getNewFixture().user(uname, { password: PASSWORD });
    await fu.stream({ id: 's0', name: 'S0' });
    return { uname, fu };
  }

  before(async function () {
    await initTests();
    await initCore();
    const created = await freshUser();
    username = created.uname;
    personalToken = await login(username);

    // A witness app access issued under the ORIGINAL username; must keep
    // working (and report the new username) after the change.
    const res = await coreRequest
      .post('/' + username + '/accesses')
      .set('Authorization', personalToken)
      .send({ name: 'witness', type: 'app', permissions: [{ streamId: 's0', level: 'read' }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    witnessToken = res.body.access.token;
  });

  function changeUsername (addressedName, newUsername, token = personalToken) {
    return coreRequest
      .post('/' + addressedName + '/account/change-username')
      .set('Authorization', token)
      .send({ newUsername });
  }

  it('[UC01] changes the username and reports remaining changes', async function () {
    const newUsername = ('a' + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const res = await changeUsername(username, newUsername);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.account.username, newUsername);
    assert.equal(res.body.usernameChangesRemaining, 1); // default limit 2, used 1

    // Witness access (issued under the OLD username) still routes, and
    // access-info now reports the NEW canonical username.
    const old = await coreRequest.get('/' + username + '/access-info').set('Authorization', witnessToken);
    assert.equal(old.status, 200, 'old username must still route: ' + JSON.stringify(old.body));
    assert.equal(old.body.user.username, newUsername, 'reports the latest active username');

    // The new username also routes.
    const fresh = await coreRequest.get('/' + newUsername + '/access-info').set('Authorization', witnessToken);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.user.username, newUsername);

    username = newUsername; // subsequent tests address the current name
  });

  it('[UC02] rejects a username already taken (by a primary or an alias)', async function () {
    // The previous (now-demoted) username is held as an alias -> taken.
    const prior = await coreRequest
      .post('/' + username + '/account/change-username')
      .set('Authorization', personalToken)
      .send({ newUsername: username }); // same as current
    assert.equal(prior.status, 400, JSON.stringify(prior.body));
  });

  it('[UC03] reports change usage via account/username-changes', async function () {
    const res = await coreRequest.get('/' + username + '/account/username-changes').set('Authorization', personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.usernameChangesLimit, 2);
    assert.equal(res.body.usernameChangesUsed, 1);
    assert.equal(res.body.usernameChangesRemaining, 1);
  });

  it('[UC04] enforces the change limit (default 2)', async function () {
    // Second change (used 1 -> allowed), reaching the limit.
    const second = ('b' + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const r2 = await changeUsername(username, second);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.usernameChangesRemaining, 0);
    username = second;

    // Third change must be rejected (limit reached).
    const third = ('c' + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const r3 = await changeUsername(username, third);
    assert.equal(r3.status, 400, 'limit reached: ' + JSON.stringify(r3.body));
  });

  it('[UC05] requires a personal token', async function () {
    const next = ('d' + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const res = await changeUsername(username, next, witnessToken); // app token
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });
});
