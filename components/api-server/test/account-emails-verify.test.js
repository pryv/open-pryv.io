/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Email verification flow (Pattern C).
 *
 * The verification token is a secret mailed to the address being verified;
 * only its sha256 hash is persisted on the pending container event. The mail
 * transport is disabled in the test config, so these tests obtain the plaintext
 * token by driving the business `operations.addEmails` directly (it returns the
 * minted { value, token } pairs), then exercise both the operations layer and
 * the public POST /:username/account/verify-email endpoint.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, config */

const container = require('business/src/emails/container.ts');
const operations = require('business/src/emails/operations.ts');
const constants = require('business/src/emails/constants.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const errors = require('errors').factory;
const timestamp = require('unix-timestamp');

// A trusted app with a wildcard origin in the test config, so the public
// endpoint's trusted-app check passes without a real Origin.
const TRUSTED_APP = 'pryv-test-no-cors';

describe('[VEML] account email verification', function () {
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
    const username = 'vml' + cuid().toLowerCase().slice(1, 12);
    const token = cuid();
    const user = await fixtures.user(username, { email: primaryEmail });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    return { username, token, userId, primaryEmail };
  }

  function accountPath (username) { return '/' + username + '/account'; }

  async function opsCtx (u) {
    const usersRepository = await getUsersRepository();
    return {
      deps: { errors, usersRepository },
      ctx: { userId: u.userId, username: u.username, user: null, accessId: 'system', legacyEmail: u.primaryEmail }
    };
  }

  // Add a pending email through the business layer (bypassing the HTTP mail
  // send) and return its plaintext verification token.
  async function addPending (u, email) {
    const { deps, ctx } = await opsCtx(u);
    const minted = await operations.addEmails(deps, ctx, [email]);
    return minted[0].token;
  }

  async function getAccount (u) {
    return await coreRequest.get(accountPath(u.username)).set('Authorization', u.token);
  }

  function viewOf (res, value) {
    return res.body.account.emails.find((e) => e.value === value);
  }

  describe('[VEM1] verifyToken (operations)', function () {
    it('[VEML11] a correct token flips the email to verified (email-link) and clears the token fields', async function () {
      const u = await makeUser(cuid() + '@vp.example.com');
      const email = cuid() + '@to-verify.example.com';
      const token = await addPending(u, email);

      const value = await operations.verifyToken(u.userId, token);
      assert.strictEqual(value, email);

      const raw = await container.findRawByValue(u.userId, email);
      assert.strictEqual(raw.content.status, 'verified');
      assert.strictEqual(raw.content.verificationMethod, 'email-link');
      assert.ok(raw.content.verifiedAt != null);
      assert.strictEqual(raw.content.verificationTokenHash, null);
      assert.strictEqual(raw.content.verificationTokenExpires, null);
      assert.strictEqual(raw.content.verificationSentAt, null);

      const acc = await getAccount(u);
      assert.strictEqual(viewOf(acc, email).status, 'verified');
    });

    it('[VEML12] a wrong token verifies nothing and leaves the email pending', async function () {
      const u = await makeUser(cuid() + '@vw.example.com');
      const email = cuid() + '@wrong.example.com';
      await addPending(u, email);

      const value = await operations.verifyToken(u.userId, 'not-the-real-token');
      assert.strictEqual(value, null);
      const raw = await container.findRawByValue(u.userId, email);
      assert.strictEqual(raw.content.status, 'pending');
    });

    it('[VEML13] an expired token verifies nothing', async function () {
      const u = await makeUser(cuid() + '@ve.example.com');
      const email = cuid() + '@expired.example.com';
      const token = await addPending(u, email);
      // Push the stored expiry into the past, keeping the real hash.
      const ev = await container.findRawByValue(u.userId, email);
      await container.setContent(u.userId, ev, { verificationTokenExpires: timestamp.now(-10) });

      const value = await operations.verifyToken(u.userId, token);
      assert.strictEqual(value, null);
      const raw = await container.findRawByValue(u.userId, email);
      assert.strictEqual(raw.content.status, 'pending');
    });

    it('[VEML15] link verification is proved ownership; a legacy-set address is verified but NOT proved', async function () {
      const u = await makeUser(cuid() + '@pr.example.com');
      const linked = cuid() + '@proved.example.com';
      const token = await addPending(u, linked);
      await operations.verifyToken(u.userId, token);
      const linkedEv = await container.findRawByValue(u.userId, linked);
      assert.strictEqual(linkedEv.content.verificationMethod, 'email-link');
      assert.strictEqual(constants.isProvedOwnership(linkedEv.content), true);

      // Set an unowned address as primary through the legacy field: it becomes
      // `verified` but with method `legacy`, which is NOT proved ownership.
      const legacy = cuid() + '@unowned.example.com';
      const res = await coreRequest.put(accountPath(u.username)).set('Authorization', u.token)
        .send({ email: legacy });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const legacyEv = await container.findRawByValue(u.userId, legacy);
      assert.strictEqual(legacyEv.content.status, 'verified');
      assert.strictEqual(legacyEv.content.verificationMethod, 'legacy');
      assert.strictEqual(constants.isProvedOwnership(legacyEv.content), false);
    });

    it('[VEML14] a token from a removed-then-re-added email no longer verifies', async function () {
      const u = await makeUser(cuid() + '@vr.example.com');
      const email = cuid() + '@readd.example.com';
      const oldToken = await addPending(u, email);
      const { deps, ctx } = await opsCtx(u);
      await operations.removeEmails(deps, ctx, [email]);
      await operations.addEmails(deps, ctx, [email]); // fresh event, fresh token

      const value = await operations.verifyToken(u.userId, oldToken);
      assert.strictEqual(value, null, 'the stale token must not verify the re-added address');
      const raw = await container.findRawByValue(u.userId, email);
      assert.strictEqual(raw.content.status, 'pending');
    });
  });

  describe('[VEM2] resend + cooldown (operations)', function () {
    it('[VEML21] a resend inside the cooldown window is refused with retryAfterSeconds', async function () {
      const u = await makeUser(cuid() + '@rc.example.com');
      const email = cuid() + '@cooldown.example.com';
      await addPending(u, email);
      const { deps, ctx } = await opsCtx(u);
      try {
        await operations.resendVerification(deps, ctx, email);
        assert.fail('expected a cooldown rejection');
      } catch (err) {
        assert.strictEqual(err.id, 'invalid-operation');
        assert.ok(err.data && typeof err.data.retryAfterSeconds === 'number');
      }
    });

    it('[VEML22] a resend past the cooldown rotates the token: the old dies, the new verifies', async function () {
      const saved = config.get('account:emailVerification:resendCooldownMs');
      config.set('account:emailVerification:resendCooldownMs', 0);
      try {
        const u = await makeUser(cuid() + '@rr.example.com');
        const email = cuid() + '@rotate.example.com';
        const oldToken = await addPending(u, email);
        const { deps, ctx } = await opsCtx(u);
        const { token: newToken } = await operations.resendVerification(deps, ctx, email);
        assert.notStrictEqual(newToken, oldToken);

        assert.strictEqual(await operations.verifyToken(u.userId, oldToken), null, 'old token rotated out');
        assert.strictEqual(await operations.verifyToken(u.userId, newToken), email);
      } finally {
        config.set('account:emailVerification:resendCooldownMs', saved);
      }
    });

    it('[VEML24] the persistent send-throttle is first-writer-wins and survives release', async function () {
      const u = await makeUser(cuid() + '@th.example.com');
      const email = cuid() + '@throttle.example.com';
      // First reservation succeeds; an immediate repeat for the same
      // (account, address) is throttled even across a container remove/re-add
      // (the marker lives in PlatformDB, not on the event).
      assert.strictEqual(await operations.reserveSendSlot(u.userId, email), true);
      assert.strictEqual(await operations.reserveSendSlot(u.userId, email), false);
      // A different address for the same account is independent.
      assert.strictEqual(await operations.reserveSendSlot(u.userId, cuid() + '@other.example.com'), true);
      // Releasing (a failed delivery) frees the slot again.
      await operations.releaseSendSlot(u.userId, email);
      assert.strictEqual(await operations.reserveSendSlot(u.userId, email), true);
    });

    it('[VEML23] a resend on an already-verified email is refused', async function () {
      const u = await makeUser(cuid() + '@rv.example.com');
      const email = cuid() + '@already.example.com';
      const token = await addPending(u, email);
      await operations.verifyToken(u.userId, token);
      const { deps, ctx } = await opsCtx(u);
      try {
        await operations.resendVerification(deps, ctx, email);
        assert.fail('expected an already-verified rejection');
      } catch (err) {
        assert.strictEqual(err.id, 'invalid-operation');
      }
    });
  });

  describe('[VEM3] public POST /account/verify-email', function () {
    function verifyPath (username) { return '/' + username + '/account/verify-email'; }

    it('[VEML31] a valid token verifies the email over HTTP and returns it', async function () {
      const u = await makeUser(cuid() + '@hv.example.com');
      const email = cuid() + '@http-verify.example.com';
      const token = await addPending(u, email);

      const res = await coreRequest.post(verifyPath(u.username))
        .set('Origin', 'http://test.pryv.local')
        .send({ appId: TRUSTED_APP, token });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.email, email);

      const acc = await getAccount(u);
      assert.strictEqual(viewOf(acc, email).status, 'verified');
    });

    it('[VEML32] a bad token returns a uniform invalid-access-token error', async function () {
      const u = await makeUser(cuid() + '@hb.example.com');
      const email = cuid() + '@http-bad.example.com';
      await addPending(u, email);

      const res = await coreRequest.post(verifyPath(u.username))
        .set('Origin', 'http://test.pryv.local')
        .send({ appId: TRUSTED_APP, token: 'wrong-token' });
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-access-token');
    });

    it('[VEML33] a token minted for another account cannot verify against this path', async function () {
      const victim = await makeUser(cuid() + '@hx-a.example.com');
      const attacker = await makeUser(cuid() + '@hx-b.example.com');
      const email = cuid() + '@cross.example.com';
      const victimToken = await addPending(victim, email);

      const res = await coreRequest.post(verifyPath(attacker.username))
        .set('Origin', 'http://test.pryv.local')
        .send({ appId: TRUSTED_APP, token: victimToken });
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
      // The victim's email stays pending.
      const raw = await container.findRawByValue(victim.userId, email);
      assert.strictEqual(raw.content.status, 'pending');
    });

    it('[VEML34] account.update {emails:{resend}} rotates the token (old link dies)', async function () {
      const saved = config.get('account:emailVerification:resendCooldownMs');
      config.set('account:emailVerification:resendCooldownMs', 0);
      try {
        const u = await makeUser(cuid() + '@hr.example.com');
        const email = cuid() + '@http-resend.example.com';
        const oldToken = await addPending(u, email);

        const res = await coreRequest.put(accountPath(u.username)).set('Authorization', u.token)
          .send({ emails: { resend: [email] } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        // The old token no longer verifies (rotated out by the resend).
        assert.strictEqual(await operations.verifyToken(u.userId, oldToken), null);
        const raw = await container.findRawByValue(u.userId, email);
        assert.strictEqual(raw.content.status, 'pending');
      } finally {
        config.set('account:emailVerification:resendCooldownMs', saved);
      }
    });
  });
});
