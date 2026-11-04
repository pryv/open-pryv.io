/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [EMCI] in cleartext piiMode the platform keys an email row by the address
 * as written, so `user@x`, `User@x` and `USER@x` are three rows; the email is
 * still compared in any case (and without surrounding spaces), as hashed mode
 * compares it: registration, an email change and the emails container refuse
 * an address another account holds in another case, and no reset mail goes
 * to such an address. The core's platform is switched to cleartext mode for
 * each test (the test harness runs it hashed), over the same platform store.
 */

/* global initTests, initCore, coreRequest, assert, cuid */

const nock = require('nock');
const { useNock } = require('test-helpers/src/nockScope.ts');
const { withInjectedConfig } = require('test-helpers');
const { getConfig } = require('@pryv/boiler');
const { getUsersRepository } = require('business/src/users/index.ts');
const { PiiHasher } = require('platform/src/PiiHasher.ts');

const TRUSTED_APP = 'pryv-test-no-cors';

describe('[EMCI] email compared in any case in cleartext piiMode', function () {
  this.timeout(60000);
  useNock();

  let platform, platformDB, usersRepository, config;
  // Accounts and rows a test made (cleartext form), removed before the platform goes back to hashed mode.
  let made, rows;

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();
    platform = require('platform').platform;
    platformDB = require('storages').platformDB;
    usersRepository = await getUsersRepository();
  });

  beforeEach(function () {
    made = [];
    rows = [];
    platform._setDependenciesForTests(platformDB, null);
    assert.strictEqual(platform.piiModeIsHashed, false, 'cleartext mode');
  });

  afterEach(async function () {
    try {
      for (const u of made) {
        if (await usersRepository.getUserIdForUsername(u.username) != null) await usersRepository.deleteOne(u.id, u.username);
      }
      for (const value of rows) await platformDB.deleteUserUniqueField('email', value);
    } finally {
      platform._setDependenciesForTests(platformDB, new PiiHasher(config.get('platform:piiHmacKey'), config.get('platform:piiAlgorithm') || undefined));
      nock.cleanAll();
    }
  });

  const slug = () => cuid().toLowerCase().slice(1, 11);

  /** Another account's row for `value` (cleartext form: the address as written). */
  async function heldByAnother (value) {
    rows.push(value);
    await platformDB.setUserUniqueField('emciholder' + slug(), 'email', value);
  }

  function register (username, email) {
    return coreRequest.post('/users').send({
      appId: 'test-emails',
      username,
      password: 'testpassw0rd',
      email,
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en'
    });
  }

  async function registered (email) {
    const username = 'emci' + slug();
    const res = await register(username, email);
    assert.ok(res.status === 201 || res.status === 200, `registration: ${res.status} ${JSON.stringify(res.body)}`);
    const u = { username, id: await usersRepository.getUserIdForUsername(username), email };
    made.push(u);
    return u;
  }

  it('[EMCI1] registration refuses an address another account holds in another case', async function () {
    const local = 'emci1-' + slug();
    await heldByAnother(local + '@case.example');
    for (const spelling of [local.toUpperCase() + '@CASE.EXAMPLE', 'E' + local.slice(1) + '@Case.example']) {
      const username = 'emci' + slug();
      const res = await register(username, spelling);
      assert.strictEqual(res.status, 409, spelling + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.error?.id, 'item-already-exists', JSON.stringify(res.body));
      assert.ok(Object.keys(res.body.error?.data ?? {}).includes('email'), JSON.stringify(res.body));
      assert.ok(await usersRepository.getUserIdForUsername(username) == null, 'not created: ' + spelling);
      assert.strictEqual(await platformDB.getUsersUniqueField('email', spelling), null, 'no row for ' + JSON.stringify(spelling));
    }
    // Another address, and its own spelling: registered.
    const u = await registered('Emci1-' + slug() + '@Case.example');
    assert.strictEqual(await platformDB.getUsersUniqueField('email', u.email), u.username);
  });

  it('[EMCI2] an email change and the emails container refuse an address another account holds in another case; another case of its own address is accepted', async function () {
    const u = await registered('emci2-' + slug() + '@case.example');
    const held = 'emci2h-' + slug() + '@case.example';
    await heldByAnother(held);

    await assert.rejects(() => platform.updateUser(u.username, [{ action: 'update', key: 'email', value: held.toUpperCase(), previousValue: u.email, isUnique: true, isActive: true }]),
      (err) => err.id === 'item-already-exists', 'an email change to another case of a held address');
    assert.strictEqual(await platformDB.getUsersUniqueField('email', u.email), u.username, 'the account keeps its address');
    assert.strictEqual(await platform.reserveUserUniqueValue(u.username, 'email', 'E' + held.slice(1)), false, 'the emails container cannot add it');

    // Its own address in another case.
    const own = u.email.toUpperCase();
    rows.push(own);
    await platform.updateUser(u.username, [{ action: 'update', key: 'email', value: own, previousValue: u.email, isUnique: true, isActive: true }]);
    assert.strictEqual(await platformDB.getUsersUniqueField('email', own), u.username);
    assert.strictEqual(await platformDB.getUsersUniqueField('email', u.email), null, 'the previous spelling is released');
    await platform.updateUser(u.username, [{ action: 'update', key: 'email', value: u.email, previousValue: own, isUnique: true, isActive: true }]);
  });

  it('[EMCI3] no reset mail goes to an address another account holds in another case than the three looked at before', async function () {
    // The account holds its own spelling; another account a spelling that is
    // neither it, nor its lowercase, nor its normalised form.
    const u = await registered('Emci3-' + slug() + '@Reset.example.com');
    const captured = [];
    nock('https://mandrillapp.local').post('/api/1.0/messages/send-template.json').times(2)
      .reply(200, (uri, body) => { captured.push(body); return {}; });
    const request = () => withInjectedConfig({
      services: { email: { enabled: { resetPassword: true } } },
      auth: { passwordResetPageURL: 'https://app.example.com/reset-password' }
    }, async () => await coreRequest.post('/' + u.username + '/account/request-password-reset').send({ appId: TRUSTED_APP }));

    const sent = await request();
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(captured.length, 1, 'sent while no other account holds the address');
    // A second request within the minute is otherwise refused.
    await require('business/src/auth/passwordResetThrottle.ts').clearPasswordResetThrottle(u.id);

    await heldByAnother(u.email.toUpperCase());
    const held = await request();
    assert.strictEqual(held.status, 200, JSON.stringify(held.body));
    assert.strictEqual(captured.length, 1, 'no mail to the address another account holds in another case');
  });
});
