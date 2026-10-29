/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { pubsub } = require('messages');

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

  // The first change runs once, in whichever test needs it first, so every
  // test also passes when selected on its own.
  let firstChangeDone = null;
  function firstChange () {
    if (firstChangeDone == null) firstChangeDone = runFirstChange();
    return firstChangeDone;
  }

  async function runFirstChange () {
    const formerUsername = username;
    const newUsername = ('a' + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const res = await changeUsername(formerUsername, newUsername);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    username = newUsername; // subsequent tests address the current name
    return { res, formerUsername, newUsername };
  }

  it('[UC01] changes the username and reports remaining changes', async function () {
    const { res, formerUsername, newUsername } = await firstChange();
    assert.equal(res.body.account.username, newUsername);
    assert.equal(res.body.usernameChangesRemaining, 1); // default limit 2, used 1

    // Witness access (issued under the OLD username) still routes, and
    // access-info now reports the NEW canonical username.
    const old = await coreRequest.get('/' + formerUsername + '/access-info').set('Authorization', witnessToken);
    assert.equal(old.status, 200, 'old username must still route: ' + JSON.stringify(old.body));
    assert.equal(old.body.user.username, newUsername, 'reports the latest active username');

    // The new username also routes.
    const fresh = await coreRequest.get('/' + newUsername + '/access-info').set('Authorization', witnessToken);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.user.username, newUsername);
  });

  it('[UC02] rejects the current username', async function () {
    const prior = await coreRequest
      .post('/' + username + '/account/change-username')
      .set('Authorization', personalToken)
      .send({ newUsername: username }); // same as current
    assert.equal(prior.status, 400, JSON.stringify(prior.body));
  });

  it('[UC03] reports change usage via account/username-changes', async function () {
    await firstChange();
    const res = await coreRequest.get('/' + username + '/account/username-changes').set('Authorization', personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.usernameChangesLimit, 2);
    assert.equal(res.body.usernameChangesUsed, 1);
    assert.equal(res.body.usernameChangesRemaining, 1);
  });

  it('[UC04] enforces the change limit (default 2)', async function () {
    await firstChange();
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

  // The webhooks service listens for an account's changes under its username:
  // after a change it must stop listening under the former name and load the
  // webhooks again under the new one.
  it('[CUWH1] a username change moves the account\'s webhooks to the new name in the webhooks service', async function () {
    const { uname } = await freshUser();
    const token = await login(uname);
    // webhooks belong to app accesses
    const app = await coreRequest.post('/' + uname + '/accesses').set('Authorization', token)
      .send({ name: 'cuwh1', type: 'app', permissions: [{ streamId: 's0', level: 'read' }] });
    assert.equal(app.status, 201, JSON.stringify(app.body));
    const created = await coreRequest.post('/' + uname + '/webhooks').set('Authorization', app.body.access.token)
      .send({ url: 'https://hooks.example.com/cuwh1' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const webhookId = created.body.webhook.id;
    const signals = [];
    const onStop = (msg) => signals.push(['stop', msg.username, msg.webhook.id]);
    const onLoad = (msg) => signals.push(['load', msg.username, msg.webhook.id]);
    pubsub.webhooks.on(pubsub.WEBHOOKS_DELETE, onStop);
    pubsub.webhooks.on(pubsub.WEBHOOKS_CREATE, onLoad);
    const newUsername = ('e' + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    let res;
    try {
      res = await changeUsername(uname, newUsername, token);
    } finally {
      pubsub.webhooks.off(pubsub.WEBHOOKS_DELETE, onStop);
      pubsub.webhooks.off(pubsub.WEBHOOKS_CREATE, onLoad);
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(signals, [['stop', uname, webhookId], ['load', newUsername, webhookId]]);
  });
});
