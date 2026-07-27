/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, getNewFixture, assert, cuid */

/**
 * [SSOLI] SSO account-linking over the REAL platform + `:_emails:` container.
 *
 * Exercises `resolveAccountForIdentity` through `buildSsoLinkDeps` against a
 * booted core (the unit `[SSOL]` suite covers the rule logic with fakes; this
 * proves the platform wiring: unique-field lookups, the `resolveLocalUsername`
 * step, `isProvedOwnership` container reads, and binding persistence — including
 * a real second platform read of the persisted binding). Runs on the default
 * core's piiMode; the hashed-vs-cleartext token composition itself is covered
 * by the deps' own callers. `-seq` because it shares the platform DB.
 */

const container = require('business/src/emails/container.ts');
const C = require('business/src/emails/constants.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getPlatform } = require('platform');
const { buildSsoLinkDeps } = require('../src/routes/ssoLinkDeps.ts');
const { resolveAccountForIdentity } = require('sso');
const timestamp = require('unix-timestamp');

describe('[SSOLI] SSO linking over the real platform', function () {
  this.timeout(30000);
  let fixtures, deps;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    deps = buildSsoLinkDeps(await getPlatform(), await getUsersRepository(), { warn: () => {} });
  });

  after(async function () { await fixtures.clean(); });

  async function makeUser (primaryEmail) {
    const username = 'sso' + cuid().toLowerCase().slice(1, 12);
    await fixtures.user(username, { email: primaryEmail });
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    return { username, userId };
  }

  // Reserve the platform email row + write a container entry with the given
  // provenance, so the address both ROUTES to the user and carries a status.
  async function addEmail (u, value, method) {
    await container.ensureContainerStream(u.userId);
    await container.reserveRow(u.username, value);
    await container.createEmailEvent(u.userId, {
      value,
      primary: false,
      status: C.STATUS_VERIFIED,
      verifiedAt: method === C.METHOD_REGISTRATION ? null : timestamp.now(),
      verificationMethod: method
    });
  }

  function identity (over) {
    return { provider: 'testidp', sub: 'sub-' + cuid(), email: null, emailVerified: true, ...over };
  }

  it('[SSOLI1] R5: proved-owned email → login + first-login binding persisted', async function () {
    const email = cuid() + '@proved.example.com';
    const u = await makeUser(cuid() + '@primary.example.com');
    await addEmail(u, email, C.METHOD_OPERATOR); // proved
    const id = identity({ email });

    const out = await resolveAccountForIdentity(deps, id);
    assert.deepEqual(out, { kind: 'login', username: u.username });
    // Binding persisted: a second resolution finds it (R4).
    const bound = await deps.getBinding(id.provider, id.sub);
    assert.strictEqual(bound, u.username, 'binding persisted to the resolved account');
  });

  it('[SSOLI2] R4: an existing binding logs in even after the address loses proof', async function () {
    const email = cuid() + '@rides.example.com';
    const u = await makeUser(cuid() + '@primary.example.com');
    await addEmail(u, email, C.METHOD_EMAIL_LINK); // proved
    const id = identity({ email });

    const first = await resolveAccountForIdentity(deps, id);
    assert.deepEqual(first, { kind: 'login', username: u.username });

    // Downgrade the container entry to asserted-only; the binding must still win.
    await container.markVerified(u.userId, email, C.METHOD_LEGACY); // not proved anymore
    const second = await resolveAccountForIdentity(deps, id);
    assert.deepEqual(second, { kind: 'login', username: u.username });
  });

  it('[SSOLI3] R6 (takeover gate): email routes to a user but is NOT proved → refuse, no binding', async function () {
    const email = cuid() + '@asserted.example.com';
    const u = await makeUser(cuid() + '@primary.example.com');
    await addEmail(u, email, C.METHOD_REGISTRATION); // asserted, NOT proved
    const id = identity({ email });

    const out = await resolveAccountForIdentity(deps, id);
    assert.deepEqual(out, { kind: 'refuse', code: 'email-not-verified' });
    assert.strictEqual(await deps.getBinding(id.provider, id.sub), null, 'no binding for an unproved match');
  });

  it('[SSOLI4] R7: email routes to nobody → refuse no-account', async function () {
    const out = await resolveAccountForIdentity(deps, identity({ email: cuid() + '@nobody.example.com' }));
    assert.deepEqual(out, { kind: 'refuse', code: 'no-account' });
  });

  it('[SSOLI5] R3: email_verified:false → refuse sso-failed (before any lookup)', async function () {
    const out = await resolveAccountForIdentity(deps, identity({ email: cuid() + '@x.example.com', emailVerified: false }));
    assert.deepEqual(out, { kind: 'refuse', code: 'sso-failed' });
  });
});
