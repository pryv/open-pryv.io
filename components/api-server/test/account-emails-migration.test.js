/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Multiple emails — migration / compatibility (Pattern C).
 *
 * There is NO eager data backfill: an account created before the feature has a
 * singular `email` field + its platform row but an EMPTY `:_emails:` container.
 * `account.get` synthesizes the primary from the legacy field, and the first
 * `emails` mutation seeds the container (ensureSeeded). These tests pin that
 * upgrade path AND the platform-integrity cross-check that validates leftover
 * email rows against the container.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const container = require('business/src/emails/container.ts');
const operations = require('business/src/emails/operations.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getPlatform } = require('platform');

describe('[EMLM] account emails — migration / compat', function () {
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

  async function makeUser (primaryEmail) {
    const username = 'mig' + cuid().toLowerCase().slice(1, 12);
    const token = cuid();
    const user = await fixtures.user(username, { email: primaryEmail });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    return { username, token, userId, primaryEmail };
  }

  async function opsCtx (u) {
    const usersRepository = await getUsersRepository();
    return {
      deps: { errors: require('errors').factory, usersRepository },
      ctx: { userId: u.userId, username: u.username, user: null, accessId: 'system', legacyEmail: u.primaryEmail }
    };
  }

  // checkIntegrity is global; scope assertions to this test's username.
  async function integrityErrorsFor (username) {
    const platform = await getPlatform();
    const res = await platform.checkIntegrity();
    return res.errors.filter((e) => e.includes(username));
  }

  describe('[EMLM0] upgrade path (lazy seed)', function () {
    it('[EMLM01] a pre-feature user synthesizes its primary and seeds the container idempotently on mutation', async function () {
      const email = cuid() + '@premig.example.com';
      const u = await makeUser(email);
      // Pre-feature state: empty container.
      assert.strictEqual((await container.getRawEvents(u.userId)).length, 0);

      // account.get synthesizes the primary from the legacy field.
      const acc = await coreRequest.get('/' + u.username + '/account').set('Authorization', u.token);
      const primaryView = acc.body.account.emails.find((e) => e.value === email);
      assert.strictEqual(primaryView.primary, true);
      assert.strictEqual(primaryView.status, 'verified');
      assert.strictEqual(primaryView.verificationMethod, 'registration');

      // First mutation seeds the container: exactly one primary event (method
      // registration) plus the added secondary.
      const { deps, ctx } = await opsCtx(u);
      await operations.addEmails(deps, ctx, [cuid() + '@sec.example.com']);
      let raw = await container.getRawEvents(u.userId);
      let primaries = raw.filter((e) => e.content.primary === true);
      assert.strictEqual(primaries.length, 1, 'exactly one seeded primary');
      assert.strictEqual(primaries[0].content.value, email);
      assert.strictEqual(primaries[0].content.verificationMethod, 'registration');

      // A further mutation does not re-seed a second primary.
      await operations.addEmails(deps, ctx, [cuid() + '@sec2.example.com']);
      raw = await container.getRawEvents(u.userId);
      primaries = raw.filter((e) => e.content.primary === true);
      assert.strictEqual(primaries.length, 1, 'ensureSeeded stays idempotent');
    });
  });

  describe('[EMLM1] platform-integrity email cross-check', function () {
    it('[EMLM10] a pre-feature user (one row, empty container) passes cleanly', async function () {
      const u = await makeUser(cuid() + '@clean1.example.com');
      assert.strictEqual((await container.getRawEvents(u.userId)).length, 0);
      assert.deepStrictEqual(await integrityErrorsFor(u.username), []);
    });

    it('[EMLM11] a multi-email user whose rows match its container passes cleanly', async function () {
      const u = await makeUser(cuid() + '@clean2.example.com');
      const { deps, ctx } = await opsCtx(u);
      await operations.addEmails(deps, ctx, [cuid() + '@sec-a.example.com', cuid() + '@sec-b.example.com']);
      assert.deepStrictEqual(await integrityErrorsFor(u.username), []);
    });

    it('[EMLM12] an email platform row with no container record is flagged', async function () {
      const u = await makeUser(cuid() + '@orphan.example.com');
      const ghost = cuid() + '@ghost.example.com';
      // Reserve an email row directly, with no container event behind it.
      // (errors are scoped to this username; the row value in the message is
      // the platform token form — HMAC under hashed mode — so assert on the
      // stable message, not the cleartext value.)
      assert.strictEqual(await container.reserveRow(u.username, ghost), true);
      try {
        const errs = await integrityErrorsFor(u.username);
        assert.ok(errs.some((e) => e.includes('no matching email on the account')),
          'expected an orphan-row error for this user: ' + JSON.stringify(errs));
      } finally {
        await container.releaseRow(u.username, ghost); // keep the env integrity-clean
      }
    });

    it('[EMLM13] a container email whose platform row was lost is flagged (leftover triggers the check)', async function () {
      const u = await makeUser(cuid() + '@rev.example.com');
      const { deps, ctx } = await opsCtx(u);
      const s1 = cuid() + '@rev-s1.example.com';
      const s2 = cuid() + '@rev-s2.example.com';
      await operations.addEmails(deps, ctx, [s1, s2]);
      // Drop s2's platform row directly, leaving its container event orphaned;
      // s1 remains as the leftover that triggers the container fetch.
      assert.strictEqual(await container.releaseRow(u.username, s2), true);
      try {
        const errs = await integrityErrorsFor(u.username);
        assert.ok(errs.some((e) => e.includes('no matching row in the platform db')),
          'expected a reverse-orphan error: ' + JSON.stringify(errs));
      } finally {
        await container.reserveRow(u.username, s2); // restore consistency
      }
    });
  });
});
