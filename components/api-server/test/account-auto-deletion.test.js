/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ACST] account.getAutoDeletion / account.setAutoDeletion: the holder's
 * setting, its validation against the platform's policy, the password asked
 * to arm or shorten a schedule, the delegated session refused, the
 * confirmation mail and `features.autoDeletion` in service info.
 *
 * Every test makes its own accounts; config variants are injected per test.
 */

const timestamp = require('unix-timestamp');
const { getStorageLayer } = require('storage');
const { createAutoDeletionState } = require('business/src/autoDeletion/state.ts');
const { withInjectedConfig, injectTestConfigSnapshot } = require('test-helpers');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const DAY = 24 * 60 * 60;
const PASSWORD = 'acst-password-123';
const DELEGATE_KIND = { delegation: { kind: 'delegate-pat', relId: 'acst-rel', delegate: { username: 'acst-parent', hostSlug: 'core' } } };
// Self-deletion allowed (a holder may then schedule a deletion), and no
// confirmation mail unless a test turns it on.
const BASE_CONFIG = {
  'user-account': { delete: ['adminToken', 'personalToken'] },
  services: { email: { enabled: { accountDeletionScheduled: false } } }
};

describe('[ACST] account auto-deletion setting', function () {
  this.timeout(20000);

  let storageLayer, state, restoreBase;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await getStorageLayer();
    state = createAutoDeletionState(require('storages').userAccountStorage);
    restoreBase = injectTestConfigSnapshot(BASE_CONFIG);
  });

  after(function () {
    restoreBase();
  });

  async function freshUser (opts = {}) {
    const username = ('acst' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const attrs = { password: PASSWORD, language: 'en' };
    attrs.email = opts.email === false ? null : username + '@acst.example.com';
    const fu = await getNewFixture().user(username, attrs);
    const token = cuid();
    const access = await fu.access({ type: 'personal', token });
    await fu.session(token);
    return { fu, username, token, id: fu.attrs.id, personalAccessId: access.attrs.id };
  }

  async function delegateToken (u) {
    const token = 'deleg-' + cuid();
    const access = await u.fu.access({ type: 'personal', token, name: 'delegation:acst-parent@core', clientData: DELEGATE_KIND });
    await u.fu.session(token);
    return { token, id: access.attrs.id };
  }

  function setLastUsed (u, accessId, lastUsed) {
    return new Promise((resolve, reject) => storageLayer.accesses.updateOne({ id: u.id, username: u.username }, { id: accessId }, { lastUsed },
      (err) => (err ? reject(err) : resolve())));
  }

  function get (u, token = u.token) {
    return coreRequest.get(`/${u.username}/account/auto-deletion`).set('Authorization', token);
  }

  function set (u, body, token = u.token) {
    return coreRequest.put(`/${u.username}/account/auto-deletion`).set('Authorization', token).send(body);
  }

  function errorId (res) {
    return res.body?.error?.id;
  }

  const inDays = (days) => new Date((timestamp.now() + days * DAY) * 1000).toISOString();

  it('[ACST1] get answers the live schedule: nothing set, mail, bounds, actions', async function () {
    const u = await freshUser();
    const res = await get(u);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ad = res.body.autoDeletion;
    assert.deepEqual(ad.effective, { source: 'none', mode: 'never', action: 'delete' });
    assert.equal(ad.setting, null);
    assert.equal(ad.deadline, null);
    assert.equal(ad.mail, 'available');
    assert.deepEqual(ad.bounds, { minDays: 90, maxDays: 3650, minLeadDays: 14 });
    assert.equal(ad.userOverride, true);
    assert.equal(ad.allowUserOptOut, true);
    assert.deepEqual(ad.actions, ['delete']);
    assert.deepEqual(ad.remindersSent, []);
    const noEmail = await freshUser({ email: false });
    assert.equal((await get(noEmail)).body.autoDeletion.mail, 'no-email');
  });

  it('[ACST2] lastActivity reports the per-type breakdown and who used the account last', async function () {
    const u = await freshUser();
    const delegate = await delegateToken(u);
    const now = Math.floor(timestamp.now());
    await setLastUsed(u, u.personalAccessId, now - 3 * DAY);
    await setLastUsed(u, delegate.id, now - DAY);
    const ad = (await get(u)).body.autoDeletion;
    assert.equal(ad.lastActivity.personal, now - 3 * DAY);
    assert.equal(ad.lastActivity.delegate, now - DAY);
    assert.equal(ad.lastActivity.max, now - DAY);
    assert.equal(ad.lastActivity.by, 'delegate');
    await setLastUsed(u, u.personalAccessId, now);
    assert.equal((await get(u)).body.autoDeletion.lastActivity.by, 'owner');
  });

  it('[ACST3] arming a schedule needs the password; a wrong one is refused; the right one sets it', async function () {
    const u = await freshUser();
    const missing = await set(u, { mode: 'inactivity', inactivityDays: 365 });
    assert.equal(missing.status, 403, JSON.stringify(missing.body));
    assert.equal(errorId(missing), 'auto-deletion-password-required');
    const wrong = await set(u, { mode: 'inactivity', inactivityDays: 365, password: 'not-the-password' });
    assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
    assert.equal(errorId(wrong), 'auto-deletion-wrong-password');
    assert.equal(await state.getSetting(u.id), null, 'nothing written');
    const before = timestamp.now();
    const ok = await set(u, { mode: 'inactivity', inactivityDays: 365, password: PASSWORD });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const ad = ok.body.autoDeletion;
    assert.deepEqual(ad.effective, { source: 'user', mode: 'inactivity', inactivityDays: 365, action: 'delete' });
    assert.equal(ad.setting.mode, 'inactivity');
    assert.equal(typeof ad.deadline, 'number');
    assert.ok(ad.deadline >= before + 365 * DAY - 1 && ad.deadline <= timestamp.now() + 365 * DAY + 1);
    assert.equal(ad.deadlineReason, 'inactivity');
    assert.equal(typeof ad.nextReminderAt, 'number');
    assert.ok((await state.getBookkeeping(u.id)) != null, 'bookkeeping written');
    assert.deepEqual((await get(u)).body.autoDeletion.effective, ad.effective);
  });

  it('[ACST4] lengthening and clearing need no password; shortening and a mode change do', async function () {
    const u = await freshUser();
    assert.equal((await set(u, { mode: 'inactivity', inactivityDays: 365, password: PASSWORD })).status, 200);
    const longer = await set(u, { mode: 'inactivity', inactivityDays: 400 });
    assert.equal(longer.status, 200, JSON.stringify(longer.body));
    const shorter = await set(u, { mode: 'inactivity', inactivityDays: 200 });
    assert.equal(errorId(shorter), 'auto-deletion-password-required');
    const otherMode = await set(u, { mode: 'date', date: inDays(500) });
    assert.equal(errorId(otherMode), 'auto-deletion-password-required');
    assert.equal((await set(u, { mode: 'date', date: inDays(500), password: PASSWORD })).status, 200);
    assert.equal((await set(u, { mode: 'date', date: inDays(600) })).status, 200, 'later date');
    assert.equal(errorId(await set(u, { mode: 'date', date: inDays(100) })), 'auto-deletion-password-required', 'earlier date');
    const never = await set(u, { mode: 'never' });
    assert.equal(never.status, 200, JSON.stringify(never.body));
    assert.deepEqual(never.body.autoDeletion.effective, { source: 'user', mode: 'never', action: 'delete' });
    assert.equal(await state.getBookkeeping(u.id), null, 'no schedule, no bookkeeping');
    assert.equal(errorId(await set(u, { mode: 'inactivity', inactivityDays: 3000 })), 'auto-deletion-password-required', 'never to a schedule arms it');
    const cleared = await set(u, { mode: 'default' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.autoDeletion.setting, null);
    assert.equal(await state.getSetting(u.id), null);
  });

  it('[ACST5] a delegated session can read the setting but not set it, even with the password', async function () {
    const u = await freshUser();
    const delegate = await delegateToken(u);
    assert.equal((await get(u, delegate.token)).status, 200);
    for (const body of [{ mode: 'inactivity', inactivityDays: 365, password: PASSWORD }, { mode: 'never' }, { mode: 'default' }]) {
      const res = await set(u, body, delegate.token);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(errorId(res), 'auto-deletion-delegate-refused');
    }
    assert.equal(await state.getSetting(u.id), null);
  });

  it('[ACST6] a date is an instant with an offset, stored in seconds, at least minLeadDays away', async function () {
    const u = await freshUser();
    for (const date of ['2030-06-01', '2030-06-01T12:00:00', 'not a date', '2030-13-45T00:00:00Z']) {
      const res = await set(u, { mode: 'date', date, password: PASSWORD });
      assert.equal(res.status, 400, date + ': ' + JSON.stringify(res.body));
      assert.equal(errorId(res), 'invalid-parameters-format', date);
    }
    const tooSoon = await set(u, { mode: 'date', date: inDays(13), password: PASSWORD });
    assert.equal(tooSoon.status, 400, JSON.stringify(tooSoon.body));
    assert.equal(errorId(tooSoon), 'auto-deletion-out-of-bounds');
    const res = await set(u, { mode: 'date', date: '2030-06-01T23:59:59+02:00', password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const at = Date.parse('2030-06-01T21:59:59Z') / 1000;
    assert.equal(res.body.autoDeletion.setting.date, at);
    assert.equal(res.body.autoDeletion.effective.date, at);
    assert.equal(res.body.autoDeletion.deadline, at);
    assert.equal(res.body.autoDeletion.deadlineReason, 'date');
    assert.equal(errorId(await set(u, { mode: 'never', date: inDays(20) })), 'invalid-parameters-format', 'a date only goes with mode date');
  });

  it('[ACST7] inactivityDays outside the bounds is refused', async function () {
    const u = await freshUser();
    for (const inactivityDays of [89, 3651]) {
      const res = await set(u, { mode: 'inactivity', inactivityDays, password: PASSWORD });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(errorId(res), 'auto-deletion-out-of-bounds');
      assert.equal(res.body.error.data.param, 'inactivityDays');
    }
    await withInjectedConfig({ account: { autoDeletion: { inactivity: { minDays: 30 } } } }, async () => {
      assert.equal((await set(u, { mode: 'inactivity', inactivityDays: 45, password: PASSWORD })).status, 200);
    });
    assert.equal(errorId(await set(u, { mode: 'inactivity', inactivityDays: 1.5, password: PASSWORD })), 'invalid-parameters-format');
  });

  it('[ACST8] allowUserOptOut: false refuses "never" while the preset applies, not otherwise', async function () {
    const u = await freshUser();
    const noEmail = await freshUser({ email: false });
    await withInjectedConfig({ account: { autoDeletion: { inactivity: { defaultDays: 365 }, allowUserOptOut: false } } }, async () => {
      const res = await set(u, { mode: 'never' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(errorId(res), 'auto-deletion-opt-out-not-allowed');
      assert.equal((await get(u)).body.autoDeletion.effective.source, 'operator');
      assert.equal((await set(noEmail, { mode: 'never' })).status, 200, 'the preset does not cover an account without email');
    });
    await withInjectedConfig({ account: { autoDeletion: { allowUserOptOut: false } } }, async () => {
      assert.equal((await set(u, { mode: 'never' })).status, 200, 'no preset: nothing to opt out of');
    });
  });

  it('[ACST9] userOverride: false refuses a chosen date or period', async function () {
    const u = await freshUser();
    await withInjectedConfig({ account: { autoDeletion: { userOverride: false } } }, async () => {
      for (const body of [{ mode: 'inactivity', inactivityDays: 365, password: PASSWORD }, { mode: 'date', date: inDays(30), password: PASSWORD }]) {
        const res = await set(u, body);
        assert.equal(res.status, 403, JSON.stringify(res.body));
        assert.equal(errorId(res), 'auto-deletion-override-not-allowed');
      }
      assert.equal((await get(u)).body.autoDeletion.userOverride, false);
    });
  });

  it('[ACST10] delete needs self-deletion (user-account.delete personalToken); transfer is not offered yet', async function () {
    const u = await freshUser();
    await withInjectedConfig({ 'user-account': { delete: ['adminToken'] } }, async () => {
      const res = await set(u, { mode: 'inactivity', inactivityDays: 365, password: PASSWORD });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(errorId(res), 'auto-deletion-action-not-allowed');
      assert.deepEqual(res.body.error.data, { action: 'delete', available: [] });
      assert.deepEqual((await get(u)).body.autoDeletion.actions, []);
      assert.equal((await set(u, { mode: 'never' })).status, 200, 'never stays possible');
    });
    const transfer = await set(u, { mode: 'inactivity', inactivityDays: 365, action: 'transfer', transfer: {}, password: PASSWORD });
    assert.equal(errorId(transfer), 'auto-deletion-action-not-allowed');
    assert.equal(transfer.body.error.data.action, 'transfer');
  });

  it('[ACST11] an account without email needs acknowledgeNoReminders', async function () {
    const u = await freshUser({ email: false });
    const res = await set(u, { mode: 'inactivity', inactivityDays: 365, password: PASSWORD });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(errorId(res), 'auto-deletion-no-email');
    assert.equal(res.body.error.data.reason, 'no-email');
    const ok = await set(u, { mode: 'inactivity', inactivityDays: 365, acknowledgeNoReminders: true, password: PASSWORD });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.autoDeletion.setting.acknowledgedNoReminders, true);
    assert.equal(ok.body.autoDeletion.mail, 'no-email');
    assert.equal(ok.body.autoDeletion.blocked, null, 'acknowledged: the schedule runs without reminders');
  });

  it('[ACST12] without access tracking the inactivity trigger is refused and not advertised', async function () {
    const u = await freshUser();
    await withInjectedConfig({ accessTracking: { isActive: false } }, async () => {
      const res = await set(u, { mode: 'inactivity', inactivityDays: 365, password: PASSWORD });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(errorId(res), 'auto-deletion-override-not-allowed');
      assert.equal(res.body.error.data.reason, 'inactivity-unavailable');
      assert.deepEqual((await coreRequest.get(`/${u.username}/service/info`)).body.features.autoDeletion.triggers, ['date']);
      assert.equal((await set(u, { mode: 'date', date: inDays(30), password: PASSWORD })).status, 200);
    });
  });

  it('[ACST13] features.autoDeletion is advertised, and absent with the methods refused when disabled', async function () {
    const u = await freshUser();
    const info = await coreRequest.get(`/${u.username}/service/info`);
    assert.deepEqual(info.body.features.autoDeletion, {
      triggers: ['date', 'inactivity'],
      actions: ['delete'],
      reminderLeadDays: [60, 30, 7, 1],
      bounds: { minDays: 90, maxDays: 3650, minLeadDays: 14 },
      userOverride: true,
      allowUserOptOut: true,
      mailAvailable: true
    });
    await withInjectedConfig({ account: { autoDeletion: { enabled: false } } }, async () => {
      const off = await coreRequest.get(`/${u.username}/service/info`);
      assert.ok(!('autoDeletion' in off.body.features), JSON.stringify(off.body.features));
      assert.equal(errorId(await get(u)), 'unavailable-method');
      assert.equal(errorId(await set(u, { mode: 'never' })), 'unavailable-method');
    });
  });

  it('[ACST18] the password step-up counts on the sign-in tally: wrong passwords delay it like a login, a success clears it', async function () {
    const u = await freshUser();
    const attempts = { auth: { passwordAttempts: { freeFailures: 1, baseSeconds: 1, maxSeconds: 1, windowSeconds: 3600 } } };
    const arm = (password) => set(u, { mode: 'inactivity', inactivityDays: 365, password });
    await withInjectedConfig(attempts, async () => {
      assert.equal(errorId(await arm('wrong-1')), 'auto-deletion-wrong-password');
      assert.equal(errorId(await arm('wrong-2')), 'auto-deletion-wrong-password');
      const delayed = await arm(PASSWORD);
      assert.equal(delayed.status, 429, JSON.stringify(delayed.body));
      assert.equal(errorId(delayed), 'too-many-attempts', 'the right password is delayed too: no oracle');
      assert.equal(await state.getSetting(u.id), null, 'nothing written');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal((await arm(PASSWORD)).status, 200);
      // the success cleared the tally: the next failure is free again
      assert.equal(errorId(await set(u, { mode: 'inactivity', inactivityDays: 200, password: 'wrong-3' })), 'auto-deletion-wrong-password');
    });
  });

  it('[ACST19] a transfer object is refused unless the action is transfer', async function () {
    const u = await freshUser();
    const res = await set(u, { mode: 'inactivity', inactivityDays: 365, transfer: {}, password: PASSWORD });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(errorId(res), 'invalid-parameters-format');
    assert.equal(res.body.error.data.param, 'transfer');
  });

  it('[ACST17] features.autoDeletion is absent when a holder could set nothing and no preset applies; the methods stay callable', async function () {
    const u = await freshUser();
    const advertised = async () => 'autoDeletion' in (await coreRequest.get(`/${u.username}/service/info`)).body.features;
    for (const nothing of [{ 'user-account': { delete: ['adminToken'] } }, { account: { autoDeletion: { userOverride: false } } }]) {
      await withInjectedConfig(nothing, async () => {
        assert.equal(await advertised(), false, JSON.stringify(nothing));
        assert.equal((await get(u)).status, 200);
        assert.equal((await set(u, { mode: 'never' })).status, 200);
      });
      await withInjectedConfig({ ...nothing, account: { autoDeletion: { ...nothing.account?.autoDeletion, inactivity: { defaultDays: 365 } } } }, async () => {
        assert.equal(await advertised(), true, 'a preset applies: ' + JSON.stringify(nothing));
      });
    }
  });

  it('[ACST14] the operator preset covers plain accounts with email, not group accounts', async function () {
    const plain = await freshUser();
    const group = await freshUser();
    await group.fu.access({ type: 'shared', token: cuid(), name: 'acst-member', permissions: [{ streamId: '*', level: 'read' }], clientData: { cmc: { role: 'member' } } });
    await withInjectedConfig({ account: { autoDeletion: { inactivity: { defaultDays: 365 } } } }, async () => {
      const ad = (await get(plain)).body.autoDeletion;
      assert.deepEqual(ad.effective, { source: 'operator', mode: 'inactivity', inactivityDays: 365, action: 'delete' });
      assert.equal(typeof ad.deadline, 'number');
      assert.equal(await state.getBookkeeping(plain.id), null, 'get writes nothing');
      assert.equal((await get(group)).body.autoDeletion.effective.source, 'none');
    });
  });

  it('[ACST16] leaving "never" for the platform\'s preset arms a schedule: the password is required', async function () {
    const u = await freshUser();
    await withInjectedConfig({ account: { autoDeletion: { inactivity: { defaultDays: 365 } } } }, async () => {
      assert.equal((await set(u, { mode: 'never' })).status, 200, 'opting out needs no password');
      assert.equal(errorId(await set(u, { mode: 'default' })), 'auto-deletion-password-required');
      assert.equal((await state.getSetting(u.id)).mode, 'never', 'nothing changed');
      const back = await set(u, { mode: 'default', password: PASSWORD });
      assert.equal(back.status, 200, JSON.stringify(back.body));
      assert.equal(back.body.autoDeletion.effective.source, 'operator');
      // a longer own period than the preset: back to the preset is nearer
      assert.equal((await set(u, { mode: 'inactivity', inactivityDays: 800, password: PASSWORD })).status, 200);
      assert.equal(errorId(await set(u, { mode: 'default' })), 'auto-deletion-password-required');
      // a shorter own period: back to the preset is lengthening
      assert.equal((await set(u, { mode: 'inactivity', inactivityDays: 200, password: PASSWORD })).status, 200);
      assert.equal((await set(u, { mode: 'default' })).status, 200);
    });
  });

  describe('[ACST15] confirmation mail', function () {
    const nock = require('nock');
    const { pollUntil } = require('test-helpers');
    const { useNock } = require('test-helpers/src/nockScope.ts');
    useNock();
    const MANDRILL = 'https://mandrillapp.local';
    const MANDRILL_PATH = '/api/1.0/messages/send-template.json';
    const MAIL_ON = { services: { email: { enabled: { accountDeletionScheduled: true } } }, service: { account: 'https://account.acst.example.com/' } };

    afterEach(function () {
      nock.cleanAll();
    });

    function capture () {
      const captured = [];
      nock(MANDRILL).post(MANDRILL_PATH).reply(200, (uri, body) => { captured.push(body); return {}; });
      return captured;
    }

    const varsOf = (mail) => Object.fromEntries(mail.message.global_merge_vars.map((x) => [x.name, x.content]));

    it('[ACST15A] a set sends the confirmation, recorded as the first notice', async function () {
      await withInjectedConfig(MAIL_ON, async () => {
        const u = await freshUser();
        const captured = capture();
        const res = await set(u, { mode: 'date', date: inDays(30), password: PASSWORD });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        await pollUntil(async () => captured.length, (n) => n >= 1, { timeoutMs: 3000 });
        const mail = captured[0];
        assert.equal(mail.template_name, 'account-deletion-scheduled');
        const vars = varsOf(mail);
        assert.equal(vars.USERNAME, u.username);
        assert.equal(vars.TRIGGER, 'date');
        assert.equal(vars.TRIGGER_DATE, 'true');
        assert.equal(vars.SCHEDULED, 'true');
        assert.equal(vars.ACTION, 'delete');
        assert.equal(vars.DAYS_LEFT, '30');
        assert.ok(vars.DEADLINE.length > 0);
        assert.equal(vars.ACCOUNT_APP_URL, 'https://account.acst.example.com/');
        assert.equal(vars.EXPORT_URL, 'https://account.acst.example.com/account/data');
        const b = await state.getBookkeeping(u.id);
        assert.equal(typeof b.firstNoticeAt, 'number', 'the confirmation is the first notice');
      });
    });

    it('[ACST15B] clearing the setting sends a confirmation saying nothing is scheduled', async function () {
      await withInjectedConfig(MAIL_ON, async () => {
        const u = await freshUser();
        capture();
        assert.equal((await set(u, { mode: 'inactivity', inactivityDays: 365, password: PASSWORD })).status, 200);
        nock.cleanAll();
        const captured = capture();
        assert.equal((await set(u, { mode: 'never' })).status, 200);
        await pollUntil(async () => captured.length, (n) => n >= 1, { timeoutMs: 3000 });
        const vars = varsOf(captured[0]);
        assert.equal(vars.TRIGGER, 'none');
        assert.equal(vars.SCHEDULED, '');
        assert.equal(vars.DEADLINE, '');
      });
    });

    it('[ACST15C] a failed send does not fail the change and records no notice', async function () {
      await withInjectedConfig(MAIL_ON, async () => {
        const u = await freshUser();
        nock(MANDRILL).post(MANDRILL_PATH).reply(500, {});
        const res = await set(u, { mode: 'inactivity', inactivityDays: 365, password: PASSWORD });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const b = await state.getBookkeeping(u.id);
        assert.ok(b != null);
        assert.equal(b.firstNoticeAt, undefined);
      });
    });
  });
});
