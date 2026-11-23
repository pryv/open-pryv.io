/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ADCL] an administrator stops a pending auto-deletion for a holder
 * (`POST /system/admin/auto-deletion/clear`, `system.autoDeletion.reset`): the
 * schedule restarts from now, or the holder's own setting is removed
 * (`removeSetting`), with a mail to the holder and a row in the account's own
 * trail. Open transfers, a started erasure, the account on another core.
 * [ADCLR] the sweep reads the setting and the schedule again right before an
 * erasure: a change made meanwhile wins.
 *
 * Schedules are built by the sweep on a fake clock; the admin method runs on
 * the real clock.
 */

const timestamp = require('unix-timestamp');
const nock = require('nock');
const { getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { createAutoDeletionState, SETTING_FIELD, IDENTITY_FIELD } = require('business/src/autoDeletion/state.ts');
const { deriveLinkToken } = require('business/src/autoDeletion/transfer.ts');
const { getActivity } = require('business/src/accesses/accountActivity.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getErasuresLocal } = require('business/src/auth/erasures.ts');
const { clearPasswordIpThrottle } = require('business/src/auth/passwordIpThrottle.ts');
const { createAccountAutoDeletionSweep } = require('api-server/src/methods/helpers/autoDeletionSweep.ts');
const { transferLinkKey, transferIdentityKey } = require('api-server/src/methods/helpers/autoDeletionPolicy.ts');
const { getTransferDelegation } = require('api-server/src/methods/helpers/transferDelegation.ts');
const { withInjectedConfig, injectTestConfigSnapshot, pollUntil } = require('test-helpers');
const { useNock } = require('test-helpers/src/nockScope.ts');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, sinon */

const DAY = 24 * 60 * 60;
const PASSWORD = 'adcl-password-123';
const APP_ID = 'pryv-test-no-cors';
const ORIGIN = 'http://test.pryv.local';
const ACCOUNT_APP = 'https://account.adcl.example.com/';
const ADDRESS = '198.51.100.47';
const DEFAULT_PER_IP = { maxFailures: 30, windowSeconds: 900 };
const MAILS_OFF = {
  accountDeletionScheduled: false,
  accountDeletionReminder: false,
  accountDeletionBlocked: false,
  accountTransferNamed: true,
  accountTransferClaim: true,
  accountTransferStarted: false,
  accountTransferCancelled: false,
  accountTransferLapsed: false,
  accountTransferCompleted: false
};
const BASE_CONFIG = {
  'user-account': { delete: ['adminToken', 'personalToken'] },
  service: { account: ACCOUNT_APP },
  services: { email: { enabled: MAILS_OFF } }
};
const MAIL_ON = { services: { email: { enabled: { ...MAILS_OFF, accountDeletionScheduled: true, accountTransferCancelled: true } } } };
const PRESET = { account: { autoDeletion: { inactivity: { defaultDays: 365 } } } };
const MANDRILL = 'https://mandrillapp.local';
const MANDRILL_PATH = '/api/1.0/messages/send-template.json';
const REASON = 'Holder in hospital, reached us by phone';

describe('[ADCL] admin reset of an auto-deletion schedule', function () {
  this.timeout(60000);
  useNock();

  let config, storageLayer, accountStorage, state, usersRepository, restoreBase, adminKey, T0;

  before(async function () {
    await initTests();
    await initCore();
    await require('api-server/src/methods/delegations.ts').default(global.app.api);
    if (!global.app.systemAPI.has('system.autoDeletion.reset')) {
      await require('api-server/src/methods/system.ts').default(global.app.systemAPI, global.app.api);
    }
    config = await getConfig();
    storageLayer = await getStorageLayer();
    accountStorage = require('storages').userAccountStorage;
    state = createAutoDeletionState(accountStorage);
    usersRepository = await getUsersRepository();
    restoreBase = injectTestConfigSnapshot(BASE_CONFIG);
    adminKey = config.get('auth:adminAccessKey');
  });

  after(async function () {
    restoreBase();
    await clearPasswordIpThrottle([ADDRESS], DEFAULT_PER_IP);
  });

  beforeEach(function () {
    T0 = Math.floor(timestamp.now());
  });

  afterEach(function () {
    nock.cleanAll();
  });

  async function freshUser (opts = {}) {
    const username = ((opts.prefix ?? 'adcl') + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const attrs = { password: PASSWORD, language: 'en' };
    attrs.email = opts.email === false ? null : username + '@adcl.example.com';
    const fu = await getNewFixture().user(username, attrs);
    const token = cuid();
    const access = await fu.access({ type: 'personal', token });
    await fu.session(token);
    return { fu, username, token, id: fu.attrs.id, personalAccessId: access.attrs.id, email: attrs.email };
  }

  async function exists (u) {
    return (await usersRepository.getUserIdForUsername(u.username)) != null;
  }

  function reset (body, key = adminKey) {
    const req = coreRequest.post('/system/admin/auto-deletion/clear');
    return (key != null ? req.set('authorization', key) : req).send(body);
  }

  const errorId = (res) => res.body?.error?.id;
  const nowS = () => timestamp.now();
  const inactivity = (days, extra = {}) => ({ mode: 'inactivity', inactivityDays: days, action: 'delete', updatedAt: T0, ...extra });
  const onDate = (date, extra = {}) => ({ mode: 'date', date, action: 'delete', updatedAt: T0, ...extra });
  const transferTo = (email, extra = {}) => ({ email, notifyBeneficiary: 'atTrigger', fallback: 'keep', ...extra });
  const linkOf = (owner, kind, salt) => deriveLinkToken(transferLinkKey(config), kind, owner.id, salt);
  /** `t` is about `expected` (the real clock moved on during the call). */
  const near = (t, expected, label) => assert.ok(Math.abs(t - expected) < 120, `${label}: ${t} vs ${expected}`);

  function captureLogger () {
    const lines = [];
    const logger = {};
    for (const level of ['info', 'warn', 'error']) logger[level] = (msg, ctx) => lines.push({ level, msg, ctx });
    return { lines, logger };
  }

  async function pendingOf (users) {
    const ids = new Set(users.map((u) => u.id));
    return (await (await getErasuresLocal()).listAll()).filter((r) => ids.has(r.userId));
  }

  /** A sweep over `users`, with a fake clock, a fake mailer and a captured log. */
  async function sweepFor (users, overrides = {}) {
    const clock = { t: T0 };
    const { lines, logger } = captureLogger();
    const sent = { reminder: [], blocked: [], transfer: [] };
    const sweep = await createAccountAutoDeletionSweep(config, {
      listAccounts: async () => users.map((u) => ({ id: u.id, username: u.username })),
      listPendingErasures: () => pendingOf(users),
      now: () => clock.t,
      logger,
      sendReminder: async (account, facts, notice) => { sent.reminder.push({ username: account.username, leadDays: notice.leadDays }); return 'sent'; },
      sendBlocked: async (account) => { sent.blocked.push({ username: account.username }); return 'sent'; },
      sendTransferMail: async (account, facts, notice) => { sent.transfer.push({ username: account.username, kind: notice.kind, to: notice.to }); return 'sent'; },
      ...overrides
    });
    return { sweep, clock, lines, sent, run: async (t) => { if (t != null) clock.t = t; return await sweep.runPass(); } };
  }

  function capture () {
    const captured = [];
    nock(MANDRILL).post(MANDRILL_PATH).times(10).reply(200, (uri, body) => { captured.push(body); return {}; });
    return captured;
  }
  const varsOf = (mail) => Object.fromEntries(mail.message.global_merge_vars.map((x) => [x.name, x.content]));

  async function auditRows (u) {
    const res = await coreRequest.get(`/${u.username}/events`).set('Authorization', u.token).query({ streams: [':_audit:'], limit: 200 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.events ?? [];
  }
  const resetRows = async (u) => (await auditRows(u)).filter((e) => e.content?.action === 'account.autoDeletion.resetByAdmin');

  /** An inactivity transfer of `days` whose claim window the sweep opened (fake clock). */
  async function openWindow (u, transfer, days = 100) {
    await state.setSetting(u.id, { mode: 'inactivity', inactivityDays: days, action: 'transfer', transfer, updatedAt: T0 }, 'test');
    const s = await sweepFor([u]);
    for (const d of [0, 40, 70, 93, 99]) await s.run(T0 + d * DAY);
    assert.equal((await s.run(T0 + (days + 1) * DAY)).transfersOpened, 1);
    return s;
  }

  function claim (owner, token, claimant) {
    return coreRequest.post(`/${owner.username}/account/auto-deletion/transfer-claim`)
      .set('Origin', ORIGIN).set('X-Forwarded-For', ADDRESS)
      .send({ appId: APP_ID, token, claimant: claimant.username });
  }

  function accept (claimant, owner) {
    return coreRequest.post(`/${claimant.username}/delegations/controlled/${owner.username}/accept`)
      .set('Authorization', claimant.token).send({});
  }

  it('[ADCL1] the admin key, a reason and only the known parameters are required', async function () {
    const u = await freshUser();
    assert.equal((await reset({ username: u.username, reason: REASON }, null)).status, 404, 'no admin key');
    assert.equal((await reset({ username: u.username, reason: REASON }, 'not-the-key')).status, 404, 'a wrong key');
    for (const body of [{ username: u.username }, { username: u.username, reason: '' }, { username: u.username, reason: 'x'.repeat(501) },
      { username: u.username, reason: REASON, extra: true }, { username: u.username, reason: REASON, removeSetting: 'yes' }]) {
      const res = await reset(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(errorId(res), 'invalid-parameters-format', JSON.stringify(res.body));
    }
  });

  it('[ADCL2] an unknown account: 404; the feature off: unavailable-method', async function () {
    const res = await reset({ username: 'adcl-nobody-' + cuid().toLowerCase().slice(-8), reason: REASON });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(errorId(res), 'unknown-resource');
    const u = await freshUser();
    await withInjectedConfig({ account: { autoDeletion: { enabled: false } } }, async () => {
      assert.equal(errorId(await reset({ username: u.username, reason: REASON })), 'unavailable-method');
    });
  });

  it('[ADCL3] the operator preset: the schedule restarts with its full period, the holder is mailed with the reason, first notice recorded', async function () {
    await withInjectedConfig({ ...PRESET, ...MAIL_ON }, async () => {
      const u = await freshUser();
      const s = await sweepFor([u]);
      await s.run(T0);
      await s.run(T0 + 305 * DAY);
      assert.deepEqual(s.sent.reminder.map((m) => m.leadDays), [60]);
      const captured = capture();
      const res = await reset({ username: u.username, reason: REASON });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const body = res.body;
      assert.equal(body.cleared, true);
      assert.equal(body.removedSetting, false);
      assert.equal(body.transferCancelled, false);
      assert.equal(body.notified, 'mail');
      assert.equal(body.was.source, 'operator');
      assert.equal(body.was.mode, 'inactivity');
      assert.equal(body.was.remindersSent, 1);
      assert.ok(body.was.deleteAt >= T0 + 365 * DAY, 'the pending date');
      assert.equal(body.autoDeletion.source, 'operator');
      assert.equal(body.autoDeletion.mode, 'inactivity');
      near(body.autoDeletion.deleteAt, nowS() + 365 * DAY, 'the full period from now');
      const b = await state.getBookkeeping(u.id);
      assert.deepEqual(b.reminders.sent, [], 'reminders start over');
      near(b.policyAppliedAt, nowS(), 'the clock starts now');
      assert.equal(typeof b.firstNoticeAt, 'number', 'the mail is the first notice');
      await pollUntil(async () => captured.length, (n) => n >= 1, { timeoutMs: 3000 });
      assert.equal(captured.length, 1);
      const mail = captured[0];
      assert.equal(mail.template_name, 'account-deletion-scheduled');
      assert.equal(mail.message.to[0].email, u.email);
      const vars = varsOf(mail);
      assert.equal(vars.BY_OPERATOR, 'true');
      assert.equal(vars.OPERATOR_REASON, REASON);
      assert.equal(vars.TRIGGER_INACTIVITY, 'true');
      assert.equal(vars.INACTIVITY_DAYS, '365');
    });
  });

  it('[ADCL4] a holder\'s inactivity schedule restarts, the setting untouched; mail off: audit-only', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    const s = await sweepFor([u]);
    for (const d of [0, 40, 70]) await s.run(T0 + d * DAY);
    const versions = (await accountStorage.getAccountFieldHistory(u.id, SETTING_FIELD)).length;
    const res = await reset({ username: u.username, reason: REASON });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.cleared, true);
    assert.equal(res.body.notified, 'audit-only', 'the confirmation is switched off');
    assert.equal(res.body.was.remindersSent, 2);
    assert.equal(res.body.autoDeletion.source, 'user');
    near(res.body.autoDeletion.deleteAt, nowS() + 100 * DAY, 'the holder\'s period from now');
    assert.equal((await accountStorage.getAccountFieldHistory(u.id, SETTING_FIELD)).length, versions, 'no new version of the setting');
    assert.deepEqual(await state.getSetting(u.id), inactivity(100));
    assert.deepEqual((await state.getBookkeeping(u.id)).reminders.sent, []);
  });

  it('[ADCL5] a holder\'s date is refused without removeSetting, nothing written', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, onDate(T0 + 100 * DAY), 'test');
    const s = await sweepFor([u]);
    await s.run(T0);
    const before = await state.getBookkeeping(u.id);
    const res = await reset({ username: u.username, reason: REASON });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(errorId(res), 'invalid-operation');
    assert.equal(res.body.error.data.reason, 'date-schedule');
    assert.deepEqual(await state.getSetting(u.id), onDate(T0 + 100 * DAY));
    assert.deepEqual(await state.getBookkeeping(u.id), before);
  });

  it('[ADCL6] removeSetting clears a holder\'s date, written by the admin: the preset applies from now, else nothing', async function () {
    for (const preset of [false, true]) {
      await withInjectedConfig(preset ? PRESET : {}, async () => {
        const u = await freshUser();
        await state.setSetting(u.id, onDate(T0 + 100 * DAY), 'test');
        await (await sweepFor([u])).run(T0);
        const res = await reset({ username: u.username, reason: REASON, removeSetting: true });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.cleared, true);
        assert.equal(res.body.removedSetting, true);
        assert.equal(res.body.was.mode, 'date');
        assert.equal(await state.getSetting(u.id), null);
        const history = await accountStorage.getAccountFieldHistory(u.id, SETTING_FIELD);
        assert.ok(history.some((h) => h.value == null && h.createdBy === 'admin'), JSON.stringify(history));
        if (preset) {
          assert.equal(res.body.autoDeletion.source, 'operator');
          near(res.body.autoDeletion.deleteAt, nowS() + 365 * DAY, 'the preset from now');
          near((await state.getBookkeeping(u.id)).policyAppliedAt, nowS(), 'a fresh clock');
        } else {
          assert.deepEqual(res.body.autoDeletion, { source: 'none', mode: 'never', action: 'delete', deleteAt: null });
          assert.equal(await state.getBookkeeping(u.id), null);
        }
      });
    }
  });

  it('[ADCL7] "never" is never removed: no change', async function () {
    await withInjectedConfig(PRESET, async () => {
      const u = await freshUser();
      const never = { mode: 'never', action: 'delete', updatedAt: T0 };
      await state.setSetting(u.id, never, 'test');
      for (const removeSetting of [false, true]) {
        const res = await reset({ username: u.username, reason: REASON, removeSetting });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.cleared, false);
        assert.equal(res.body.notified, 'none');
      }
      assert.deepEqual(await state.getSetting(u.id), never);
      assert.equal(await state.getBookkeeping(u.id), null);
    });
  });

  it('[ADCL8] nothing pending: no change, no mail, no trail row', async function () {
    await withInjectedConfig(MAIL_ON, async () => {
      const u = await freshUser();
      const captured = capture();
      const res = await reset({ username: u.username, reason: REASON, removeSetting: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.was, { source: 'none', mode: 'never', action: 'delete', deleteAt: null, remindersSent: 0 });
      assert.equal(res.body.cleared, false);
      assert.equal(res.body.notified, 'none');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(captured.length, 0);
      if (config.get('audit:active') === true) assert.deepEqual(await resetRows(u), []);
    });
  });

  it('[ADCL9] a repeated restart changes nothing more: one mail in all', async function () {
    await withInjectedConfig({ ...PRESET, ...MAIL_ON }, async () => {
      const u = await freshUser();
      const s = await sweepFor([u]);
      await s.run(T0);
      await s.run(T0 + 305 * DAY);
      const captured = capture();
      assert.equal((await reset({ username: u.username, reason: REASON })).body.cleared, true);
      const again = await reset({ username: u.username, reason: REASON });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.cleared, false);
      assert.equal(again.body.notified, 'none');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(captured.length, 1);
    });
  });

  it('[ADCLA] a schedule held by a deletion guard: the hold goes with the restart', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    await (await sweepFor([u])).run(T0);
    const b = await state.getBookkeeping(u.id);
    await state.saveBookkeeping(u.id, b, { ...b, blocked: { reason: 'deletion-guard', at: T0, guard: 'delegation' } });
    const res = await reset({ username: u.username, reason: REASON });
    assert.equal(res.body.cleared, true, JSON.stringify(res.body));
    assert.equal((await state.getBookkeeping(u.id)).blocked, undefined);
  });

  it('[ADCLB] a transfer only named: restarted, the record and the identity kept, the beneficiary not told', async function () {
    await withInjectedConfig(MAIL_ON, async () => {
      const u = await freshUser();
      await state.setSetting(u.id, { mode: 'inactivity', inactivityDays: 100, action: 'transfer', transfer: transferTo('b@adcl.example.com', { identityGiven: true }), updatedAt: T0 }, 'test');
      await state.setIdentity(u.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
      const named = { email: 'b@adcl.example.com', status: 'named', createdAt: T0, declineSalt: 'adcl-salt', namedAt: T0 };
      await state.saveTransfer(u.id, named);
      const s = await sweepFor([u]);
      for (const d of [0, 40]) await s.run(T0 + d * DAY);
      const captured = capture();
      const res = await reset({ username: u.username, reason: REASON });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.cleared, true);
      assert.equal(res.body.transferCancelled, false);
      assert.equal(res.body.autoDeletion.action, 'transfer');
      assert.deepEqual(await state.getTransfer(u.id), named);
      assert.deepEqual(await state.getIdentity(u.id, transferIdentityKey(config)), { name: 'Bea' });
      await pollUntil(async () => captured.length, (n) => n >= 1, { timeoutMs: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(captured.map((m) => m.template_name), ['account-deletion-scheduled'], 'the owner only');
      assert.equal(varsOf(captured[0]).ACTION_TRANSFER, 'true');
    });
  });

  it('[ADCLC] an open claim window (inactivity) is cancelled as a use would: the beneficiary told, the transfer armed again', async function () {
    await withInjectedConfig(MAIL_ON, async () => {
      const u = await freshUser();
      await state.setIdentity(u.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
      await openWindow(u, transferTo('b@adcl.example.com', { identityGiven: true }));
      const captured = capture();
      const res = await reset({ username: u.username, reason: REASON });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.cleared, true);
      assert.equal(res.body.transferCancelled, true);
      const record = await state.getTransfer(u.id);
      assert.equal(record.status, 'cancelled');
      assert.equal(record.closedReason, 'operator');
      assert.equal((await state.getSetting(u.id)).action, 'transfer', 'armed again');
      assert.ok(await state.getIdentity(u.id, transferIdentityKey(config)) != null, 'the identity stays with the setting');
      near((await state.getBookkeeping(u.id)).deadline, nowS() + 100 * DAY, 'the clock restarts');
      await pollUntil(async () => captured.length, (n) => n >= 2, { timeoutMs: 3000 });
      const toBeneficiary = captured.find((m) => m.template_name === 'account-transfer-cancelled');
      assert.equal(toBeneficiary.message.to[0].email, 'b@adcl.example.com');
      assert.equal(varsOf(toBeneficiary).TO_BENEFICIARY, 'true');
      assert.ok(!captured.some((m) => m.template_name === 'account-transfer-cancelled' && m.message.to[0].email === u.email), 'the owner gets the confirmation instead');
      assert.equal(varsOf(captured.find((m) => m.template_name === 'account-deletion-scheduled')).BY_OPERATOR, 'true');
    });
  });

  it('[ADCLD] a claim not accepted yet: the invite is withdrawn, the window cancelled', async function () {
    const owner = await freshUser();
    const claimant = await freshUser({ prefix: 'adcb' });
    await openWindow(owner, transferTo('b@adcl.example.com'));
    const record = await state.getTransfer(owner.id);
    const claimed = await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal((await getTransferDelegation().stateOf(owner, claimant.username)).status, 'invite');
    const res = await reset({ username: owner.username, reason: REASON });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.transferCancelled, true);
    assert.equal((await state.getTransfer(owner.id)).status, 'cancelled');
    assert.notEqual((await getTransferDelegation().stateOf(owner, claimant.username)).status, 'invite', 'withdrawn');
    assert.notEqual((await accept(claimant, owner)).status, 200, 'the invite cannot be accepted any more');
  });

  it('[ADCLE] the claimant already controls the account: the transfer completes, 409', async function () {
    const owner = await freshUser();
    const claimant = await freshUser({ prefix: 'adcb' });
    await openWindow(owner, transferTo('b@adcl.example.com'));
    const record = await state.getTransfer(owner.id);
    assert.equal((await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant)).status, 200);
    assert.equal((await accept(claimant, owner)).status, 200);
    const res = await reset({ username: owner.username, reason: REASON });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(errorId(res), 'auto-deletion-transfer-claimed');
    assert.equal((await state.getTransfer(owner.id)).status, 'completed');
    assert.equal(await state.getSetting(owner.id), null);
    assert.equal(await state.getBookkeeping(owner.id), null);
  });

  it('[ADCLF] an open window with removeSetting: the setting goes, the identity erased', async function () {
    const u = await freshUser();
    await state.setIdentity(u.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
    await openWindow(u, transferTo('b@adcl.example.com', { identityGiven: true }));
    const res = await reset({ username: u.username, reason: REASON, removeSetting: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.removedSetting, true);
    assert.equal(res.body.transferCancelled, true);
    assert.equal(await state.getSetting(u.id), null);
    assert.equal((await state.getTransfer(u.id)).status, 'cancelled');
    assert.deepEqual(await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD), []);
  });

  it('[ADCLG] declined with fallback delete, erasure due: stopped, the schedule goes on as a deletion from now', async function () {
    const u = await freshUser();
    const s = await openWindow(u, transferTo('b@adcl.example.com', { fallback: 'delete' }));
    const record = await state.getTransfer(u.id);
    const declined = await coreRequest.post(`/${u.username}/account/auto-deletion/transfer-decline`)
      .set('Origin', ORIGIN).set('X-Forwarded-For', ADDRESS)
      .send({ appId: APP_ID, token: linkOf(u, 'decline', record.declineSalt) });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal((await state.getTransfer(u.id)).closedReason, 'declined');
    const res = await reset({ username: u.username, reason: REASON });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.transferCancelled, true);
    const setting = await state.getSetting(u.id);
    assert.equal(setting.action, 'delete');
    assert.equal(setting.transfer, undefined);
    assert.equal((await state.getTransfer(u.id)).status, 'cancelled');
    near((await state.getBookkeeping(u.id)).deadline, nowS() + 100 * DAY, 'from now');
    const r = await s.run(Math.ceil(nowS()) + DAY);
    assert.equal(r.erased, 0);
    assert.ok(await exists(u));
  });

  it('[ADCLH] an erasure already started: refused', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    await (await sweepFor([u])).run(T0);
    const erasures = await getErasuresLocal();
    const now = Date.now();
    await erasures.put({ userId: u.id, username: u.username, trigger: 'inactivity', startedAt: now, updatedAt: now, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null });
    try {
      const res = await reset({ username: u.username, reason: REASON });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(errorId(res), 'invalid-operation');
      assert.equal(res.body.error.data.reason, 'erasure-in-progress');
    } finally {
      await erasures.delete(u.id);
    }
  });

  it('[ADCLI] the account\'s own trail records the reset: what was pending, what is now, the reason; no address', async function () {
    if (config.get('audit:active') !== true) this.skip();
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    const s = await sweepFor([u]);
    for (const d of [0, 40]) await s.run(T0 + d * DAY);
    const audit = (await import('audit')).default;
    const spy = sinon.spy(audit, 'eventForUser');
    const callRow = () => spy.getCalls().find((c) => c.args[1]?.content?.action === 'system.autoDeletion.reset');
    try {
      assert.equal((await reset({ username: u.username, reason: REASON })).status, 200);
      await pollUntil(async () => callRow() != null, (found) => found, { timeoutMs: 3000 });
      assert.equal(callRow().args[0], undefined, 'the call itself is recorded without a user');
    } finally {
      spy.restore();
    }
    const rows = await resetRows(u);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.type, 'audit-log/account-auto-deletion');
    assert.deepEqual(row.content.source, { name: 'admin' });
    const record = row.content.record;
    assert.equal(record.reason, REASON);
    assert.equal(record.removedSetting, false);
    assert.equal(record.was.source, 'user');
    assert.equal(record.was.remindersSent, 1);
    assert.equal(record.was.deadline, T0 + 100 * DAY);
    assert.equal(record.now.mode, 'inactivity');
    near(record.now.deleteAt, nowS() + 100 * DAY, 'now');
    assert.ok(!JSON.stringify(row).includes('@adcl.example.com'), 'no address');
    assert.ok(!(await auditRows(u)).some((e) => e.content?.action === 'system.autoDeletion.reset'), 'the admin call itself is not in the account\'s trail');
  });

  it('[ADCLJ] an account without an address: the change stands, audit-only', async function () {
    await withInjectedConfig(MAIL_ON, async () => {
      const u = await freshUser({ email: false });
      await state.setSetting(u.id, inactivity(100, { acknowledgedNoReminders: true }), 'test');
      // No reminder without an address: a clock started ten days ago is what a restart changes.
      await (await sweepFor([u])).run(T0 - 10 * DAY);
      const res = await reset({ username: u.username, reason: REASON });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.cleared, true);
      assert.equal(res.body.notified, 'audit-only');
      near((await state.getBookkeeping(u.id)).deadline, nowS() + 100 * DAY, 'restarted');
    });
  });

  it('[ADCLK] after a restart the sweep neither reminds nor erases, then reminds at the new leads', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    const s = await sweepFor([u]);
    for (const d of [0, 40, 70, 93, 99]) await s.run(T0 + d * DAY);
    assert.deepEqual(s.sent.reminder.map((m) => m.leadDays), [60, 30, 7, 1]);
    assert.equal((await reset({ username: u.username, reason: REASON })).status, 200);
    const N = Math.ceil(nowS());
    for (const d of [1, 30]) {
      const r = await s.run(N + d * DAY);
      assert.equal(r.erased + r.reminders, 0, 'day ' + d);
    }
    assert.ok(await exists(u));
    await s.run(N + 41 * DAY);
    assert.deepEqual(s.sent.reminder.map((m) => m.leadDays), [60, 30, 7, 1, 60], 'the new schedule\'s first reminder');
  });

  it('[ADCLM] an account on another core: 307 to that core', async function () {
    const platform = await require('platform').getPlatform();
    const username = 'adclm' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
    await platform.setUserCore(username, 'core-elsewhere');
    try {
      const res = await reset({ username, reason: REASON });
      assert.equal(res.status, 307, JSON.stringify(res.body));
      const server = platform.coreIdToUrl('core-elsewhere').replace(/\/?$/, '/');
      assert.equal(res.headers.location, server + 'system/admin/auto-deletion/clear');
      assert.deepEqual(Object.keys(res.body).filter((k) => k !== 'meta'), ['server']);
    } finally {
      await platform.deleteUserCore(username);
    }
  });

  it('[ADCLS] a reset landing while the sweep sends a reminder is not written over: the account is not erased', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    let during = null;
    const s = await sweepFor([u], {
      sendReminder: async (account, facts, notice) => {
        if (notice.leadDays === 1) during = await reset({ username: u.username, reason: REASON });
        return 'sent';
      }
    });
    for (const d of [0, 40, 70, 93, 99]) await s.run(T0 + d * DAY);
    assert.equal(during?.status, 200, JSON.stringify(during?.body));
    assert.equal(during.body.cleared, true);
    const b = await state.getBookkeeping(u.id);
    assert.deepEqual(b.reminders.sent, [], 'the reset\'s row, not the pass\'s: ' + JSON.stringify(b));
    near(b.policyAppliedAt, nowS(), 'the reset\'s clock');
    assert.ok(s.lines.some((l) => l.msg.includes('changed while being checked')), JSON.stringify(s.lines));
    // On the reset's clock: nothing due, nothing to remind.
    const N = Math.ceil(nowS());
    for (const d of [1, 2]) {
      const r = await s.run(N + d * DAY);
      assert.equal(r.erased + r.reminders, 0, 'day ' + d);
    }
    assert.ok(await exists(u));
  });

  it('[ADCLT] removeSetting on a holder\'s inactivity schedule: the setting goes, nothing scheduled without a preset', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    await (await sweepFor([u])).run(T0);
    const res = await reset({ username: u.username, reason: REASON, removeSetting: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.removedSetting, true);
    assert.equal(res.body.was.mode, 'inactivity');
    assert.deepEqual(res.body.autoDeletion, { source: 'none', mode: 'never', action: 'delete', deleteAt: null });
    assert.equal(await state.getSetting(u.id), null);
    assert.equal(await state.getBookkeeping(u.id), null);
  });

  it('[ADCLU] removeSetting with a transfer only named: cancelled, the beneficiary told, the identity erased', async function () {
    await withInjectedConfig(MAIL_ON, async () => {
      const u = await freshUser();
      await state.setSetting(u.id, { mode: 'inactivity', inactivityDays: 100, action: 'transfer', transfer: transferTo('b@adcl.example.com', { identityGiven: true }), updatedAt: T0 }, 'test');
      await state.setIdentity(u.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
      await state.saveTransfer(u.id, { email: 'b@adcl.example.com', status: 'named', createdAt: T0, declineSalt: 'adcl-salt', namedAt: T0 });
      await (await sweepFor([u])).run(T0);
      const captured = capture();
      const res = await reset({ username: u.username, reason: REASON, removeSetting: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.transferCancelled, true);
      const record = await state.getTransfer(u.id);
      assert.equal(record.status, 'cancelled');
      assert.equal(record.closedReason, 'operator');
      assert.equal(await state.getSetting(u.id), null);
      assert.deepEqual(await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD), []);
      await pollUntil(async () => captured.length, (n) => n >= 2, { timeoutMs: 3000 });
      const toBeneficiary = captured.find((m) => m.template_name === 'account-transfer-cancelled');
      assert.equal(toBeneficiary.message.to[0].email, 'b@adcl.example.com');
    });
  });

  it('[ADCLV] a date-mode claim window: refused without removeSetting, cancelled with it', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, { mode: 'date', date: T0 + 20 * DAY, action: 'transfer', transfer: transferTo('b@adcl.example.com'), updatedAt: T0 }, 'test');
    const s = await sweepFor([u]);
    for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
    assert.equal((await s.run(T0 + 21 * DAY)).transfersOpened, 1);
    const refused = await reset({ username: u.username, reason: REASON });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.data.reason, 'date-schedule');
    assert.equal((await state.getTransfer(u.id)).status, 'open', 'nothing written');
    const res = await reset({ username: u.username, reason: REASON, removeSetting: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.transferCancelled, true);
    assert.equal((await state.getTransfer(u.id)).status, 'cancelled');
    assert.equal(await state.getSetting(u.id), null);
  });

  it('[ADCLW] the claimant controls the account: 409 with removeSetting too, the completion in the account\'s trail', async function () {
    const owner = await freshUser();
    const claimant = await freshUser({ prefix: 'adcb' });
    await openWindow(owner, transferTo('b@adcl.example.com'));
    const record = await state.getTransfer(owner.id);
    assert.equal((await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant)).status, 200);
    assert.equal((await accept(claimant, owner)).status, 200);
    const res = await reset({ username: owner.username, reason: REASON, removeSetting: true });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal((await state.getTransfer(owner.id)).status, 'completed');
    if (config.get('audit:active') === true) {
      const rows = await resetRows(owner);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content.record.completedTransfer, true);
    }
  });

  it('[ADCLX] an erasure recorded while the reset writes: answered erasure-in-progress', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    await (await sweepFor([u])).run(T0 - 10 * DAY);
    const erasures = await getErasuresLocal();
    const now = Date.now();
    const row = { userId: u.id, username: u.username, trigger: 'inactivity', startedAt: now, updatedAt: now, doneSteps: ['runTeardownSteps'], seriesNamespaces: null, attempts: 1, lastError: null };
    const stub = sinon.stub(erasures, 'get');
    stub.callThrough();
    stub.withArgs(u.id).onFirstCall().resolves(null).onSecondCall().resolves(row);
    try {
      const res = await reset({ username: u.username, reason: REASON });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.data.reason, 'erasure-in-progress');
      assert.equal(stub.withArgs(u.id).callCount, 2, 'checked before and after the writes');
    } finally {
      stub.restore();
    }
  });

  it('[ADCLX2] an erasure that completes while the reset waits on it: answered erasure-in-progress, not cleared', async function () {
    const { Deletion } = require('business/src/auth/deletion.ts');
    const deletion = new Deletion(null, storageLayer, config);
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    await (await sweepFor([u])).run(T0 - 10 * DAY);
    const erasures = await getErasuresLocal();
    const original = erasures.get.bind(erasures);
    const now = Date.now();
    const justOpened = { userId: u.id, username: u.username, trigger: 'inactivity', startedAt: now, updatedAt: now, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null };
    let calls = 0;
    let erasing = false;
    const stub = sinon.stub(erasures, 'get').callsFake(async (id) => {
      if (id !== u.id || erasing) return await original(id);
      calls++;
      if (calls !== 2) return await original(id);
      // After the reset's writes: an erasure just recorded, then completed during the wait.
      erasing = true;
      try {
        await deletion.eraseAccount({ id: u.id, username: u.username }, { teardown: true, trigger: 'inactivity' });
      } finally {
        erasing = false;
      }
      return justOpened;
    });
    try {
      const res = await reset({ username: u.username, reason: REASON });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.data.reason, 'erasure-in-progress');
      assert.equal(await exists(u), false);
    } finally {
      stub.restore();
    }
  });

  /**
   * An open window claimed by `claimant` (invite out), then cancelled by the
   * sweep on the owner's use while the invite withdraw fails. `beforeCancel`
   * runs once the invite is out.
   */
  async function cancelledWithInviteOut (owner, claimant, beforeCancel) {
    await openWindow(owner, transferTo('b@adcl.example.com'));
    const record = await state.getTransfer(owner.id);
    assert.equal((await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant)).status, 200);
    if (beforeCancel != null) await beforeCancel();
    await new Promise((resolve, reject) => storageLayer.accesses.updateOne({ id: owner.id, username: owner.username }, { id: owner.personalAccessId }, { lastUsed: T0 + 102 * DAY },
      (err) => (err ? reject(err) : resolve())));
    const delegation = getTransferDelegation();
    const stub = sinon.stub(delegation, 'withdraw').rejects(new Error('withdraw made to fail'));
    try {
      const s = await sweepFor([owner]);
      assert.equal((await s.run(T0 + 103 * DAY)).transfersCancelled, 1);
    } finally {
      stub.restore();
    }
    assert.equal((await state.getTransfer(owner.id)).status, 'cancelled');
    assert.equal((await delegation.stateOf(owner, claimant.username)).status, 'invite', 'the invite is still out');
  }

  async function accessesOf (u) {
    return await new Promise((resolve, reject) => storageLayer.accesses.find({ id: u.id, username: u.username }, {}, null, (err, rows) => (err ? reject(err) : resolve(rows))));
  }

  async function controlledBy (u) {
    const res = await coreRequest.get(`/${u.username}/delegations/controlled`).set('Authorization', u.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.controlled;
  }

  it('[ADCLP] a transfer cancelled while its claim invite could not be withdrawn: the invite can no longer be accepted', async function () {
    const owner = await freshUser();
    const claimant = await freshUser({ prefix: 'adcb' });
    await cancelledWithInviteOut(owner, claimant);
    assert.equal((await controlledBy(claimant)).length, 1, 'the claimant sees the invite');
    const accepted = await accept(claimant, owner);
    assert.equal(accepted.status, 410, JSON.stringify(accepted.body));
    const delegation = getTransferDelegation();
    assert.equal((await delegation.stateOf(owner, claimant.username)).status, 'none', 'the invite is gone on the owner\'s side');
    assert.deepEqual(await controlledBy(claimant), [], 'and on the claimant\'s side');
    assert.ok(!(await accessesOf(owner)).some((a) => a.clientData?.delegation != null), 'no capability or control access left');
    // What the sweep reads next: the transfer stays cancelled, nothing completes.
    const r = await (await sweepFor([owner])).run(T0 + 104 * DAY);
    assert.equal(r.transfersCompleted, 0);
    assert.equal((await state.getTransfer(owner.id)).status, 'cancelled');
  });

  describe('[ADTI] delegation invites beside a transfer', function () {
    it('[ADTI1] an invite sent before invites carried their purpose, named by the record: refused once the transfer ended', async function () {
      const owner = await freshUser();
      const claimant = await freshUser({ prefix: 'adcb' });
      await cancelledWithInviteOut(owner, claimant, async () => {
        const mall = await require('mall').getMall();
        const anchor = await require('delegation/src/store.ts').findAnchorByDelegate(mall, owner.id, claimant.username);
        assert.equal(anchor.content.purpose, 'account-transfer');
        await mall.events.updateWithMerge(owner.id, anchor.id, (stored) => {
          const { purpose: _p, ...content } = stored.content;
          return { ...stored, content };
        });
        const stripped = await require('delegation/src/store.ts').findAnchorByDelegate(mall, owner.id, claimant.username);
        assert.equal(stripped.content.purpose, undefined, 'stored without a purpose');
      });
      assert.equal((await state.getTransfer(owner.id)).claimedBy.relId != null, true, 'the record names the invite');
      const accepted = await accept(claimant, owner);
      assert.equal(accepted.status, 410, JSON.stringify(accepted.body));
      assert.equal((await getTransferDelegation().stateOf(owner, claimant.username)).status, 'none');
    });

    it('[ADTI2] ordinary invites are accepted beside a transfer cancelled, or claimed by another account', async function () {
      const attachRequest = (from, to) => coreRequest.post(`/${from.username}/delegations/attach-request`).set('Authorization', from.token).send({ delegateUsername: to.username });
      // Cancelled: an ordinary invite to the same claimant afterwards.
      const owner = await freshUser();
      const claimant = await freshUser({ prefix: 'adcb' });
      await openWindow(owner, transferTo('b@adcl.example.com'));
      const record = await state.getTransfer(owner.id);
      assert.equal((await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant)).status, 200);
      assert.equal((await reset({ username: owner.username, reason: REASON })).status, 200);
      assert.equal((await state.getTransfer(owner.id)).status, 'cancelled');
      assert.equal((await attachRequest(owner, claimant)).status, 201);
      const accepted = await accept(claimant, owner);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      // Claimed by another account (its invite out): an ordinary invite to a third one.
      const owner2 = await freshUser();
      const claimant2 = await freshUser({ prefix: 'adcb' });
      const third = await freshUser({ prefix: 'adct' });
      await openWindow(owner2, transferTo('b@adcl.example.com'));
      const record2 = await state.getTransfer(owner2.id);
      assert.equal((await claim(owner2, linkOf(owner2, 'claim', record2.claimSalt), claimant2)).status, 200);
      assert.equal((await attachRequest(owner2, third)).status, 201);
      const accepted2 = await accept(third, owner2);
      assert.equal(accepted2.status, 200, JSON.stringify(accepted2.body));
      assert.equal((await state.getTransfer(owner2.id)).status, 'claimed', 'the transfer is untouched');
      assert.equal((await accept(claimant2, owner2)).status, 200, 'and its own invite still accepted');
    });

    it('[ADTI3] the controlled-side entry (the claimant on another core) refuses it too', async function () {
      const owner = await freshUser();
      const claimant = await freshUser({ prefix: 'adcb' });
      await cancelledWithInviteOut(owner, claimant);
      const record = await state.getTransfer(owner.id);
      const capability = (await accessesOf(owner)).find((a) => a.clientData?.delegation?.kind === 'invite-capability');
      assert.ok(capability?.token != null);
      const res = await coreRequest.post(`/${owner.username}/delegations/controlled-side/accept-response`)
        .set('Authorization', capability.token)
        .send({ relId: record.claimedBy.relId, delegate: { username: claimant.username, hostSlug: record.claimedBy.hostSlug ?? 'self' } });
      assert.equal(res.status, 410, JSON.stringify(res.body));
      assert.equal((await getTransferDelegation().stateOf(owner, claimant.username)).status, 'none');
      assert.ok(!(await accessesOf(owner)).some((a) => a.clientData?.delegation?.kind === 'control'), 'no control access minted');
    });

    it('[ADTI4] asked once the relationship is active, a transfer completed meanwhile still counts', async function () {
      const { transferInviteRefusal } = require('api-server/src/methods/helpers/autoDeletion.ts');
      const u = await freshUser();
      const base = { email: 'b@adcl.example.com', createdAt: T0, declineSalt: 's', claimedBy: { username: 'adcbclaimant', relId: 'rel-1' } };
      const ask = (extra = {}) => transferInviteRefusal({ bUserId: u.id, relId: 'rel-1', delegateUsername: 'adcbclaimant', purpose: 'account-transfer', ...extra });
      await state.saveTransfer(u.id, { ...base, status: 'claimed' });
      assert.equal(await ask(), null);
      assert.equal(await ask({ activated: true }), null);
      assert.notEqual(await ask({ delegateUsername: 'adcbsomeoneelse' }), null, 'another account');
      await state.saveTransfer(u.id, { ...base, status: 'completed' });
      assert.equal(await ask({ activated: true }), null, 'completed by the sweep on seeing it active');
      assert.notEqual(await ask(), null, 'never before activation');
      await state.saveTransfer(u.id, { ...base, status: 'cancelled' });
      assert.notEqual(await ask({ activated: true }), null);
      assert.equal(await ask({ purpose: undefined, relId: 'rel-other' }), null, 'an ordinary invite: no say');
    });
  });

  it('[ADCLY] the sweep opens no claim window when the setting changed while the account was checked', async function () {
    const u = await freshUser();
    const armed = { mode: 'date', date: T0 + 20 * DAY, action: 'transfer', transfer: transferTo('b@adcl.example.com'), updatedAt: T0 };
    await state.setSetting(u.id, armed, 'test');
    let race = false;
    const s = await sweepFor([u], {
      readActivity: async (account) => {
        if (race) await state.setSetting(u.id, { ...armed, date: T0 + 60 * DAY, updatedAt: T0 + DAY }, 'test');
        return await getActivity(storageLayer.accesses, account, s.clock.t);
      }
    });
    for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
    race = true;
    const r = await s.run(T0 + 21 * DAY);
    assert.equal(r.transfersOpened, 0);
    assert.equal(await state.getTransfer(u.id), null);
    assert.deepEqual(s.sent.transfer, []);
  });

  it('[ADCLZ] the fallback erasure at the end of a window waits when the schedule changed meanwhile', async function () {
    const u = await freshUser();
    await openWindow(u, transferTo('b@adcl.example.com', { fallback: 'delete' }));
    const record = await state.getTransfer(u.id);
    let race = false;
    const s = await sweepFor([u], {
      readActivity: async (account) => {
        if (race) await state.saveBookkeeping(u.id, await state.getBookkeeping(u.id), null);
        return await getActivity(storageLayer.accesses, account, s.clock.t);
      }
    });
    race = true;
    const r = await s.run(record.endsAt + DAY);
    assert.equal(r.erased, 0, JSON.stringify(s.lines));
    assert.ok(await exists(u));
    assert.equal((await state.getTransfer(u.id)).status, 'open', 'not marked for erasure');
  });

  it('[ADCLQ] a change landing once the erasure is recorded as in progress: the record is withdrawn, nothing erased', async function () {
    const { Deletion } = require('business/src/auth/deletion.ts');
    const deletion = new Deletion(null, storageLayer, config);
    const u = await freshUser();
    await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
    let seenRecord = null;
    const s = await sweepFor([u], {
      erase: async (account, options) => deletion.eraseAccount(account, {
        teardown: true,
        trigger: options.trigger,
        confirm: async () => {
          seenRecord = await (await getErasuresLocal()).get(u.id);
          await state.setSetting(u.id, onDate(T0 + 60 * DAY), 'test');
          return await options.confirm();
        }
      })
    });
    for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
    const r = await s.run(T0 + 20 * DAY);
    assert.ok(seenRecord != null, 'recorded as in progress when the last look runs');
    assert.equal(r.erased, 0, JSON.stringify(s.lines));
    assert.ok(await exists(u));
    assert.equal(await (await getErasuresLocal()).get(u.id), null, 'the record withdrawn: no later pass completes it');
    assert.ok(!s.lines.some((l) => l.msg.includes('erasing account')), 'no erasure announced');
  });

  it('[ADCLO] an erasure run without the last look still records its start; a withdrawn one takes no slot of maxDeletionsPerPass', async function () {
    const { Deletion } = require('business/src/auth/deletion.ts');
    const deletion = new Deletion(null, storageLayer, config);
    // Without the last look (an erasure taken over completes whatever happened).
    const plain = await freshUser();
    await state.setSetting(plain.id, onDate(T0 + 20 * DAY), 'test');
    const recorded = [];
    const s1 = await sweepFor([plain], {
      erase: async (account, options) => deletion.eraseAccount(account, { teardown: true, trigger: options.trigger }),
      recordErasure: async (account) => { recorded.push(account.id); }
    });
    for (const d of [0, 13, 19]) await s1.run(T0 + d * DAY);
    assert.equal((await s1.run(T0 + 20 * DAY)).erased, 1);
    assert.deepEqual(recorded, [plain.id], 'its start recorded');
    assert.ok(s1.lines.some((l) => l.level === 'warn' && l.msg.includes('erasing account') && l.msg.includes(plain.username)));
    // Cap 1: the first erasure is withdrawn by its last look, the second goes ahead in the same pass.
    const changed = await freshUser();
    const other = await freshUser();
    for (const u of [changed, other]) await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
    const s2 = await sweepFor([changed, other], {
      erase: async (account, options) => deletion.eraseAccount(account, {
        teardown: true,
        trigger: options.trigger,
        confirm: async () => {
          if (account.id === changed.id) await state.setSetting(changed.id, onDate(T0 + 60 * DAY), 'test');
          return await options.confirm();
        }
      })
    });
    for (const d of [0, 13, 19]) await s2.run(T0 + d * DAY);
    await withInjectedConfig({ account: { autoDeletion: { maxDeletionsPerPass: 1 } } }, async () => {
      const r = await s2.run(T0 + 20 * DAY);
      assert.equal(r.erased, 1, JSON.stringify(s2.lines));
      assert.equal(r.deferred, 0);
      assert.equal(r.failed, 0);
    });
    assert.ok(await exists(changed));
    assert.equal(await exists(other), false);
  });

  it('[ADCLL] a fallback erasure run without the last look writes nothing for the erased account', async function () {
    const { Deletion } = require('business/src/auth/deletion.ts');
    const deletion = new Deletion(null, storageLayer, config);
    const u = await freshUser();
    await openWindow(u, transferTo('b@adcl.example.com', { fallback: 'delete' }));
    const record = await state.getTransfer(u.id);
    const recorded = [];
    // Without the last look (an erasure taken over completes whatever happened).
    const s = await sweepFor([u], {
      erase: async (account, options) => deletion.eraseAccount(account, { teardown: true, trigger: options.trigger }),
      recordErasure: async (account) => { recorded.push(account.id); }
    });
    const r = await s.run(record.endsAt + DAY);
    assert.equal(r.erased, 1, JSON.stringify(s.lines));
    assert.equal(await exists(u), false);
    assert.equal(await state.getTransfer(u.id), null, 'no transfer record written after the erasure');
    assert.deepEqual(recorded, [u.id], 'its start recorded');
    assert.ok(s.lines.some((l) => l.level === 'warn' && l.msg.includes('erasing account') && l.msg.includes(u.username)), JSON.stringify(s.lines));
    assert.ok(!s.lines.some((l) => l.level === 'error'), JSON.stringify(s.lines));
  });

  it('[ADCLR] a setting or a schedule changed between the pass\'s read and the erasure: not erased this pass', async function () {
    // The holder moves their date later; an administrator restarts a schedule.
    const moved = await freshUser();
    const restarted = await freshUser();
    await state.setSetting(moved.id, onDate(T0 + 100 * DAY), 'test');
    await state.setSetting(restarted.id, inactivity(100), 'test');
    let race = false;
    const s = await sweepFor([moved, restarted], {
      readActivity: async (account) => {
        if (race && account.id === moved.id) await state.setSetting(moved.id, onDate(T0 + 200 * DAY), 'test');
        if (race && account.id === restarted.id) await state.saveBookkeeping(restarted.id, await state.getBookkeeping(restarted.id), null);
        return await getActivity(storageLayer.accesses, account, s.clock.t);
      }
    });
    for (const d of [0, 40, 70, 93, 99]) await s.run(T0 + d * DAY);
    race = true;
    const r = await s.run(T0 + 100 * DAY);
    assert.equal(r.erased, 0, JSON.stringify(s.lines));
    assert.ok(await exists(moved), 'the moved date wins');
    assert.ok(await exists(restarted), 'the restarted schedule wins');
    assert.equal(s.lines.filter((l) => l.msg.includes('changed while being checked')).length, 2, JSON.stringify(s.lines));
    race = false;
    const next = await s.run(T0 + 100 * DAY + 60);
    assert.equal(next.erased, 0, 'judged on the new state by the next pass');
    assert.ok(await exists(moved) && await exists(restarted));
    assert.equal((await state.getBookkeeping(restarted.id)).deadline, T0 + 100 * DAY + 60 + 100 * DAY, 'its clock starts again');
  });
});
