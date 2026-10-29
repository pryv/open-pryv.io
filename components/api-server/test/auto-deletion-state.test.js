/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ADKR] auto-deletion state on the real user-account storage (run on each
 * base engine): the setting keeps its versions and clears to null, the
 * bookkeeping row is replaced in place, the identity is erased with every
 * version, and none of it shows up as account data.
 */

const crypto = require('node:crypto');
const { createAutoDeletionState, SETTING_FIELD, IDENTITY_FIELD } = require('business/src/autoDeletion/state.ts');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[ADKR] auto-deletion state storage', function () {
  this.timeout(20000);

  let storage;
  let state;

  before(async function () {
    await initTests();
    await initCore();
    storage = require('storages').userAccountStorage;
    state = createAutoDeletionState(storage);
  });

  async function freshUser () {
    const username = ('adkr' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await getNewFixture().user(username);
    const access = await fu.access({ type: 'personal', token: cuid() });
    await fu.session(access.attrs.token);
    return { userId: fu.attrs.id, username, token: access.attrs.token };
  }

  it('[ADKR1] the setting keeps its versions and clears to null', async function () {
    const { userId } = await freshUser();
    assert.equal(await state.getSetting(userId), null);
    const setting = { mode: 'inactivity', inactivityDays: 365, action: 'delete', updatedAt: 1 };
    await state.setSetting(userId, setting, 'acc1');
    assert.deepEqual(await state.getSetting(userId), setting);
    await state.setSetting(userId, null, 'acc1');
    assert.equal(await state.getSetting(userId), null);
    const history = await storage.getAccountFieldHistory(userId, SETTING_FIELD);
    assert.equal(history.length, 2);
  });

  it('[ADKR2] the bookkeeping row is replaced in place and removed by null', async function () {
    const { userId } = await freshUser();
    const b1 = { appliedPolicy: { source: 'operator', mode: 'inactivity', inactivityDays: 365 }, policyAppliedAt: 1, lastActivity: { personal: 1, app: null, delegate: null, max: 1, by: 'owner' }, deadline: 1000000, reminders: { deadlineDay: null, sent: [] } };
    assert.equal(await state.saveBookkeeping(userId, null, b1), true);
    const b2 = { ...b1, reminders: { deadlineDay: 11, sent: [{ leadDays: 60, at: 2 }] } };
    assert.equal(await state.saveBookkeeping(userId, b1, b2), true);
    assert.deepEqual(await state.getBookkeeping(userId), b2);
    assert.equal(await state.saveBookkeeping(userId, b2, null), true);
    assert.equal(await state.getBookkeeping(userId), null);
  });

  it('[ADKR3] the identity is erased with every version', async function () {
    const { userId } = await freshUser();
    const key = crypto.randomBytes(32);
    await state.setIdentity(userId, { name: 'Ada Lovelace' }, key, 'acc1');
    await state.setIdentity(userId, { name: 'Ada King', dateOfBirth: '1815-12-10' }, key, 'acc1');
    assert.equal((await storage.getAccountFieldHistory(userId, IDENTITY_FIELD)).length, 1);
    assert.deepEqual(await state.getIdentity(userId, key), { name: 'Ada King', dateOfBirth: '1815-12-10' });
    await state.eraseIdentity(userId);
    assert.equal(await state.getIdentity(userId, key), null);
    assert.equal((await storage.getAccountFieldHistory(userId, IDENTITY_FIELD)).length, 0);
  });

  it('[ADKR4] none of it is account data an access can read', async function () {
    const { userId, username, token } = await freshUser();
    await state.setSetting(userId, { mode: 'date', date: 2000000000, action: 'delete', updatedAt: 1 }, 'acc1');
    await state.setIdentity(userId, { name: 'Ada Lovelace' }, crypto.randomBytes(32), 'acc1');
    const res = await coreRequest.get('/' + username + '/events').set('Authorization', token).query({ streams: [':_system:account'], limit: 1000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.events.length > 0, 'the account fields are readable');
    const text = JSON.stringify(res.body.events);
    assert.ok(!text.includes('autoDeletion') && !text.includes('Lovelace'), text);
  });
});
