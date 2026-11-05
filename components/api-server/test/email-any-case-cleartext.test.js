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
const { getUsersRepository } = require('business/src/users/index.ts');

const TRUSTED_APP = 'pryv-test-no-cors';

describe('[EMCI] email compared in any case in cleartext piiMode', function () {
  this.timeout(60000);
  useNock();

  let platform, platformDB, usersRepository, originalHasher;
  // Accounts and rows a test made (cleartext form), removed before the platform goes back to its mode.
  let made, rows;

  before(async function () {
    await initTests();
    await initCore();
    platform = require('platform').platform;
    platformDB = require('storages').platformDB;
    usersRepository = await getUsersRepository();
    // The platform's own hasher (null when the run is in cleartext mode), put back after each test.
    originalHasher = platform._piiHasherForTests();
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
      platform._setDependenciesForTests(platformDB, originalHasher);
      nock.cleanAll();
    }
  });

  const slug = () => cuid().toLowerCase().slice(1, 11);

  /** Another account's row for `value` (cleartext form: the address as written). */
  async function heldByAnother (value) {
    rows.push(value);
    const holder = 'emciholder' + slug();
    await platformDB.setUserUniqueField(holder, 'email', value);
    return holder;
  }

  /** Counts the platform store's reads of the email rows (the whole-field read, the any-case query) while `fn` runs. */
  async function countEmailScans (fn) {
    const counts = { whole: 0, anyCase: 0 };
    const saved = ['getAllWithPrefix', 'getUsersUniqueFieldAnyCase'].map((m) => [m, Object.getOwnPropertyDescriptor(platformDB, m)]);
    const getAllWithPrefix = platformDB.getAllWithPrefix;
    const getUsersUniqueFieldAnyCase = platformDB.getUsersUniqueFieldAnyCase;
    platformDB.getAllWithPrefix = function (prefix) {
      if (prefix === 'user-unique/email/') counts.whole++;
      return getAllWithPrefix.call(this, prefix);
    };
    platformDB.getUsersUniqueFieldAnyCase = function (field, value) {
      if (field === 'email') counts.anyCase++;
      return getUsersUniqueFieldAnyCase.call(this, field, value);
    };
    try {
      await fn();
    } finally {
      for (const [m, descriptor] of saved) {
        if (descriptor != null) Object.defineProperty(platformDB, m, descriptor);
        else delete platformDB[m];
      }
    }
    return counts;
  }

  it('[EMCI7] an auto-deletion pass reads the email rows once, not once per account, and judges each address as the per-account check does', async function () {
    const { createPassFactsLoader, createAccountAutoDeletionSweep } = require('api-server/src/methods/helpers/autoDeletionSweep.ts');
    const { isEmailHeldByAnother } = require('business/src/emails/heldAddress.ts');
    const { AUTO_DELETION_DEFAULTS } = require('business/src/autoDeletion/config.ts');
    const config = await require('@pryv/boiler').getConfig();
    const held = await registered('Emci7h-' + slug() + '@Case.example');
    await heldByAnother(held.email.toUpperCase());
    const free = await registered('emci7f-' + slug() + '@case.example');
    const own = await registered('EMCI7O-' + slug() + '@case.example');
    const accounts = [held, free, own].map((u) => ({ id: u.id, username: u.username }));

    // The facts of one pass, account after account, against the per-account check.
    const loader = createPassFactsLoader(config, () => Date.now() / 1000);
    const facts = [];
    const counts = await countEmailScans(async () => {
      loader.beginPass();
      for (const a of accounts) facts.push(await loader.loadFacts(a));
    });
    assert.deepStrictEqual(counts, { whole: 1, anyCase: 0 }, 'one read of the email rows for the pass');
    assert.strictEqual(facts[0].mail, 'no-email', 'mail is configured in the test core: ' + JSON.stringify(facts[0]));
    const perAccount = [];
    for (const u of [held, free, own]) perAccount.push(await isEmailHeldByAnother(platform, u.username, u.email));
    assert.deepStrictEqual(facts.map((f) => f.emailHeld), perAccount);
    assert.deepStrictEqual(perAccount, [true, false, false]);
    // A new pass reads them again (an address that changed hands since is seen).
    const again = await countEmailScans(async () => {
      loader.beginPass();
      await loader.loadFacts(accounts[1]);
      await loader.loadFacts(accounts[2]);
    });
    assert.deepStrictEqual(again, { whole: 1, anyCase: 0 });

    // The sweep itself (dry run, a preset that evaluates every account): one read per pass.
    const sweep = await createAccountAutoDeletionSweep(config, {
      getConfig: () => ({ ...AUTO_DELETION_DEFAULTS, dryRun: true, inactivity: { ...AUTO_DELETION_DEFAULTS.inactivity, defaultDays: 365 } }),
      listAccounts: async () => accounts,
      listPendingErasures: async () => [],
      logger: { info () {}, warn () {}, error () {}, debug () {} }
    });
    const sweepCounts = await countEmailScans(async () => {
      const result = await sweep.runPass();
      assert.strictEqual(result.failed, 0, JSON.stringify(result));
    });
    assert.deepStrictEqual(sweepCounts, { whole: 1, anyCase: 0 });
  });

  it('[EMCI6] the email reconcile names the other holder of an address held in another case, with its spelling', async function () {
    const u = await registered('Emci6-' + slug() + '@Case.example');
    const holder = await heldByAnother(u.email.toLowerCase());
    const summary = await usersRepository.reconcileEmailRows(true);
    assert.ok(summary.heldElsewhere.includes(u.username), JSON.stringify(summary));
    assert.deepStrictEqual(summary.heldBy[u.username], [{ holder, spelling: u.email.toLowerCase() }]);
  });

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
    const u = { username, id: await usersRepository.getUserIdForUsername(username), email, token: res.body.apiEndpoint.split('//')[1].split('@')[0] };
    made.push(u);
    return u;
  }

  it('[EMCI4] adding an address another account holds in another case is refused through the API: no pending address, no verification token', async function () {
    const container = require('business/src/emails/container.ts');
    const u = await registered('emci4-' + slug() + '@case.example');
    const held = 'emci4h-' + slug() + '@case.example';
    await heldByAnother(held);
    const spelling = held.toUpperCase();
    const res = await coreRequest.put('/' + u.username + '/account').set('Authorization', u.token).send({ emails: { add: [spelling] } });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.error?.id, 'item-already-exists', JSON.stringify(res.body));
    const values = (await container.getRawEvents(u.id)).map((e) => String(e.content?.value).toLowerCase());
    assert.ok(!values.includes(held), 'no pending event for the address: ' + JSON.stringify(values));
    // A free address is still added (the token works).
    const free = await coreRequest.put('/' + u.username + '/account').set('Authorization', u.token).send({ emails: { add: ['emci4f-' + slug() + '@case.example'] } });
    assert.strictEqual(free.status, 200, JSON.stringify(free.body));
  });

  it('[EMCI5] the availability check and the registration email challenge answer an address another account holds in another case as taken: no code mailed', async function () {
    const held = 'emci5h-' + slug() + '@case.example';
    await heldByAnother(held);
    const spelling = 'E' + held.slice(1).toUpperCase();
    const check = await coreRequest.get('/reg/' + encodeURIComponent(spelling) + '/check_email');
    assert.strictEqual(check.status, 409, JSON.stringify(check.body));
    const free = await coreRequest.get('/reg/' + encodeURIComponent('emci5f-' + slug() + '@case.example') + '/check_email');
    assert.strictEqual(free.status, 200, JSON.stringify(free.body));

    const captured = [];
    nock('https://mandrillapp.local').post('/api/1.0/messages/send-template.json').times(2)
      .reply(200, (uri, body) => { captured.push(body); return {}; });
    await withInjectedConfig({ account: { emailVerification: { requireAtRegistration: true, registrationCodeResendCooldownMs: 0 } } }, async () => {
      const refused = await coreRequest.post('/reg/email-challenge').send({ email: spelling });
      assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.error?.id, 'item-already-exists', JSON.stringify(refused.body));
      assert.strictEqual(captured.length, 0, 'no code mailed to the holder of the address');
      // The gate is on: a free address gets its code.
      const sent = await coreRequest.post('/reg/email-challenge').send({ email: 'emci5c-' + slug() + '@case.example' });
      assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
      assert.strictEqual(captured.length, 1);
    });
  });

  it('[EMCI1] registration refuses an address another account holds in another case', async function () {
    const local = 'emci1-' + slug();
    await heldByAnother(local + '@case.example');
    for (const spelling of [local.toUpperCase() + '@CASE.EXAMPLE', 'E' + local.slice(1) + '@Case.example']) {
      const username = 'emci' + slug();
      const res = await register(username, spelling);
      // Removed by the cleanup if it was created all the same.
      if (res.status < 300) made.push({ username, id: await usersRepository.getUserIdForUsername(username) });
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
