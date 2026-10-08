/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The read-only `verification/email` event returned with the account email
 * (Pattern C): an access that can read `:system:email` also gets, in the same
 * stream, whether the primary address is proved, how and when. It is derived
 * from the emails container at read time and never written.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const container = require('business/src/emails/container.ts');
const operations = require('business/src/emails/operations.ts');
const C = require('business/src/emails/constants.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getUserAccountStorage } = require('storage');
const { pubsub } = require('messages');
const errors = require('errors').factory;
const ErrorIds = require('errors').ErrorIds;
const { ErrorMessages } = require('errors/src/ErrorMessages.ts');
const timestamp = require('unix-timestamp');

const EMAIL = ':system:email';
const SIBLING = ':system:emailVerification';
const TYPE = 'verification/email';
const TRUSTED_APP = 'pryv-test-no-cors';

describe('[SIBS] account email verification event', function () {
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

  // A user with a personal token, and an app token reading `:system:email`.
  // `seed`: undefined leaves the container empty (an account never seeded),
  // otherwise the provenance of the founding address.
  async function makeUser (seed) {
    const username = 'sib' + cuid().toLowerCase().slice(1, 12);
    const email = cuid() + '@sib.example.com';
    const token = cuid();
    const appToken = cuid();
    const user = await fixtures.user(username, { email });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.access({ token: appToken, type: 'app', permissions: [{ streamId: EMAIL, level: 'read' }] });
    const starToken = cuid();
    await user.access({ token: starToken, type: 'app', permissions: [{ streamId: '*', level: 'read' }] });
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    if (seed !== undefined) await container.seedInitial(userId, email, 'system', seed ?? undefined);
    return { username, email, token, appToken, starToken, userId };
  }

  async function getEvents (u, query = {}, token = u.appToken) {
    const res = await coreRequest.get('/' + u.username + '/events').set('Authorization', token)
      .query(Object.assign({ streams: JSON.stringify([EMAIL]) }, query));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.events;
  }

  async function sibling (u, token) {
    const events = await getEvents(u, {}, token);
    return events.find((e) => e.type === TYPE);
  }

  // A second address, verified through the mailed link, then made primary.
  async function provedSecondaryAsPrimary (u) {
    const usersRepository = await getUsersRepository();
    const ctx = { userId: u.userId, username: u.username, user: null, accessId: 'system', legacyEmail: u.email };
    const second = cuid() + '@sib-link.example.com';
    const [minted] = await operations.addEmails({ errors, usersRepository }, ctx, [second]);
    const verify = await coreRequest.post('/' + u.username + '/account/verify-email')
      .set('Origin', 'http://test.pryv.local').send({ appId: TRUSTED_APP, token: minted.token });
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
    const swap = await coreRequest.put('/' + u.username + '/account').set('Authorization', u.token)
      .send({ emails: { setPrimary: second } });
    assert.strictEqual(swap.status, 200, JSON.stringify(swap.body));
    return second;
  }

  describe('[SIB0] what an app reading the email sees', function () {
    it('[SIB01] both events, the address first, in the email stream', async function () {
      const u = await makeUser(null);
      const events = await getEvents(u);
      assert.strictEqual(events.length, 2, JSON.stringify(events));
      assert.strictEqual(events[0].id, EMAIL);
      assert.strictEqual(events[0].type, 'email/string');
      assert.strictEqual(events[0].content, u.email);
      assert.strictEqual(events[1].id, SIBLING);
      assert.deepStrictEqual(events[1].streamIds, [EMAIL]);
      assert.strictEqual(events[1].time, events[0].time, 'the sibling carries the address time');
      // and with limit 1, only the address
      const first = await getEvents(u, { limit: 1 });
      assert.strictEqual(first.length, 1);
      assert.strictEqual(first[0].id, EMAIL);
    });

    it('[SIB02] the founding address is not proved (registration)', async function () {
      const u = await makeUser(null);
      assert.deepStrictEqual((await sibling(u)).content, { verified: false, method: 'registration', verifiedAt: null });
    });

    it('[SIB07] an account whose container was never seeded reads as not proved', async function () {
      const u = await makeUser(undefined);
      assert.deepStrictEqual((await sibling(u)).content, { verified: false, method: 'registration', verifiedAt: null });
    });

    it('[SIB04] a code proved at registration reads as proved (email-code)', async function () {
      const at = timestamp.now();
      const u = await makeUser({ verificationMethod: C.METHOD_EMAIL_CODE, verifiedAt: at });
      assert.deepStrictEqual((await sibling(u)).content, { verified: true, method: 'email-code', verifiedAt: at });
    });

    it('[SIB05] an operator-set proof reads as proved (operator)', async function () {
      const at = timestamp.now();
      const u = await makeUser({ verificationMethod: C.METHOD_OPERATOR, verifiedAt: at });
      assert.deepStrictEqual((await sibling(u)).content, { verified: true, method: 'operator', verifiedAt: at });
    });

    it('[SIB03] a link-proved address made primary reads as proved; [SIB06] back to an unproved one reads false', async function () {
      const u = await makeUser(null);
      const second = await provedSecondaryAsPrimary(u);
      const events = await getEvents(u);
      assert.strictEqual(events[0].content, second);
      const proved = events.find((e) => e.type === TYPE);
      assert.strictEqual(proved.content.verified, true);
      assert.strictEqual(proved.content.method, 'email-link');
      assert.strictEqual(typeof proved.content.verifiedAt, 'number');

      const back = await coreRequest.put('/' + u.username + '/account').set('Authorization', u.token)
        .send({ emails: { setPrimary: u.email } });
      assert.strictEqual(back.status, 200, JSON.stringify(back.body));
      const again = await sibling(u);
      assert.deepStrictEqual(again.content, { verified: false, method: 'registration', verifiedAt: null });
    });

    it('[SIB08] the types filter reads either event alone', async function () {
      const u = await makeUser(null);
      const address = await getEvents(u, { types: ['email/string'] });
      assert.deepStrictEqual(address.map((e) => e.id), [EMAIL]);
      const state = await getEvents(u, { types: [TYPE] });
      assert.deepStrictEqual(state.map((e) => e.id), [SIBLING]);
    });

    it('[SIB12] a personal token sees it too', async function () {
      const u = await makeUser(null);
      assert.ok(await sibling(u, u.token));
    });

    it('[SIB13] both events keep the same integrity across reads', async function () {
      const u = await makeUser(null);
      const a = await getEvents(u);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const b = await getEvents(u);
      assert.ok(a.every((e) => typeof e.integrity === 'string'), 'integrity is on in the test config');
      assert.deepStrictEqual(b.map((e) => e.integrity), a.map((e) => e.integrity));
      assert.deepStrictEqual(b.map((e) => e.modified), a.map((e) => e.modified));
    });
  });

  describe('[SIB1] access and writes', function () {
    it('[SIB09] events.getOne by the sibling id works; it has no history', async function () {
      const u = await makeUser(null);
      const res = await coreRequest.get('/' + u.username + '/events/' + encodeURIComponent(SIBLING))
        .set('Authorization', u.appToken).query({ includeHistory: true });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.event.id, SIBLING);
      assert.strictEqual(res.body.event.type, TYPE);
      assert.strictEqual(res.body.event.content.verified, false);
      assert.deepStrictEqual(res.body.history, []);
    });

    it('[SIB10] the sibling cannot be updated or deleted', async function () {
      const u = await makeUser(null);
      const path = '/' + u.username + '/events/' + encodeURIComponent(SIBLING);
      const upd = await coreRequest.put(path).set('Authorization', u.token)
        .send({ content: { verified: true, method: 'email-link', verifiedAt: 1 } });
      assert.strictEqual(upd.status, 400, JSON.stringify(upd.body));
      assert.strictEqual(upd.body.error.id, ErrorIds.InvalidOperation);
      assert.strictEqual(upd.body.error.message, ErrorMessages[ErrorIds.ForbiddenAccountEmailEvent]);
      const del = await coreRequest.delete(path).set('Authorization', u.token);
      assert.strictEqual(del.status, 400, JSON.stringify(del.body));
      assert.strictEqual(del.body.error.id, ErrorIds.InvalidOperation);
      assert.strictEqual(del.body.error.message, 'Account events cannot be deleted.');
      assert.strictEqual((await sibling(u)).content.verified, false);
    });

    it('[SIB11] an app without the email permission sees neither, star included', async function () {
      const u = await makeUser(null);
      const star = await coreRequest.get('/' + u.username + '/events').set('Authorization', u.starToken);
      assert.strictEqual(star.status, 200, JSON.stringify(star.body));
      assert.ok(!star.body.events.some((e) => (e.streamIds || []).includes(EMAIL)), JSON.stringify(star.body.events));
      const one = await coreRequest.get('/' + u.username + '/events/' + encodeURIComponent(SIBLING))
        .set('Authorization', u.starToken);
      assert.strictEqual(one.status, 403, JSON.stringify(one.body));
      assert.strictEqual(one.body.error.id, ErrorIds.Forbidden);
    });

    it('[SIB14] proving or changing the primary notifies events-changed', async function () {
      const u = await makeUser(null);
      const received = [];
      const remove = pubsub.notifications.onAndGetRemovable(u.username, (payload) => { received.push(payload); });
      try {
        await provedSecondaryAsPrimary(u);
      } finally {
        remove();
      }
      const count = received.filter((m) => m === pubsub.USERNAME_BASED_EVENTS_CHANGED).length;
      assert.ok(count >= 2, 'verify + setPrimary each notify: ' + JSON.stringify(received));
    });
  });

  describe('[SIB2] internal readers never see it', function () {
    it('[SIB17] account.get and the user record keep the address as a string', async function () {
      const u = await makeUser(null);
      const acc = await coreRequest.get('/' + u.username + '/account').set('Authorization', u.token);
      assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
      assert.strictEqual(acc.body.account.email, u.email);
      const usersRepository = await getUsersRepository();
      const user = await usersRepository.getUserById(u.userId);
      assert.strictEqual(user.email, u.email);
    });

    it('[SIB18] getOnePropertyValue(email) returns the address', async function () {
      const u = await makeUser(null);
      const usersRepository = await getUsersRepository();
      assert.strictEqual(await usersRepository.getOnePropertyValue(u.userId, 'email'), u.email);
    });

    it('[SIB19] account updates after a proof store no derived field', async function () {
      const u = await makeUser(null);
      await provedSecondaryAsPrimary(u);
      const lang = await coreRequest.put('/' + u.username + '/account').set('Authorization', u.token)
        .send({ language: 'fr' });
      assert.strictEqual(lang.status, 200, JSON.stringify(lang.body));
      const newEmail = cuid() + '@sib-legacy.example.com';
      const mail = await coreRequest.put('/' + u.username + '/account').set('Authorization', u.token)
        .send({ email: newEmail });
      assert.strictEqual(mail.status, 200, JSON.stringify(mail.body));
      const storage = await getUserAccountStorage();
      const fields = await storage.getAccountFields(u.userId);
      assert.ok(!('emailVerification' in fields), JSON.stringify(Object.keys(fields)));
      assert.strictEqual(fields.email, newEmail);
    });

    it('[SIB22] an account-field update notifies events-changed', async function () {
      const u = await makeUser(null);
      const received = [];
      const remove = pubsub.notifications.onAndGetRemovable(u.username, (payload) => { received.push(payload); });
      try {
        const res = await coreRequest.put('/' + u.username + '/account').set('Authorization', u.token)
          .send({ language: 'de' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      } finally {
        remove();
      }
      assert.ok(received.includes(pubsub.USERNAME_BASED_EVENTS_CHANGED), JSON.stringify(received));
    });
  });
});
