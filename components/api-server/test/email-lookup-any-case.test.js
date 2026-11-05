/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ELAC] in cleartext piiMode the lookups of the account holding an email
 * address find it in any case, as hashed mode does (one row per normalised
 * address there): the username recovery (`GET /reg/{email}/username`, `/uid`),
 * the core lookup (`GET /reg/cores?email=`), the third-party sign-in's account
 * matching, and the email reconcile, which no longer claims a second row of
 * the account's own address. When several accounts hold one address in
 * several spellings (data written before the any-case uniqueness), the one
 * spelled as asked is answered, and none when neither is. The core's platform
 * is switched to cleartext mode for each test (the test harness runs it
 * hashed), over the same platform store.
 */

/* global initTests, initCore, coreRequest, assert, cuid */

const { getUsersRepository } = require('business/src/users/index.ts');
const container = require('business/src/emails/container.ts');
const C = require('business/src/emails/constants.ts');
const { buildSsoLinkDeps } = require('../src/routes/ssoLinkDeps.ts');
const { resolveAccountForIdentity } = require('sso');

describe('[ELAC] email lookups find the address in any case in cleartext piiMode', function () {
  this.timeout(60000);

  let platform, platformDB, usersRepository, originalHasher;
  // Accounts and rows a test made (cleartext form), removed before the platform goes back to its mode.
  let made, rows;

  before(async function () {
    await initTests();
    await initCore();
    platform = require('platform').platform;
    platformDB = require('storages').platformDB;
    usersRepository = await getUsersRepository();
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
      for (const [field, value] of rows) await platformDB.deleteUserUniqueField(field, value);
    } finally {
      platform._setDependenciesForTests(platformDB, originalHasher);
    }
  });

  const slug = () => cuid().toLowerCase().slice(1, 11);

  async function registered (email) {
    const username = 'emlk' + slug();
    const res = await coreRequest.post('/users').send({
      appId: 'test-emails',
      username,
      password: 'testpassw0rd',
      email,
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en'
    });
    assert.ok(res.status === 201 || res.status === 200, `registration: ${res.status} ${JSON.stringify(res.body)}`);
    const u = { username, id: await usersRepository.getUserIdForUsername(username), email };
    made.push(u);
    rows.push(['email', email]);
    return u;
  }

  it('[ELAC1] the username recovery finds the account in another case of its address', async function () {
    const u = await registered('emlk1-' + slug() + '@case.example');
    for (const spelling of [u.email, u.email.toUpperCase(), 'E' + u.email.slice(1)]) {
      const byUsername = await coreRequest.get('/reg/' + encodeURIComponent(spelling) + '/username');
      assert.strictEqual(byUsername.status, 200, spelling + ': ' + JSON.stringify(byUsername.body));
      assert.deepStrictEqual(byUsername.body, { username: u.username });
      const byUid = await coreRequest.get('/reg/' + encodeURIComponent(spelling) + '/uid');
      assert.strictEqual(byUid.status, 200, spelling + ': ' + JSON.stringify(byUid.body));
      assert.deepStrictEqual(byUid.body, { uid: u.username });
    }
    const unknown = await coreRequest.get('/reg/' + encodeURIComponent('emlk1u-' + slug() + '@case.example') + '/username');
    assert.strictEqual(unknown.status, 404, JSON.stringify(unknown.body));
  });

  it('[ELAC2] the core lookup by email answers the account for another case of its address, not the unknown-address answer', async function () {
    const u = await registered('emlk2-' + slug() + '@case.example');
    const byName = await coreRequest.get('/reg/cores').query({ username: u.username });
    assert.strictEqual(byName.status, 200, JSON.stringify(byName.body));
    const unknown = await coreRequest.get('/reg/cores').query({ email: 'emlk2u-' + slug() + '@case.example' });
    assert.strictEqual(unknown.status, 200, JSON.stringify(unknown.body));
    assert.notDeepStrictEqual(byName.body.core, unknown.body.core, 'the account answer differs from the unknown-address one');
    for (const spelling of [u.email, u.email.toUpperCase()]) {
      const byEmail = await coreRequest.get('/reg/cores').query({ email: spelling });
      assert.strictEqual(byEmail.status, 200, spelling + ': ' + JSON.stringify(byEmail.body));
      assert.deepStrictEqual(byEmail.body.core, byName.body.core, spelling);
    }
  });

  it('[ELAC3] several accounts holding one address in two spellings: the one spelled as asked, none for a third spelling', async function () {
    const local = 'emlk3-' + slug();
    const a = 'emlkholdera' + slug();
    const b = 'emlkholderb' + slug();
    rows.push(['email', 'E' + local.slice(1) + '@case.example'], ['email', local + '@case.example']);
    await platformDB.setUserUniqueField(a, 'email', 'E' + local.slice(1) + '@case.example');
    await platformDB.setUserUniqueField(b, 'email', local + '@case.example');
    const lookup = async (spelling) => await coreRequest.get('/reg/' + encodeURIComponent(spelling) + '/username');
    assert.deepStrictEqual((await lookup(local + '@case.example')).body, { username: b });
    assert.deepStrictEqual((await lookup('E' + local.slice(1) + '@case.example')).body, { username: a });
    const neither = await lookup(local.toUpperCase() + '@case.example');
    assert.strictEqual(neither.status, 404, JSON.stringify(neither.body));
  });

  it('[ELAC4] a third-party sign-in matches a proved address given in another case; an unproved one is still refused', async function () {
    const deps = buildSsoLinkDeps(platform, usersRepository, { warn: () => {} });
    const identity = (email) => ({ provider: 'emlkidp', sub: 'sub-' + cuid(), email, emailVerified: true });
    const addEmail = async (u, value, method) => {
      rows.push(['email', value]);
      await container.ensureContainerStream(u.id);
      await container.reserveRow(u.username, value);
      await container.createEmailEvent(u.id, {
        value,
        primary: false,
        status: C.STATUS_VERIFIED,
        verifiedAt: method === C.METHOD_REGISTRATION ? null : Date.now() / 1000,
        verificationMethod: method
      });
    };

    const u = await registered('emlk4p-' + slug() + '@case.example');
    const proved = 'emlk4-' + slug() + '@case.example';
    await addEmail(u, proved, C.METHOD_OPERATOR);
    const id = identity('E' + proved.slice(1).toUpperCase());
    rows.push(['sso-' + id.provider, id.sub]);
    assert.deepStrictEqual(await resolveAccountForIdentity(deps, id), { kind: 'login', username: u.username });
    assert.strictEqual(await deps.getBinding(id.provider, id.sub), u.username, 'binding persisted');

    // The proof gate still decides: an address the account only asserted.
    const v = await registered('emlk4q-' + slug() + '@case.example');
    const asserted = 'emlk4a-' + slug() + '@case.example';
    await addEmail(v, asserted, C.METHOD_REGISTRATION);
    const unproved = identity(asserted.toUpperCase());
    assert.deepStrictEqual(await resolveAccountForIdentity(deps, unproved), { kind: 'refuse', code: 'email-not-verified' });
    assert.strictEqual(await deps.getBinding(unproved.provider, unproved.sub), null, 'no binding');
    // And the IdP must assert the address.
    assert.deepStrictEqual(await resolveAccountForIdentity(deps, { ...identity(proved.toUpperCase()), emailVerified: false }), { kind: 'refuse', code: 'sso-failed' });
  });

  it('[ELAC5] the email reconcile takes the account\'s own row in another case for its address: not missing, no second row', async function () {
    const u = await registered('Emlk5-' + slug() + '@Case.example');
    // Data written before the any-case uniqueness: the account's row spells its address in another case.
    const ownRow = u.email.toLowerCase();
    rows.push(['email', ownRow]);
    await platformDB.deleteUserUniqueField('email', u.email);
    await platformDB.setUserUniqueField(u.username, 'email', ownRow);
    const getAll = Object.getOwnPropertyDescriptor(usersRepository, 'getAllUsersIdAndName');
    usersRepository.getAllUsersIdAndName = async () => [{ id: u.id, username: u.username }];
    const pick = (s) => ({ scanned: s.scanned, missing: s.missing, claimed: s.claimed, heldElsewhere: s.heldElsewhere });
    try {
      const run = await usersRepository.reconcileEmailRows(false);
      assert.deepStrictEqual(pick(run), { scanned: 1, missing: [], claimed: [], heldElsewhere: [] }, JSON.stringify(run));
      assert.strictEqual(await platformDB.getUsersUniqueField('email', u.email), null, 'no second row in the stored spelling');
      assert.strictEqual(await platformDB.getUsersUniqueField('email', ownRow), u.username);
      const dry = await usersRepository.reconcileEmailRows(true);
      assert.deepStrictEqual(pick(dry), { scanned: 1, missing: [], claimed: [], heldElsewhere: [] }, JSON.stringify(dry));
    } finally {
      if (getAll != null) Object.defineProperty(usersRepository, 'getAllUsersIdAndName', getAll);
      else delete usersRepository.getAllUsersIdAndName;
    }
  });
});
