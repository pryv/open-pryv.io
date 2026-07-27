/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Multiple emails — end-to-end lifecycle (Pattern C).
 *
 * Walks one account through the whole feature: start with the founding email,
 * add a second, verify it by its mailed token, promote it to primary, confirm
 * both addresses still resolve the account for routing, and confirm the
 * password-reset recipient (the singular `email` field) followed the primary.
 * The verification token is obtained through the business layer (it stands in
 * for the out-of-band mailed link; the transport is disabled in the test env).
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const container = require('business/src/emails/container.ts');
const operations = require('business/src/emails/operations.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getPlatform } = require('platform');

describe('[EMLE] account emails — end-to-end lifecycle', function () {
  this.timeout(30000);
  let fixtures;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });

  after(async function () {
    await fixtures.clean();
  });

  function accountPath (username) { return '/' + username + '/account'; }

  it('[EMLE01] register → add → verify → setPrimary → routing → reset follows the new primary', async function () {
    const e1 = cuid() + '@founding.example.com';
    const username = 'e2e' + cuid().toLowerCase().slice(1, 12);
    const token = cuid();
    const user = await fixtures.user(username, { email: e1 });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    const platform = await getPlatform();

    const get = () => coreRequest.get(accountPath(username)).set('Authorization', token);
    const put = (body) => coreRequest.put(accountPath(username)).set('Authorization', token).send(body);

    // 1. Founding email is the verified (registration) primary.
    let acc = await get();
    assert.strictEqual(acc.body.account.email, e1);
    const foundingView = acc.body.account.emails.find((e) => e.value === e1);
    assert.strictEqual(foundingView.primary, true);
    assert.strictEqual(foundingView.status, 'verified');
    assert.strictEqual(foundingView.verificationMethod, 'registration');

    // 2. Add a second email (through the business layer, capturing the token
    //    that a real deployment would have mailed). It starts pending.
    const e2 = cuid() + '@second.example.com';
    const deps = { errors: require('errors').factory, usersRepository };
    const ctx = { userId, username, user: null, accessId: 'system', legacyEmail: e1 };
    const [{ token: verifyToken }] = await operations.addEmails(deps, ctx, [e2]);
    acc = await get();
    assert.strictEqual(acc.body.account.emails.find((e) => e.value === e2).status, 'pending');

    // 3. Verify it over the public endpoint → proved (email-link).
    const verifyRes = await coreRequest.post(accountPath(username) + '/verify-email')
      .set('Origin', 'http://test.pryv.local')
      .send({ appId: 'pryv-test-no-cors', token: verifyToken });
    assert.strictEqual(verifyRes.status, 200, JSON.stringify(verifyRes.body));
    assert.strictEqual(verifyRes.body.email, e2);
    const verifiedEv = await container.findRawByValue(userId, e2);
    assert.strictEqual(verifiedEv.content.status, 'verified');
    assert.strictEqual(verifiedEv.content.verificationMethod, 'email-link');
    assert.ok(verifiedEv.content.verifiedAt != null, 'a real verification stamps a time');

    // 4. Promote it to primary. The founding email stays as a verified secondary.
    const spRes = await put({ emails: { setPrimary: e2 } });
    assert.strictEqual(spRes.status, 200, JSON.stringify(spRes.body));
    acc = await get();
    assert.strictEqual(acc.body.account.email, e2, 'singular field followed the new primary');
    assert.strictEqual(acc.body.account.emails.find((e) => e.value === e2).primary, true);
    const oldPrimary = acc.body.account.emails.find((e) => e.value === e1);
    assert.strictEqual(oldPrimary.primary, false);
    assert.strictEqual(oldPrimary.status, 'verified');

    // 5. Both addresses still resolve the account for routing (auth.cores).
    const ownerE1 = await platform.getUsersUniqueField('email', e1);
    const ownerE2 = await platform.getUsersUniqueField('email', e2);
    assert.ok(ownerE1 != null, 'founding email still routes');
    assert.ok(ownerE2 != null, 'new primary routes');
    assert.strictEqual(ownerE1, ownerE2, 'both resolve to the same account');

    // 6. The password-reset recipient is the singular `email` field, which now
    //    equals the new primary — so a reset mails the new primary.
    const business = await usersRepository.getUserByUsername(username);
    assert.strictEqual(business.email, e2, 'reset-mail recipient followed the primary');
  });
});
