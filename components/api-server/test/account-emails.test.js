/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Multiple emails per account (Pattern C).
 *
 * Covers account.get with the synthesize fallback, the account.update emails
 * operations object (add / remove / setPrimary), legacy account.update {email}
 * container sync, registration seeding, and the events-API mutation guards on
 * the reserved container stream.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, config */

const container = require('business/src/emails/container.ts');
const { getUsersRepository } = require('business/src/users/index.ts');

const CONTAINER = ':_emails:';

describe('[EMLS] account emails (multiple)', function () {
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

  // Create a personal-token user with a known primary email.
  async function makeUser (primaryEmail) {
    const username = 'eml' + cuid().toLowerCase().slice(1, 12);
    const token = cuid();
    const user = await fixtures.user(username, { email: primaryEmail });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    return { username, token, userId };
  }

  function accountPath (username) { return '/' + username + '/account'; }
  function eventsPath (username) { return '/' + username + '/events'; }

  async function getAccount (u) {
    const res = await coreRequest.get(accountPath(u.username)).set('Authorization', u.token);
    return res;
  }
  async function updateAccount (u, update) {
    // The route wraps the request body into { update: body }, so the body IS
    // the update object (email, language, emails), not a wrapper around it.
    return await coreRequest.put(accountPath(u.username)).set('Authorization', u.token).send(update);
  }

  describe('[EML1] account.get', function () {
    it('[EML11] synthesizes the emails array from the legacy field when the container is empty', async function () {
      const email = cuid() + '@get-fallback.example.com';
      const u = await makeUser(email);
      // The fixture user was created via the repository, not registration, so
      // the container has not been seeded.
      const raw = await container.getRawEvents(u.userId);
      assert.strictEqual(raw.length, 0, 'container should be empty for a fixture user');

      const res = await getAccount(u);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.account.email, email);
      assert.ok(Array.isArray(res.body.account.emails));
      assert.strictEqual(res.body.account.emails.length, 1);
      const only = res.body.account.emails[0];
      assert.strictEqual(only.value, email);
      assert.strictEqual(only.primary, true);
      assert.strictEqual(only.status, 'verified');
      assert.strictEqual(only.verifiedAt, null);
      assert.strictEqual(only.verificationMethod, 'registration');
    });
  });

  describe('[EML2] add', function () {
    it('[EML21] adds pending, non-primary emails and reflects them in account.get', async function () {
      const u = await makeUser(cuid() + '@add.example.com');
      const newEmail = cuid() + '@added.example.com';
      const res = await updateAccount(u, { emails: { add: [newEmail] } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const added = res.body.account.emails.find((e) => e.value === newEmail);
      assert.ok(added, 'added email present');
      assert.strictEqual(added.primary, false);
      assert.strictEqual(added.status, 'pending');
      assert.strictEqual(added.verifiedAt, null);
      // The primary (seeded on first mutation) remains.
      assert.ok(res.body.account.emails.some((e) => e.primary === true && e.status === 'verified'));
    });

    it('[EML22] rejects an email already owned by another user with item-already-exists', async function () {
      const taken = cuid() + '@taken.example.com';
      await makeUser(taken); // user B owns `taken`
      const u = await makeUser(cuid() + '@adder.example.com');
      const res = await updateAccount(u, { emails: { add: [taken] } });
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'item-already-exists');
    });

    it('[EML23] enforces the maxEmails cap', async function () {
      const max = config.get('account:maxEmails') || 5;
      const u = await makeUser(cuid() + '@cap.example.com');
      const fill = [];
      for (let i = 0; i < max - 1; i++) fill.push(cuid() + `.f${i}@cap.example.com`);
      const okRes = await updateAccount(u, { emails: { add: fill } });
      assert.strictEqual(okRes.status, 200, JSON.stringify(okRes.body));
      assert.strictEqual(okRes.body.account.emails.length, max);
      const overRes = await updateAccount(u, { emails: { add: [cuid() + '.over@cap.example.com'] } });
      assert.strictEqual(overRes.status, 400, JSON.stringify(overRes.body));
    });
  });

  describe('[EML3] remove', function () {
    it('[EML31] removes a non-primary email and releases its platform row', async function () {
      const u = await makeUser(cuid() + '@rm.example.com');
      const extra = cuid() + '@removable.example.com';
      await updateAccount(u, { emails: { add: [extra] } });
      const res = await updateAccount(u, { emails: { remove: [extra] } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(!res.body.account.emails.some((e) => e.value === extra));
      // The row is free again: another user can now claim it.
      const other = await makeUser(cuid() + '@rm-other.example.com');
      const claim = await updateAccount(other, { emails: { add: [extra] } });
      assert.strictEqual(claim.status, 200, JSON.stringify(claim.body));
    });

    it('[EML32] refuses to remove the primary email', async function () {
      const primary = cuid() + '@rm-primary.example.com';
      const u = await makeUser(primary);
      await updateAccount(u, { emails: { add: [cuid() + '@seed.example.com'] } }); // seed container
      const res = await updateAccount(u, { emails: { remove: [primary] } });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-operation');
    });
  });

  describe('[EML4] setPrimary', function () {
    it('[EML41] refuses to set a pending email as primary', async function () {
      const u = await makeUser(cuid() + '@sp.example.com');
      const pending = cuid() + '@pending.example.com';
      await updateAccount(u, { emails: { add: [pending] } });
      const res = await updateAccount(u, { emails: { setPrimary: pending } });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-operation');
    });

    it('[EML42] swaps primary for a verified email: legacy field, flags and rows', async function () {
      const oldPrimary = cuid() + '@old-primary.example.com';
      const u = await makeUser(oldPrimary);
      const next = cuid() + '@new-primary.example.com';
      await updateAccount(u, { emails: { add: [next] } });
      // Internal seam: make it verified (no public API can forge this).
      const ok = await container.markVerified(u.userId, next, 'operator');
      assert.strictEqual(ok, true);

      const res = await updateAccount(u, { emails: { setPrimary: next } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      // Legacy scalar now points to the new value.
      assert.strictEqual(res.body.account.email, next);
      const newView = res.body.account.emails.find((e) => e.value === next);
      const oldView = res.body.account.emails.find((e) => e.value === oldPrimary);
      assert.strictEqual(newView.primary, true);
      assert.strictEqual(newView.status, 'verified');
      assert.ok(oldView, 'old primary stays in the container');
      assert.strictEqual(oldView.primary, false);
      assert.strictEqual(oldView.status, 'verified');

      // account.get agrees (legacy field authoritative).
      const getRes = await getAccount(u);
      assert.strictEqual(getRes.body.account.email, next);

      // Old primary value still belongs to the user: another user cannot claim it.
      const other = await makeUser(cuid() + '@sp-other.example.com');
      const claim = await updateAccount(other, { emails: { add: [oldPrimary] } });
      assert.strictEqual(claim.status, 409, JSON.stringify(claim.body));
    });
  });

  describe('[EML5] legacy account.update {email} compatibility', function () {
    it('[EML51] a brand-new value becomes primary+verified and the old primary is kept', async function () {
      const oldPrimary = cuid() + '@legacy-old.example.com';
      const u = await makeUser(oldPrimary);
      await updateAccount(u, { emails: { add: [cuid() + '@legacy-seed.example.com'] } }); // seed
      const brandNew = cuid() + '@legacy-new.example.com';
      const res = await updateAccount(u, { email: brandNew });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.account.email, brandNew);
      const newView = res.body.account.emails.find((e) => e.value === brandNew);
      const oldView = res.body.account.emails.find((e) => e.value === oldPrimary);
      assert.strictEqual(newView.primary, true);
      assert.strictEqual(newView.status, 'verified');
      assert.strictEqual(newView.verificationMethod, 'legacy');
      assert.strictEqual(newView.verifiedAt, null, 'a legacy assertion is not a real verification');
      assert.ok(oldView, 'old primary kept as verified non-primary');
      assert.strictEqual(oldView.primary, false);
      assert.strictEqual(oldView.status, 'verified');
    });

    it('[EML52] an existing pending value is promoted and marked verified (method null)', async function () {
      const oldPrimary = cuid() + '@legacy-p-old.example.com';
      const u = await makeUser(oldPrimary);
      const pending = cuid() + '@legacy-pending.example.com';
      await updateAccount(u, { emails: { add: [pending] } });
      const res = await updateAccount(u, { email: pending });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.account.email, pending);
      const promoted = res.body.account.emails.find((e) => e.value === pending);
      assert.strictEqual(promoted.primary, true);
      assert.strictEqual(promoted.status, 'verified');
      assert.strictEqual(promoted.verificationMethod, 'legacy');
    });

    it('[EML53] an existing verified value is promoted', async function () {
      const oldPrimary = cuid() + '@legacy-v-old.example.com';
      const u = await makeUser(oldPrimary);
      const verified = cuid() + '@legacy-verified.example.com';
      await updateAccount(u, { emails: { add: [verified] } });
      await container.markVerified(u.userId, verified, 'operator');
      const res = await updateAccount(u, { email: verified });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const promoted = res.body.account.emails.find((e) => e.value === verified);
      assert.strictEqual(promoted.primary, true);
      assert.strictEqual(promoted.status, 'verified');
    });
  });

  describe('[EML6] registration seeding', function () {
    it('[EML61] a registered user gets a primary verified container event', async function () {
      const savedIntegrity = process.env.DISABLE_INTEGRITY_CHECK;
      process.env.DISABLE_INTEGRITY_CHECK = '1';
      try {
        const username = 'reg' + cuid().toLowerCase().slice(1, 12);
        const email = username + '@registration.example.com';
        const regRes = await coreRequest.post('/users').send({
          appId: 'test-emails',
          username,
          password: 'testpassw0rd',
          email,
          insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
          language: 'en'
        });
        assert.ok(regRes.status === 201 || regRes.status === 200,
          `Registration failed: ${regRes.status} ${JSON.stringify(regRes.body)}`);
        const usersRepository = await getUsersRepository();
        const userId = await usersRepository.getUserIdForUsername(username);
        const raw = await container.getRawEvents(userId);
        assert.strictEqual(raw.length, 1, 'exactly one seeded container event');
        assert.strictEqual(raw[0].content.value, email);
        assert.strictEqual(raw[0].content.primary, true);
        assert.strictEqual(raw[0].content.status, 'verified');
        assert.strictEqual(raw[0].content.verificationMethod, 'registration');
        await usersRepository.deleteOne(userId, username);
      } finally {
        if (savedIntegrity != null) process.env.DISABLE_INTEGRITY_CHECK = savedIntegrity;
        else delete process.env.DISABLE_INTEGRITY_CHECK;
      }
    });
  });

  describe('[EML7] events-API mutation guards on the container', function () {
    async function seededUser () {
      const u = await makeUser(cuid() + '@guard.example.com');
      // Seed the container + one extra so a target event exists.
      await updateAccount(u, { emails: { add: [cuid() + '@guard-extra.example.com'] } });
      const raw = await container.getRawEvents(u.userId);
      return { u, raw };
    }

    it('[EML71] refuses events.create into the container (personal token)', async function () {
      const { u } = await seededUser();
      const res = await coreRequest.post(eventsPath(u.username)).set('Authorization', u.token)
        .send({ streamIds: [CONTAINER], type: 'note/txt', content: 'forged' });
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'emails-reserved-stream');
    });

    it('[EML72] refuses events.update on a container event (personal token)', async function () {
      const { u, raw } = await seededUser();
      const target = raw[0];
      const res = await coreRequest.put(eventsPath(u.username) + '/' + target.id).set('Authorization', u.token)
        .send({ content: { ...target.content, status: 'verified' } });
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'emails-reserved-stream');
    });

    it('[EML73] refuses events.delete on a container event (personal token)', async function () {
      const { u, raw } = await seededUser();
      const target = raw[0];
      const res = await coreRequest.delete(eventsPath(u.username) + '/' + target.id).set('Authorization', u.token);
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'emails-reserved-stream');
    });

    it('[EML75] refuses moving an ordinary event INTO the container via events.update', async function () {
      const { u } = await seededUser();
      const stream = await coreRequest.post('/' + u.username + '/streams').set('Authorization', u.token)
        .send({ id: 'diary', name: 'Diary' });
      assert.strictEqual(stream.status, 201, JSON.stringify(stream.body));
      const plain = await coreRequest.post(eventsPath(u.username)).set('Authorization', u.token)
        .send({ streamIds: ['diary'], type: 'note/txt', content: 'plain' });
      assert.strictEqual(plain.status, 201, JSON.stringify(plain.body));
      const moved = await coreRequest.put(eventsPath(u.username) + '/' + plain.body.event.id)
        .set('Authorization', u.token)
        .send({ streamIds: [CONTAINER] });
      assert.ok(moved.status >= 400, 'must not move an event into the container: ' + JSON.stringify(moved.body));
      assert.strictEqual(moved.body?.error?.data?.id, 'emails-reserved-stream');
    });

    it('[EML74] excludes the container from a wildcard events.get but returns it when named', async function () {
      const { u } = await seededUser();
      const wildcard = await coreRequest.get(eventsPath(u.username)).set('Authorization', u.token)
        .query({ streams: JSON.stringify(['*']) });
      assert.strictEqual(wildcard.status, 200);
      assert.ok(!wildcard.body.events.some((e) => (e.streamIds || []).includes(CONTAINER)),
        'wildcard must not surface container events');

      const named = await coreRequest.get(eventsPath(u.username)).set('Authorization', u.token)
        .query({ streams: JSON.stringify([CONTAINER]) });
      assert.strictEqual(named.status, 200, JSON.stringify(named.body));
      assert.ok(named.body.events.length >= 1, 'named query surfaces container events');
      assert.ok(named.body.events.every((e) => (e.streamIds || []).includes(CONTAINER)));
    });

    function streamsPath (username) { return '/' + username + '/streams'; }

    it('[EML76] refuses streams.create under the container (personal token)', async function () {
      const { u } = await seededUser();
      const res = await coreRequest.post(streamsPath(u.username)).set('Authorization', u.token)
        .send({ id: 'forged-child', parentId: CONTAINER, name: 'Forged' });
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'emails-reserved-stream');
    });

    it('[EML77] refuses streams.update on the container (personal token)', async function () {
      const { u } = await seededUser();
      const res = await coreRequest.put(streamsPath(u.username) + '/' + encodeURIComponent(CONTAINER))
        .set('Authorization', u.token).send({ name: 'Renamed' });
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'emails-reserved-stream');
    });

    it('[EML78] refuses streams.delete of the container (personal token)', async function () {
      const { u } = await seededUser();
      const res = await coreRequest.delete(streamsPath(u.username) + '/' + encodeURIComponent(CONTAINER))
        .set('Authorization', u.token);
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'emails-reserved-stream');
    });

    it('[EML79] a non-personal token with star read cannot read the container by naming it', async function () {
      const username = 'eml' + cuid().toLowerCase().slice(1, 12);
      const personal = cuid();
      const appToken = cuid();
      const user = await fixtures.user(username, { email: cuid() + '@e79.example.com' });
      await user.access({ token: personal, type: 'personal' });
      await user.session(personal);
      await user.access({ token: appToken, type: 'app', permissions: [{ streamId: '*', level: 'read' }] });
      // Seed the container with a personal add.
      await coreRequest.put('/' + username + '/account').set('Authorization', personal)
        .send({ emails: { add: [cuid() + '@e79-extra.example.com'] } });
      // The app token names the container explicitly — it must still get nothing
      // (the container is account PII, blocked for non-personal tokens).
      const named = await coreRequest.get(eventsPath(username)).set('Authorization', appToken)
        .query({ streams: JSON.stringify([CONTAINER]) });
      assert.strictEqual(named.status, 200, JSON.stringify(named.body));
      assert.ok(!named.body.events.some((e) => (e.streamIds || []).includes(CONTAINER)),
        'a non-personal token must not read the emails container even when naming it');
    });
  });
});
