/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, withInjectedConfig */

const { pubsub } = require('messages');

const PASSWORD = 'test-password-1';
const APP_ID = 'pryv-test-no-cors'; // trusted for any origin in test-config

function freshName (prefix = 'u') {
  return (prefix + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

async function freshUser (prefix) {
  const uname = freshName(prefix);
  const fu = await getNewFixture().user(uname, { password: PASSWORD });
  return { uname, fu, userId: fu.attrs.id, email: fu.attrs.email };
}

async function login (uname) {
  const res = await coreRequest
    .post('/' + uname + '/auth/login')
    .send({ username: uname, password: PASSWORD, appId: APP_ID });
  assert.equal(res.status, 200, 'login: ' + JSON.stringify(res.body));
  return res.body.token;
}

function changeUsername (addressedName, newUsername, token) {
  return coreRequest
    .post('/' + addressedName + '/account/change-username')
    .set('Authorization', token)
    .send({ newUsername });
}

describe('[UCGD] account.changeUsername: names refused, limits, trail', function () {
  let usersRepository;

  before(async function () {
    await initTests();
    await initCore();
    const { getUsersRepository } = require('business/src/users/index.ts');
    usersRepository = await getUsersRepository();
  });

  it('[UCGD1] refuses the username of another account', async function () {
    const { uname } = await freshUser('ga');
    const other = await freshUser('gb');
    const res = await changeUsername(uname, other.uname, await login(uname));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.id, 'item-already-exists');
  });

  it('[UCGD2] refuses a former username of another account', async function () {
    const other = await freshUser('gc');
    const otherNew = freshName('gd');
    const renamed = await changeUsername(other.uname, otherNew, await login(other.uname));
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const { uname } = await freshUser('ge');
    const res = await changeUsername(uname, other.uname, await login(uname));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(await usersRepository.getUserIdForUsername(other.uname), other.userId, 'the former name stays with its account');
  });

  it('[UCGD8] an account cannot take back its own former username (it stays an alias)', async function () {
    const { uname, userId } = await freshUser('gs');
    const newName = freshName('gt');
    const renamed = await changeUsername(uname, newName, await login(uname));
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const back = await changeUsername(newName, uname, await login(newName));
    assert.equal(back.status, 409, JSON.stringify(back.body));
    assert.equal(await usersRepository.getUsernameForUserId(userId), newName);
    assert.equal(await usersRepository.getUserIdForUsername(uname), userId, 'the former name still routes to the account');
  });

  it('[UCGD3] refuses a reserved name and the shape of a minted alias', async function () {
    const { uname } = await freshUser('gf');
    const token = await login(uname);
    for (const name of ['pryvreservedname', 'r-abcdefgh', 'xn--abcdefgh']) {
      const res = await changeUsername(uname, name, token);
      assert.equal(res.status, 400, name + ': ' + JSON.stringify(res.body));
      assert.equal(res.body.error.id, 'invalid-operation', name);
    }
  });

  it('[UCGD4] a former username is not free to register', async function () {
    const { uname } = await freshUser('gg');
    const res = await changeUsername(uname, freshName('gh'), await login(uname));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const check = await coreRequest.get('/reg/' + uname + '/check_username');
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.strictEqual(check.body.reserved, true, 'the former name reads taken');
    assert.strictEqual(await usersRepository.usernameExistsOnPlatform(uname), true);
  });

  it('[UCGD5] auth.usernameChangeLimit set to 0 disables the change', async function () {
    const { uname } = await freshUser('gi');
    const token = await login(uname);
    await withInjectedConfig({ auth: { usernameChangeLimit: 0 } }, async () => {
      const res = await changeUsername(uname, freshName('gj'), token);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.id, 'invalid-operation');
      const usage = await coreRequest.get('/' + uname + '/account/username-changes').set('Authorization', token);
      assert.equal(usage.status, 200, JSON.stringify(usage.body));
      assert.equal(usage.body.usernameChangesLimit, 0);
      assert.equal(usage.body.usernameChangesRemaining, 0);
    });
  });

  it('[UCGD6] the change is in the account\'s audit trail, the new name in the account history', async function () {
    const auditStorage = require('storages').auditStorage;
    assert.ok(auditStorage != null, 'audit storage is initialised: this audit test must not pass without it');
    const { uname, userId } = await freshUser('gk');
    const newName = freshName('gl');
    const res = await changeUsername(uname, newName, await login(uname));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const userDb = await auditStorage.forUser(userId);
    let entry = null;
    for (let i = 0; i < 30 && entry == null; i++) { // written asynchronously
      const events = await userDb.getEvents({ query: [] });
      entry = events.find((e) => e.content?.action === 'account.changeUsername') ?? null;
      if (entry == null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(entry != null, 'an account.changeUsername audit entry');
    // The audit entry carries no request body: the names are in the account's
    // `username` field history (one value per change).
    const userAccountStorage = await require('storage').getUserAccountStorage();
    assert.strictEqual(await userAccountStorage.getAccountField(userId, 'username'), newName);
  });

  it('[UCGD7] the account-changed notification is sent under the former and the new name', async function () {
    const { uname } = await freshUser('gm');
    const newName = freshName('gn');
    const heard = [];
    const token = await login(uname);
    const removers = [uname, newName].map((name) => pubsub.notifications.onAndGetRemovable(name, (msg) => {
      if (msg === pubsub.USERNAME_BASED_ACCOUNT_CHANGED) heard.push(name);
    }));
    let res;
    try {
      res = await changeUsername(uname, newName, token);
    } finally {
      for (const remove of removers) remove();
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(heard.sort(), [newName, uname].sort());
  });

  it('[UCGD9] the result lists the steps that did not complete in `warnings` (empty when none)', async function () {
    const clean = await freshUser('go');
    const ok = await changeUsername(clean.uname, freshName('gp'), await login(clean.uname));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.warnings, [], 'every step completed');

    const { uname } = await freshUser('gq');
    const newName = freshName('gr');
    const token = await login(uname);
    const platform = usersRepository.platform;
    const listOriginal = platform.listPlatformKvEntries;
    platform.listPlatformKvEntries = async function () { throw new Error('injected access-index failure'); };
    const webhooks = (await require('storage').getStorageLayer()).webhooks;
    const findOriginal = webhooks.find;
    webhooks.find = function (user, query, options, cb) { cb(new Error('injected webhooks failure')); };
    const series = require('storages').seriesConnection;
    assert.ok(series != null, 'series storage is initialised');
    const renameOriginal = series.renameDatabase;
    series.renameDatabase = async function () { throw new Error('injected series failure'); };
    let res;
    try {
      res = await changeUsername(uname, newName, token);
    } finally {
      platform.listPlatformKvEntries = listOriginal;
      webhooks.find = findOriginal;
      series.renameDatabase = renameOriginal;
    }
    assert.equal(res.status, 200, 'the change stands: ' + JSON.stringify(res.body));
    assert.equal(res.body.account.username, newName);
    assert.deepStrictEqual(res.body.warnings.map((w) => w.step).sort(), ['access-index', 'hf-series', 'webhooks']);
    for (const w of res.body.warnings) assert.ok(typeof w.message === 'string' && w.message.length > 0, JSON.stringify(w));
  });
});

describe('[UCLG] sign-in after a username change', function () {
  let usersRepository;
  const usersRepositoryOf = () => usersRepository;
  before(async function () {
    await initTests();
    await initCore();
    const { getUsersRepository } = require('business/src/users/index.ts');
    usersRepository = await getUsersRepository();
  });

  it('[UCLG1] signs in with the former username too, under either path', async function () {
    const { uname, userId } = await freshUser('la');
    const newName = freshName('lb');
    const res = await changeUsername(uname, newName, await login(uname));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const path of [uname, newName]) {
      const former = await coreRequest.post('/' + path + '/auth/login')
        .send({ username: uname, password: PASSWORD, appId: APP_ID });
      assert.equal(former.status, 200, path + ': ' + JSON.stringify(former.body));
      assert.ok(former.body.token, 'a session token');
      assert.ok(former.body.apiEndpoint.includes(newName), 'the endpoint carries the current username: ' + former.body.apiEndpoint);
    }
    await login(newName);
    assert.equal(await usersRepositoryOf().getUsernameForUserId(userId), newName);
  });

  it('[UCLG2] refuses a username of another account and the r- alias of an access', async function () {
    const { uname } = await freshUser('lc');
    const other = await freshUser('ld');
    const mismatch = await coreRequest.post('/' + uname + '/auth/login')
      .send({ username: other.uname, password: PASSWORD, appId: APP_ID });
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.equal(mismatch.body.error.id, 'invalid-operation');
    const token = await login(uname);
    const created = await coreRequest.post('/' + uname + '/accesses').set('Authorization', token)
      .send({ name: 'uclg2 aliased', type: 'app', randomAlias: true, permissions: [{ streamId: '*', level: 'read' }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const alias = created.body.access.alias;
    for (const path of [uname, alias]) {
      const viaAlias = await coreRequest.post('/' + path + '/auth/login')
        .send({ username: alias, password: PASSWORD, appId: APP_ID });
      assert.equal(viaAlias.status, 400, path + ': ' + JSON.stringify(viaAlias.body));
      assert.equal(viaAlias.body.error.id, 'invalid-operation');
    }
  });
});
