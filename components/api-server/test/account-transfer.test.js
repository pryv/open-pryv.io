/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ACTR] account transfer to a beneficiary: the setting (validation, password,
 * the beneficiary's identity encrypted at rest), the notice at setup and the
 * decline link, the sweep's claim window (opening, re-sent links, account use,
 * the fallbacks at its end), and the claim (`account.transferClaim`) through
 * the delegation handshake, with its refusals and limits.
 *
 * The sweep runs with a fake clock and a captured transfer mailer; the API
 * methods run on the real clock. Claims come from documentation addresses
 * (X-Forwarded-For from the loopback proxy), cleared after the suite.
 */

const timestamp = require('unix-timestamp');
const { getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { createAutoDeletionState, IDENTITY_FIELD } = require('business/src/autoDeletion/state.ts');
const { deriveLinkToken } = require('business/src/autoDeletion/transfer.ts');
const { setDeletionGuard } = require('business/src/auth/deletionTeardown.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getErasuresLocal } = require('business/src/auth/erasures.ts');
const { Deletion } = require('business/src/auth/deletion.ts');
const { clearPasswordIpThrottle } = require('business/src/auth/passwordIpThrottle.ts');
const { createAccountAutoDeletionSweep } = require('api-server/src/methods/helpers/autoDeletionSweep.ts');
const { transferLinkKey, transferIdentityKey } = require('api-server/src/methods/helpers/autoDeletionPolicy.ts');
const { withInjectedConfig, injectTestConfigSnapshot } = require('test-helpers');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const DAY = 24 * 60 * 60;
const PASSWORD = 'actr-password-123';
const APP_ID = 'pryv-test-no-cors';
const ORIGIN = 'http://test.pryv.local';
const ACCOUNT_APP = 'https://account.actr.example.com/';
const ADDRESSES = ['198.51.100.31', '198.51.100.32', '198.51.100.33', '198.51.100.34'];
const DEFAULT_PER_IP = { maxFailures: 30, windowSeconds: 900 };
const WIDE = 100000000;
// Only the two mails a transfer cannot do without (it is not offered without them).
const BASE_MAILS = {
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
  services: { email: { enabled: BASE_MAILS } }
};

const guarded = new Set();

describe('[ACTR] account transfer', function () {
  this.timeout(60000);

  let config, storageLayer, accountStorage, state, usersRepository, restoreBase, T0;

  before(async function () {
    await initTests();
    await initCore();
    await require('api-server/src/methods/delegations.ts').default(global.app.api);
    config = await getConfig();
    storageLayer = await getStorageLayer();
    accountStorage = require('storages').userAccountStorage;
    state = createAutoDeletionState(accountStorage);
    usersRepository = await getUsersRepository();
    restoreBase = injectTestConfigSnapshot(BASE_CONFIG);
    setDeletionGuard('actr-test-guard', async (account) => guarded.has(account.id) ? { message: 'test objection', data: { test: true } } : null);
  });

  after(async function () {
    restoreBase();
    guarded.clear();
    await clearPasswordIpThrottle(ADDRESSES, DEFAULT_PER_IP);
    await clearPasswordIpThrottle(ADDRESSES, { maxFailures: 2, windowSeconds: WIDE });
  });

  beforeEach(async function () {
    T0 = Math.floor(timestamp.now());
    await clearPasswordIpThrottle(ADDRESSES, DEFAULT_PER_IP);
  });

  async function freshUser (prefix = 'actr') {
    const username = (prefix + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await getNewFixture().user(username, { password: PASSWORD, language: 'en', email: username + '@actr.example.com' });
    const token = cuid();
    const access = await fu.access({ type: 'personal', token });
    await fu.session(token);
    return { fu, username, token, id: fu.attrs.id, personalAccessId: access.attrs.id, email: username + '@actr.example.com' };
  }

  function get (u) {
    return coreRequest.get(`/${u.username}/account/auto-deletion`).set('Authorization', u.token);
  }

  function set (u, body) {
    return coreRequest.put(`/${u.username}/account/auto-deletion`).set('Authorization', u.token).send(body);
  }

  function claim (owner, token, claimant, address = ADDRESSES[0]) {
    return coreRequest.post(`/${owner.username}/account/auto-deletion/transfer-claim`)
      .set('Origin', ORIGIN).set('X-Forwarded-For', address)
      .send({ appId: APP_ID, token, claimant: claimant.username ?? claimant });
  }

  function decline (owner, token, address = ADDRESSES[0]) {
    return coreRequest.post(`/${owner.username}/account/auto-deletion/transfer-decline`)
      .set('Origin', ORIGIN).set('X-Forwarded-For', address)
      .send({ appId: APP_ID, token });
  }

  function accept (claimant, owner) {
    return coreRequest.post(`/${claimant.username}/delegations/controlled/${owner.username}/accept`)
      .set('Authorization', claimant.token).send({});
  }

  const errorId = (res) => res.body?.error?.id;
  const inDays = (days) => new Date((timestamp.now() + days * DAY) * 1000).toISOString();
  const linkOf = (owner, kind, salt) => deriveLinkToken(transferLinkKey(config), kind, owner.id, salt);
  const transferTo = (email, extra = {}) => ({ email, notifyBeneficiary: 'atTrigger', fallback: 'keep', ...extra });

  /** A transfer setting written directly (no mail, no password), due on day `days`. */
  async function armTransfer (u, transfer, days = 20, mode = 'date') {
    const setting = mode === 'date'
      ? { mode: 'date', date: T0 + days * DAY, action: 'transfer', transfer, updatedAt: T0 }
      : { mode: 'inactivity', inactivityDays: days, action: 'transfer', transfer, updatedAt: T0 };
    await state.setSetting(u.id, setting, 'test');
    return setting;
  }

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

  /**
   * A sweep over `users`, with a fake clock, captured reminders and transfer
   * mails (`realMail`: the real mailer instead).
   */
  async function sweepFor (users, { realMail = false, ...overrides } = {}) {
    const clock = { t: T0 };
    const { lines, logger } = captureLogger();
    const sent = { reminder: [], blocked: [], transfer: [] };
    const mailers = realMail
      ? {}
      : {
          sendReminder: async (account, facts, notice) => { sent.reminder.push({ username: account.username, leadDays: notice.leadDays, at: notice.now }); return 'sent'; },
          sendBlocked: async (account) => { sent.blocked.push({ username: account.username }); return 'sent'; },
          sendTransferMail: async (account, facts, notice) => {
            sent.transfer.push({ username: account.username, kind: notice.kind, to: notice.to, at: notice.now, salt: notice.record.claimSalt, reason: notice.reason, status: notice.record.status });
            return 'sent';
          }
        };
    const sweep = await createAccountAutoDeletionSweep(config, {
      listAccounts: async () => users.map((u) => ({ id: u.id, username: u.username })),
      listPendingErasures: () => pendingOf(users),
      now: () => clock.t,
      logger,
      ...mailers,
      ...overrides
    });
    return { sweep, clock, lines, sent, run: async (t) => { if (t != null) clock.t = t; return await sweep.runPass(); } };
  }

  const mailsOf = (s, kind, to) => s.sent.transfer.filter((m) => m.kind === kind && (to == null || m.to === to));

  /** Arms a 20-day date transfer and runs the sweep up to the opening of the claim window. */
  async function openWindow (u, transfer, extra = {}) {
    await armTransfer(u, transfer);
    const s = await sweepFor([u], extra);
    for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
    const r = await s.run(T0 + 21 * DAY);
    return { s, r };
  }

  async function exists (u) {
    return (await usersRepository.getUserIdForUsername(u.username)) != null;
  }

  describe('[ACTR1] availability', function () {
    it('[ACTR1A] transfer is offered with delegation, mail and the account app; not without the account app', async function () {
      const u = await freshUser();
      assert.deepEqual((await get(u)).body.autoDeletion.actions, ['delete', 'transfer']);
      assert.deepEqual((await coreRequest.get(`/${u.username}/service/info`)).body.features.autoDeletion.actions, ['delete', 'transfer']);
      await withInjectedConfig({ service: { account: '' } }, async () => {
        assert.deepEqual((await get(u)).body.autoDeletion.actions, ['delete']);
      });
      await withInjectedConfig({ delegation: { active: false } }, async () => {
        assert.deepEqual((await get(u)).body.autoDeletion.actions, ['delete']);
      });
      await withInjectedConfig({ services: { email: { enabled: { ...BASE_MAILS, accountTransferClaim: false } } } }, async () => {
        assert.deepEqual((await get(u)).body.autoDeletion.actions, ['delete'], 'without the claim mail no transfer can reach its beneficiary');
      });
      await withInjectedConfig({ services: { email: { enabled: { ...BASE_MAILS, accountTransferNamed: false } } } }, async () => {
        const res = await set(u, { mode: 'date', date: inDays(30), action: 'transfer', transfer: transferTo('b@actr.example.com', { notifyBeneficiary: 'atSetup' }), password: PASSWORD });
        assert.equal(errorId(res), 'auto-deletion-transfer-invalid');
        assert.equal(res.body.error.data.reason, 'named-mail-off');
      });
      await withInjectedConfig({ service: { account: '' }, 'user-account': { delete: ['adminToken'] } }, async () => {
        assert.ok(!('autoDeletion' in (await coreRequest.get(`/${u.username}/service/info`)).body.features), 'nothing settable, no preset: hidden');
      });
    });

    it('[ACTR1B] transfer alone keeps the feature advertised where self-deletion is off', async function () {
      const u = await freshUser();
      await withInjectedConfig({ 'user-account': { delete: ['adminToken'] } }, async () => {
        assert.deepEqual((await coreRequest.get(`/${u.username}/service/info`)).body.features.autoDeletion.actions, ['transfer']);
      });
    });
  });

  describe('[ACTR2] the setting', function () {
    it('[ACTR2A] a transfer is checked: address, someone else, notice, fallback, date of birth', async function () {
      const u = await freshUser();
      const base = { mode: 'date', date: inDays(30), action: 'transfer', password: PASSWORD };
      const refused = async (transfer, param) => {
        const res = await set(u, { ...base, transfer });
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(errorId(res), 'auto-deletion-transfer-invalid', JSON.stringify(res.body));
        assert.equal(res.body.error.data.param, param);
      };
      await refused(transferTo('not-an-address'), 'email');
      await refused(transferTo(u.email.toUpperCase()), 'email');
      await refused({ email: 'b@actr.example.com', fallback: 'keep' }, 'notifyBeneficiary');
      await refused({ email: 'b@actr.example.com', notifyBeneficiary: 'atTrigger' }, 'fallback');
      await refused(transferTo('b@actr.example.com', { dateOfBirth: '1990-02-30' }), 'dateOfBirth');
      await refused(transferTo('b@actr.example.com', { dateOfBirth: '2999-01-01' }), 'dateOfBirth');
      await withInjectedConfig({ 'user-account': { delete: ['adminToken'] } }, async () => {
        await refused(transferTo('b@actr.example.com', { fallback: 'delete' }), 'fallback');
      });
      const never = await set(u, { mode: 'never', action: 'transfer', transfer: transferTo('b@actr.example.com') });
      assert.equal(errorId(never), 'invalid-parameters-format', 'a transfer needs a date or a period');
      assert.equal(await state.getSetting(u.id), null, 'nothing written');
    });

    it('[ACTR2B] setting or changing a transfer needs the password, even on the same schedule', async function () {
      const u = await freshUser();
      const date = inDays(30);
      assert.equal((await set(u, { mode: 'date', date, password: PASSWORD })).status, 200);
      const toTransfer = { mode: 'date', date, action: 'transfer', transfer: transferTo('b@actr.example.com') };
      assert.equal(errorId(await set(u, toTransfer)), 'auto-deletion-password-required', 'delete to transfer');
      const ok = await set(u, { ...toTransfer, password: PASSWORD });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.autoDeletion.setting.transfer, { email: 'b@actr.example.com', notifyBeneficiary: 'atTrigger', fallback: 'keep' });
      assert.equal(ok.body.autoDeletion.effective.action, 'transfer');
      assert.equal(ok.body.autoDeletion.transfer, null, 'atTrigger: nothing happens before the deadline');
      assert.equal((await set(u, toTransfer)).status, 200, 'the same transfer again needs no password');
      assert.equal(errorId(await set(u, { ...toTransfer, transfer: transferTo('c@actr.example.com') })), 'auto-deletion-password-required', 'another beneficiary');
      assert.equal(errorId(await set(u, { ...toTransfer, transfer: transferTo('b@actr.example.com', { fallback: 'delete' }) })), 'auto-deletion-password-required', 'another fallback');
      assert.equal(errorId(await set(u, { ...toTransfer, transfer: transferTo('b@actr.example.com', { name: 'B' }) })), 'auto-deletion-password-required', 'a name');
      assert.equal(errorId(await set(u, { mode: 'date', date, action: 'delete' })), 'auto-deletion-password-required', 'transfer to delete is nearer');
      assert.equal((await set(u, { mode: 'never' })).status, 200, 'clearing needs none');
    });

    it('[ACTR2C] name and date of birth: encrypted at rest, never shown, kept for the same beneficiary, erased with every version otherwise', async function () {
      const u = await freshUser();
      const date = inDays(30);
      const withIdentity = transferTo('b@actr.example.com', { name: 'Beatrice Example', dateOfBirth: '1980-05-17' });
      const res = await set(u, { mode: 'date', date, action: 'transfer', transfer: withIdentity, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.autoDeletion.setting.transfer.identityGiven, true);
      assert.ok(!JSON.stringify(res.body).includes('Beatrice'), 'never answered');
      assert.ok(!JSON.stringify((await get(u)).body).includes('Beatrice'), 'never answered');
      const raw = await accountStorage.getAccountField(u.id, IDENTITY_FIELD);
      assert.equal(typeof raw, 'string');
      assert.ok(!raw.includes('Beatrice') && !raw.includes('1980'), 'stored encrypted');
      assert.deepEqual(await state.getIdentity(u.id, transferIdentityKey(config)), { name: 'Beatrice Example', dateOfBirth: '1980-05-17' });
      assert.ok(!JSON.stringify(await state.getSetting(u.id)).includes('Beatrice'), 'not in the setting');

      // Same beneficiary, no identity sent: kept.
      assert.equal((await set(u, { mode: 'date', date: inDays(40), action: 'transfer', transfer: transferTo('b@actr.example.com') })).status, 200);
      assert.equal((await state.getSetting(u.id)).transfer.identityGiven, true);
      assert.ok(await state.getIdentity(u.id, transferIdentityKey(config)) != null);
      // A replaced identity leaves no earlier version.
      assert.equal((await set(u, { mode: 'date', date, action: 'transfer', transfer: transferTo('b@actr.example.com', { name: 'Bea' }), password: PASSWORD })).status, 200);
      assert.equal((await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD)).length, 1);
      // Another beneficiary: erased, with every version.
      assert.equal((await set(u, { mode: 'date', date, action: 'transfer', transfer: transferTo('c@actr.example.com'), password: PASSWORD })).status, 200);
      assert.ok(await accountStorage.getAccountField(u.id, IDENTITY_FIELD) == null);
      assert.deepEqual(await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD), []);
      assert.equal((await state.getSetting(u.id)).transfer.identityGiven, undefined);
      // And when the action is no longer a transfer.
      await set(u, { mode: 'date', date, action: 'transfer', transfer: transferTo('c@actr.example.com', { dateOfBirth: '1970-01-01' }), password: PASSWORD });
      assert.ok(await state.getIdentity(u.id, transferIdentityKey(config)) != null);
      assert.equal((await set(u, { mode: 'never' })).status, 200);
      assert.deepEqual(await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD), []);
    });

    it('[ACTR2D] the identity goes with the account when it is deleted', async function () {
      const u = await freshUser();
      await set(u, { mode: 'date', date: inDays(30), action: 'transfer', transfer: transferTo('b@actr.example.com', { name: 'Bea' }), password: PASSWORD });
      assert.equal((await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD)).length, 1);
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { teardown: true });
      let history;
      try {
        history = await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD);
      } catch (err) {
        // per-user file storage (SQLite) refuses to reopen an erased account
        if (!/user directory erased/.test(String(err?.message))) throw err;
        history = [];
      }
      assert.deepEqual(history, []);
    });
  });

  describe('[ACTR3] the notice at setup and the decline link', function () {
    const nock = require('nock');
    const { pollUntil } = require('test-helpers');
    const { useNock } = require('test-helpers/src/nockScope.ts');
    useNock();
    const MANDRILL = 'https://mandrillapp.local';
    const MANDRILL_PATH = '/api/1.0/messages/send-template.json';

    afterEach(function () { nock.cleanAll(); });

    function capture () {
      const captured = [];
      nock(MANDRILL).post(MANDRILL_PATH).times(10).reply(200, (uri, body) => { captured.push(body); return {}; });
      return captured;
    }
    const varsOf = (mail) => Object.fromEntries(mail.message.global_merge_vars.map((x) => [x.name, x.content]));

    it('[ACTR3A] atSetup mails the beneficiary a decline link; declining falls back (delete) and tells the owner', async function () {
      await withInjectedConfig({ services: { email: { enabled: { ...BASE_MAILS, accountTransferNamed: true, accountTransferCancelled: true } } } }, async () => {
        const u = await freshUser();
        const captured = capture();
        const res = await set(u, { mode: 'date', date: inDays(30), action: 'transfer', transfer: transferTo('b@actr.example.com', { notifyBeneficiary: 'atSetup', fallback: 'delete', name: 'Bea' }), password: PASSWORD });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        await pollUntil(async () => captured.length, (n) => n >= 1, { timeoutMs: 3000 });
        const named = captured[0];
        assert.equal(named.template_name, 'account-transfer-named');
        assert.equal(named.message.to[0].email, 'b@actr.example.com');
        const vars = varsOf(named);
        assert.equal(vars.USERNAME, u.username);
        assert.equal(vars.IDENTITY_GIVEN, 'true');
        assert.equal(vars.CLAIM_LINK, '', 'no claim before the deadline');
        const record = await state.getTransfer(u.id);
        assert.equal(record.status, 'named');
        assert.equal(typeof record.namedAt, 'number');
        const token = linkOf(u, 'decline', record.declineSalt);
        assert.equal(vars.DECLINE_LINK, ACCOUNT_APP + 'transfer-decline?username=' + u.username + '&token=' + token);
        assert.ok(!JSON.stringify(record).includes(token), 'the link is not stored');
        assert.equal(res.body.autoDeletion.transfer.status, 'named');

        assert.equal(errorId(await decline(u, token + 'x')), 'auto-deletion-transfer-invalid-link');
        assert.equal(errorId(await decline(u, linkOf(u, 'claim', record.declineSalt))), 'auto-deletion-transfer-invalid-link', 'a claim token is no decline token');
        const ok = await decline(u, token);
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await state.getTransfer(u.id)).status, 'declined');
        const setting = await state.getSetting(u.id);
        assert.equal(setting.action, 'delete', 'the owner chose delete without a beneficiary');
        assert.equal(setting.transfer, undefined);
        assert.equal(await state.getIdentity(u.id, transferIdentityKey(config)), null, 'identity erased');
        await pollUntil(async () => captured.length, (n) => n >= 2, { timeoutMs: 3000 });
        const toOwner = captured.find((m) => m.template_name === 'account-transfer-cancelled');
        assert.equal(toOwner.message.to[0].email, u.email);
        assert.equal(varsOf(toOwner).REASON_DECLINED, 'true');
        assert.equal((await decline(u, token)).status, 200, 'declining again is harmless');
      });
    });

    it('[ACTR3C] the real mailer: the claim mail carries both links, the owner\'s says it started; reminders say "transferred"', async function () {
      await withInjectedConfig({ services: { email: { enabled: { ...BASE_MAILS, accountDeletionReminder: true, accountTransferClaim: true, accountTransferStarted: true } } } }, async () => {
        const u = await freshUser();
        await armTransfer(u, transferTo('b@actr.example.com', { fallback: 'delete', identityGiven: true }));
        await state.setIdentity(u.id, { name: 'Beatrice Example' }, transferIdentityKey(config), 'test');
        const captured = capture();
        const s = await sweepFor([u], { realMail: true });
        for (const d of [0, 13]) await s.run(T0 + d * DAY);
        await pollUntil(async () => captured.length, (n) => n >= 1, { timeoutMs: 3000 });
        const reminder = varsOf(captured[0]);
        assert.equal(captured[0].template_name, 'account-deletion-reminder');
        assert.equal(reminder.ACTION_TRANSFER, 'true');
        assert.equal(reminder.BENEFICIARY, 'Beatrice Example');
        assert.equal(reminder.FALLBACK_DELETE, 'true');
        await s.run(T0 + 19 * DAY);
        await s.run(T0 + 21 * DAY);
        await pollUntil(async () => captured.length, (n) => n >= 4, { timeoutMs: 3000 });
        const record = await state.getTransfer(u.id);
        const claimMail = captured.find((m) => m.template_name === 'account-transfer-claim');
        assert.equal(claimMail.message.to[0].email, 'b@actr.example.com');
        const vars = varsOf(claimMail);
        assert.equal(vars.CLAIM_LINK, ACCOUNT_APP + 'transfer-claim?username=' + u.username + '&token=' + linkOf(u, 'claim', record.claimSalt));
        assert.equal(vars.DECLINE_LINK, ACCOUNT_APP + 'transfer-decline?username=' + u.username + '&token=' + linkOf(u, 'decline', record.declineSalt));
        assert.equal(vars.IDENTITY_GIVEN, 'true');
        assert.equal(vars.BENEFICIARY_NAME, '', 'the name is never mailed to the beneficiary');
        assert.ok(!JSON.stringify(claimMail).includes('Beatrice'));
        assert.equal(vars.TO_BENEFICIARY, 'true');
        assert.ok(vars.WINDOW_END.length > 0);
        const started = captured.find((m) => m.template_name === 'account-transfer-started');
        assert.equal(started.message.to[0].email, u.email);
        assert.deepEqual(record.claimMailsSent.length, 1, 'recorded as sent');
      });
    });

    it('[ACTR3B] declining with fallback keep leaves "never"; a new beneficiary invalidates the old link', async function () {
      const u = await freshUser();
      await set(u, { mode: 'inactivity', inactivityDays: 365, action: 'transfer', transfer: transferTo('b@actr.example.com', { notifyBeneficiary: 'atSetup' }), password: PASSWORD });
      const first = await state.getTransfer(u.id);
      const oldToken = linkOf(u, 'decline', first.declineSalt);
      await set(u, { mode: 'inactivity', inactivityDays: 365, action: 'transfer', transfer: transferTo('c@actr.example.com', { notifyBeneficiary: 'atSetup' }), password: PASSWORD });
      const second = await state.getTransfer(u.id);
      assert.equal(second.email, 'c@actr.example.com');
      assert.equal(errorId(await decline(u, oldToken)), 'auto-deletion-transfer-invalid-link');
      assert.equal((await decline(u, linkOf(u, 'decline', second.declineSalt))).status, 200);
      assert.equal((await state.getSetting(u.id)).mode, 'never');
    });
  });

  describe('[ACTR4] the claim window', function () {
    it('[ACTR4A] opens at the deadline, once, with no reminder in that pass; the claim link is re-sent at +30 and +60 days, the same', async function () {
      const u = await freshUser();
      await armTransfer(u, transferTo('b@actr.example.com'));
      const s = await sweepFor([u]);
      for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
      assert.deepEqual(s.sent.reminder.map((m) => m.leadDays), [7, 1]);
      assert.equal(mailsOf(s, 'claim').length, 0, 'nothing before the deadline');
      const reminders = s.sent.reminder.length;
      const r = await s.run(T0 + 21 * DAY);
      assert.equal(r.transfersOpened, 1);
      assert.equal(r.erased, 0);
      assert.equal(s.sent.reminder.length, reminders, 'no reminder in the opening pass');
      assert.ok(await exists(u), 'never erased at the deadline');
      const record = await state.getTransfer(u.id);
      assert.equal(record.status, 'open');
      assert.equal(record.endsAt, T0 + 21 * DAY + 90 * DAY);
      assert.equal(mailsOf(s, 'claim', 'beneficiary').length, 1);
      assert.equal(mailsOf(s, 'started', 'owner').length, 1);
      assert.equal(typeof record.claimSalt, 'string');

      for (const d of [22, 40, 50]) assert.equal((await s.run(T0 + d * DAY)).transfersOpened, 0, 'opened once');
      assert.equal(mailsOf(s, 'claim').length, 1);
      await s.run(T0 + 52 * DAY);
      await s.run(T0 + 53 * DAY);
      assert.equal(mailsOf(s, 'claim').length, 2, 're-sent at +30 days, once');
      await s.run(T0 + 82 * DAY);
      const claims = mailsOf(s, 'claim');
      assert.equal(claims.length, 3);
      assert.ok(claims.every((m) => m.salt === record.claimSalt), 'the same link');
      assert.ok(mailsOf(s, 'started').length === 1);
    });

    it('[ACTR4B] dryRun opens no window', async function () {
      const u = await freshUser();
      await armTransfer(u, transferTo('b@actr.example.com'));
      const s = await sweepFor([u]);
      for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
      await withInjectedConfig({ account: { autoDeletion: { dryRun: true } } }, async () => {
        const r = await s.run(T0 + 21 * DAY);
        assert.equal(r.wouldOpen, 1);
        assert.equal(r.transfersOpened, 0);
      });
      assert.equal(await state.getTransfer(u.id), null);
      assert.equal(mailsOf(s, 'claim').length, 0);
    });

    it('[ACTR4C] inactivity: the owner returning before a claim cancels it and restarts the clock; a delegate\'s use too', async function () {
      for (const by of ['owner', 'delegate']) {
        const u = await freshUser();
        await armTransfer(u, transferTo('b@actr.example.com', { name: undefined }), 100, 'inactivity');
        await state.setIdentity(u.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
        const s = await sweepFor([u]);
        for (const d of [0, 40, 70, 93, 99]) await s.run(T0 + d * DAY);
        assert.equal((await s.run(T0 + 101 * DAY)).transfersOpened, 1);
        let accessId = u.personalAccessId;
        if (by === 'delegate') {
          const token = 'deleg-' + cuid();
          const access = await u.fu.access({ type: 'personal', token, name: 'delegation:x@core', clientData: { delegation: { kind: 'delegate-pat', relId: 'actr-rel', delegate: { username: 'x', hostSlug: 'core' } } } });
          accessId = access.attrs.id;
        }
        await new Promise((resolve, reject) => storageLayer.accesses.updateOne({ id: u.id, username: u.username }, { id: accessId }, { lastUsed: T0 + 102 * DAY },
          (err) => (err ? reject(err) : resolve())));
        const r = await s.run(T0 + 103 * DAY);
        assert.equal(r.transfersCancelled, 1, by);
        const record = await state.getTransfer(u.id);
        assert.equal(record.status, 'cancelled');
        assert.equal(record.closedReason, by + '-activity');
        assert.equal(mailsOf(s, 'cancelled', 'beneficiary').length, 1, 'the beneficiary had the claim link');
        assert.equal(mailsOf(s, 'cancelled', 'owner').length, 1);
        assert.ok(await state.getIdentity(u.id, transferIdentityKey(config)) != null, 'the transfer stays armed: identity kept');
        const b = await state.getBookkeeping(u.id);
        assert.equal(b.deadline, T0 + 102 * DAY + 100 * DAY, 'the clock restarted from the use');
        assert.equal((await state.getSetting(u.id)).action, 'transfer');
      }
    });

    it('[ACTR4D] date: account use does not cancel an open window', async function () {
      const u = await freshUser();
      const { s } = await openWindow(u, transferTo('b@actr.example.com'));
      await new Promise((resolve, reject) => storageLayer.accesses.updateOne({ id: u.id, username: u.username }, { id: u.personalAccessId }, { lastUsed: T0 + 22 * DAY },
        (err) => (err ? reject(err) : resolve())));
      await s.run(T0 + 23 * DAY);
      assert.equal((await state.getTransfer(u.id)).status, 'open');
    });

    it('[ACTR4E] the owner changing the setting while the window is open cancels the transfer and tells the beneficiary', async function () {
      const u = await freshUser();
      await openWindow(u, transferTo('b@actr.example.com'));
      assert.equal((await set(u, { mode: 'never' })).status, 200);
      const record = await state.getTransfer(u.id);
      assert.equal(record.status, 'cancelled');
      assert.equal(record.closedReason, 'owner-change');
    });
  });

  describe('[ACTR5] the claim', function () {
    async function openFor (transfer = transferTo('b@actr.example.com')) {
      const owner = await freshUser();
      const claimant = await freshUser('actb');
      const { s } = await openWindow(owner, transfer);
      const record = await state.getTransfer(owner.id);
      return { owner, claimant, s, token: linkOf(owner, 'claim', record.claimSalt) };
    }

    it('[ACTR5A] same core: claim, accept, claim again completes; the account is then controlled, setting and identity gone', async function () {
      const { owner, claimant, s, token } = await openFor(transferTo('b@actr.example.com', { fallback: 'delete' }));
      await state.setIdentity(owner.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
      const res = await claim(owner, token, claimant);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.transfer, { status: 'invited', username: owner.username });
      const bound = await state.getTransfer(owner.id);
      assert.equal(bound.status, 'claimed');
      assert.equal(bound.claimedBy.username, claimant.username);
      assert.equal(typeof bound.claimedBy.relId, 'string');
      assert.equal((await claim(owner, token, claimant)).body.transfer.status, 'invited', 'a repeat by the same account answers the same');
      const accepted = await accept(claimant, owner);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      const done = await claim(owner, token, claimant);
      assert.deepEqual(done.body.transfer, { status: 'completed', username: owner.username });
      const record = await state.getTransfer(owner.id);
      assert.equal(record.status, 'completed');
      assert.equal(record.claimedBy.username, claimant.username);
      assert.equal(await state.getSetting(owner.id), null, 'the setting goes');
      assert.equal(await state.getBookkeeping(owner.id), null);
      assert.deepEqual(await accountStorage.getAccountFieldHistory(owner.id, IDENTITY_FIELD), []);
      assert.equal((await claim(owner, token, claimant)).body.transfer.status, 'completed', 'idempotent');
      const other = await freshUser('actc');
      assert.equal(errorId(await claim(owner, token, other)), 'auto-deletion-transfer-claimed');
      // The sweep has nothing more to do, and never erases the account.
      await s.run(T0 + 200 * DAY);
      assert.ok(await exists(owner));
      const view = (await get(owner)).body.autoDeletion;
      assert.equal(view.transfer.status, 'completed');
      assert.equal(view.transfer.claimedBy.username, claimant.username);
    });

    it('[ACTR5B] the sweep completes a transfer once the claimant accepted', async function () {
      const { owner, claimant, s, token } = await openFor();
      assert.equal((await claim(owner, token, claimant)).status, 200);
      assert.equal((await accept(claimant, owner)).status, 200);
      const r = await s.run(T0 + 30 * DAY);
      assert.equal(r.transfersCompleted, 1);
      assert.equal((await state.getTransfer(owner.id)).status, 'completed');
      assert.equal(mailsOf(s, 'completed', 'owner').length, 1);
      assert.equal(mailsOf(s, 'completed', 'beneficiary').length, 1);
    });

    it('[ACTR5C] bound to the first claimant: another account is refused', async function () {
      const { owner, claimant, token } = await openFor();
      assert.equal((await claim(owner, token, claimant)).status, 200);
      const other = await freshUser('actc');
      const res = await claim(owner, token, other);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(errorId(res), 'auto-deletion-transfer-claimed');
    });

    it('[ACTR5D] a claimant who already controls the account completes the transfer at once', async function () {
      const { owner, claimant, token } = await openFor();
      const req = await coreRequest.post(`/${owner.username}/delegations/attach-request`).set('Authorization', owner.token).send({ delegateUsername: claimant.username });
      assert.equal(req.status, 201, JSON.stringify(req.body));
      assert.equal((await accept(claimant, owner)).status, 200);
      const res = await claim(owner, token, claimant);
      assert.equal(res.body.transfer?.status, 'completed', JSON.stringify(res.body));
    });

    it('[ACTR5E] an invite that lapsed inside the window is issued again', async function () {
      const { owner, claimant, token } = await openFor();
      assert.equal((await claim(owner, token, claimant)).status, 200);
      const firstRel = (await state.getTransfer(owner.id)).claimedBy.relId;
      const accesses = await new Promise((resolve, reject) => storageLayer.accesses.find({ id: owner.id, username: owner.username }, {}, null, (err, rows) => (err ? reject(err) : resolve(rows))));
      const capability = accesses.find((a) => a.clientData?.delegation?.kind === 'invite-capability');
      assert.ok(capability != null);
      await new Promise((resolve, reject) => storageLayer.accesses.updateOne({ id: owner.id, username: owner.username }, { id: capability.id }, { expires: timestamp.now() - 1 },
        (err) => (err ? reject(err) : resolve())));
      assert.equal((await claim(owner, token, claimant)).body.transfer.status, 'invited');
      const secondRel = (await state.getTransfer(owner.id)).claimedBy.relId;
      assert.notEqual(secondRel, firstRel, 'a new invite');
      assert.equal((await accept(claimant, owner)).status, 200, 'the new invite can be accepted');
    });

    it('[ACTR5F] refusals: a wrong token, a closed window, an unknown claimant', async function () {
      const { owner, claimant, token } = await openFor();
      assert.equal(errorId(await claim(owner, token.slice(1), claimant)), 'auto-deletion-transfer-invalid-link');
      // As on every /:username route (usernames are public): nothing about a transfer.
      const nobody = await claim({ username: 'actr-no-such-user' }, token, claimant);
      assert.equal(errorId(nobody), 'unknown-resource');
      const noTransfer = await freshUser();
      assert.equal(errorId(await claim(noTransfer, token, claimant)), 'auto-deletion-transfer-invalid-link', 'no transfer: the same answer as a wrong link');
      const unknown = await claim(owner, token, 'actrnosuchclaimant');
      assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
      assert.equal((await state.getTransfer(owner.id)).claimedBy, undefined, 'nothing bound when no invite went out');
      const record = await state.getTransfer(owner.id);
      await state.saveTransfer(owner.id, { ...record, endsAt: timestamp.now() - 1 });
      assert.equal(errorId(await claim(owner, token, claimant)), 'auto-deletion-transfer-expired');
    });

    it('[ACTR5G] failed claims are counted for the owner and never lock the valid link out; they count on the address budget', async function () {
      const { owner, claimant, token } = await openFor();
      for (let i = 0; i < 12; i++) {
        assert.equal(errorId(await claim(owner, 'wrong-' + i, claimant, ADDRESSES[1 + (i % 2)])), 'auto-deletion-transfer-invalid-link', 'the same answer past any count');
      }
      const noTransfer = await freshUser();
      for (let i = 0; i < 12; i++) await claim(noTransfer, 'wrong-' + i, claimant, ADDRESSES[1 + (i % 2)]);
      assert.equal(errorId(await claim(noTransfer, 'wrong', claimant, ADDRESSES[1])), 'auto-deletion-transfer-invalid-link', 'no oracle: as for an open transfer');
      assert.equal((await get(owner)).body.autoDeletion.transfer.failedClaims.count, 12, 'the owner sees them');
      assert.equal((await claim(owner, token, claimant, ADDRESSES[3])).status, 200, 'the valid link still proceeds');

      await withInjectedConfig({ auth: { passwordAttempts: { perIp: { maxFailures: 2, windowSeconds: WIDE } } } }, async () => {
        const other = await openFor();
        for (let i = 0; i < 2; i++) assert.equal(errorId(await claim(other.owner, 'bad-' + i, other.claimant, ADDRESSES[0])), 'auto-deletion-transfer-invalid-link');
        assert.equal(errorId(await claim(other.owner, other.token, other.claimant, ADDRESSES[0])), 'too-many-attempts');
        assert.equal((await claim(other.owner, other.token, other.claimant, ADDRESSES[1])).status, 200, 'another address is not refused');
      });
    });

    it('[ACTR5I] claims, refused ones included, are recorded in the owner\'s audit trail', async function () {
      const { pollUntil } = require('test-helpers');
      const { owner, claimant, token } = await openFor();
      assert.equal((await claim(owner, token, claimant)).status, 200);
      const other = await freshUser('actc');
      assert.equal(errorId(await claim(owner, token, other)), 'auto-deletion-transfer-claimed');
      const trail = async () => (await coreRequest.get(`/${owner.username}/events`).set('Authorization', owner.token)
        .query({ streams: JSON.stringify([':_audit:action-account.transferClaim']), limit: 20 })).body.events ?? [];
      const events = await pollUntil(trail, (list) => list.length >= 2, { timeoutMs: 5000 });
      assert.ok(events.length >= 2, JSON.stringify(events));
      assert.ok(events.some((e) => e.content?.error != null || e.type?.includes('error')), 'the refused claim is there: ' + JSON.stringify(events.map((e) => e.type)));
    });

    it('[ACTR5H] a claim and a decline cannot run inside a batch call', async function () {
      const { owner, token, claimant } = await openFor();
      const res = await coreRequest.post('/' + owner.username).set('Authorization', owner.token)
        .send([{ method: 'account.transferClaim', params: { appId: APP_ID, token, claimant: claimant.username } }]);
      assert.equal(res.body.results[0].error?.id, 'invalid-operation', JSON.stringify(res.body));
    });
  });

  describe('[ACTR6] the end of the window', function () {
    it('[ACTR6A] fallback keep: the transfer lapses, the setting becomes "never", identity erased, owner told', async function () {
      const u = await freshUser();
      const { s } = await openWindow(u, transferTo('b@actr.example.com'));
      await state.setIdentity(u.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
      const r = await s.run(T0 + 112 * DAY);
      assert.equal(r.transfersLapsed, 1);
      assert.ok(await exists(u));
      assert.equal((await state.getTransfer(u.id)).status, 'lapsed');
      assert.equal((await state.getSetting(u.id)).mode, 'never');
      assert.equal(await state.getBookkeeping(u.id), null);
      assert.deepEqual(await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD), []);
      assert.equal(mailsOf(s, 'lapsed', 'owner').length, 1);
    });

    it('[ACTR6B] fallback keep without opt-out: the platform preset applies from the lapse, with its full schedule', async function () {
      const u = await freshUser();
      const { s } = await openWindow(u, transferTo('b@actr.example.com'));
      await withInjectedConfig({ account: { autoDeletion: { allowUserOptOut: false, inactivity: { defaultDays: 365 } } } }, async () => {
        await s.run(T0 + 112 * DAY);
        assert.equal(await state.getSetting(u.id), null, 'the platform policy applies');
        await s.run(T0 + 113 * DAY);
        const b = await state.getBookkeeping(u.id);
        assert.equal(b.appliedPolicy.source, 'operator');
        assert.equal(b.policyAppliedAt, T0 + 113 * DAY, 'its clock starts from the lapse');
      });
    });

    it('[ACTR6C] fallback delete: erased as a direct deletion, trigger transfer-fallback; a pending claim invite is withdrawn first', async function () {
      const owner = await freshUser();
      const claimant = await freshUser('actb');
      const { s } = await openWindow(owner, transferTo('b@actr.example.com', { fallback: 'delete' }));
      const record = await state.getTransfer(owner.id);
      assert.equal((await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant)).status, 200);
      const r = await s.run(T0 + 112 * DAY);
      assert.equal(r.erased, 1);
      assert.equal(await exists(owner), false);
      const erasing = s.lines.find((l) => l.msg.includes('erasing account'));
      assert.equal(erasing.ctx.trigger, 'transfer-fallback');
      const mirrors = await coreRequest.get(`/${claimant.username}/delegations/controlled`).set('Authorization', claimant.token);
      assert.deepEqual((mirrors.body.controlled ?? []).filter((c) => c.controlled.username === owner.username), [], 'the invite is gone');
    });

    it('[ACTR6D] fallback delete is held by a guard and by self-deletion withdrawn, like a direct deletion', async function () {
      const guardedOwner = await freshUser();
      const { s } = await openWindow(guardedOwner, transferTo('b@actr.example.com', { fallback: 'delete' }));
      guarded.add(guardedOwner.id);
      try {
        const r = await s.run(T0 + 112 * DAY);
        assert.equal(r.blocked, 1);
        assert.ok(await exists(guardedOwner));
        assert.equal((await state.getBookkeeping(guardedOwner.id)).blocked.reason, 'deletion-guard');
        assert.equal(s.sent.blocked.length, 1);
      } finally {
        guarded.delete(guardedOwner.id);
      }
      await s.run(T0 + 113 * DAY);
      assert.equal(await exists(guardedOwner), false, 'erased once the guard lets it');

      const held = await freshUser();
      const second = await openWindow(held, transferTo('b@actr.example.com', { fallback: 'delete' }));
      await withInjectedConfig({ 'user-account': { delete: ['adminToken'] } }, async () => {
        await second.s.run(T0 + 112 * DAY);
      });
      assert.ok(await exists(held));
      assert.equal((await state.getBookkeeping(held.id)).blocked.reason, 'self-deletion-disabled');
    });

    it('[ACTR6E] a beneficiary declining during the window applies the fallback', async function () {
      const keep = await freshUser();
      await openWindow(keep, transferTo('b@actr.example.com'));
      const k = await state.getTransfer(keep.id);
      assert.equal((await decline(keep, linkOf(keep, 'decline', k.declineSalt))).status, 200);
      assert.equal((await state.getTransfer(keep.id)).status, 'declined');
      assert.equal((await state.getSetting(keep.id)).mode, 'never');

      const del = await freshUser();
      const { s } = await openWindow(del, transferTo('b@actr.example.com', { fallback: 'delete' }));
      const d = await state.getTransfer(del.id);
      assert.equal((await decline(del, linkOf(del, 'decline', d.declineSalt))).status, 200);
      await s.run(T0 + 22 * DAY);
      assert.equal(await exists(del), false, 'erased by the next pass');
    });
  });

  describe('[ACTR7] edge cases', function () {
    async function useAt (u, t) {
      await new Promise((resolve, reject) => storageLayer.accesses.updateOne({ id: u.id, username: u.username }, { id: u.personalAccessId }, { lastUsed: t },
        (err) => (err ? reject(err) : resolve())));
    }

    it('[ACTR7A] inactivity: a use just before the window end wins over the fallback (delete)', async function () {
      const u = await freshUser();
      await armTransfer(u, transferTo('b@actr.example.com', { fallback: 'delete' }), 100, 'inactivity');
      const s = await sweepFor([u]);
      for (const d of [0, 40, 70, 93, 99]) await s.run(T0 + d * DAY);
      assert.equal((await s.run(T0 + 101 * DAY)).transfersOpened, 1);
      const endsAt = (await state.getTransfer(u.id)).endsAt;
      await useAt(u, endsAt - 3600);
      const r = await s.run(endsAt + 3600);
      assert.equal(r.erased, 0);
      assert.equal(r.transfersCancelled, 1);
      assert.ok(await exists(u));
      assert.equal((await state.getTransfer(u.id)).closedReason, 'owner-activity');
    });

    it('[ACTR7B] a completion left half-done is finished by the next pass, never reopened', async function () {
      const u = await freshUser();
      await openWindow(u, transferTo('b@actr.example.com'));
      const record = await state.getTransfer(u.id);
      await state.saveTransfer(u.id, { ...record, status: 'completed', claimedBy: { username: 'someone', at: T0 }, closedAt: timestamp.now() + 1 });
      const s = await sweepFor([u]);
      const r = await s.run(T0 + 30 * DAY);
      assert.equal(r.transfersOpened, 0);
      assert.equal(mailsOf(s, 'claim').length, 0);
      assert.equal(await state.getSetting(u.id), null, 'the setting is cleared');
      assert.equal((await state.getTransfer(u.id)).status, 'completed');
    });

    it('[ACTR7C] two first claims at once: one is bound, the other refused', async function () {
      const owner = await freshUser();
      const a = await freshUser('acta');
      const b = await freshUser('actb');
      await openWindow(owner, transferTo('b@actr.example.com'));
      const token = linkOf(owner, 'claim', (await state.getTransfer(owner.id)).claimSalt);
      const [ra, rb] = await Promise.all([claim(owner, token, a), claim(owner, token, b, ADDRESSES[1])]);
      const ids = [ra, rb].map((r) => r.body.transfer?.status ?? errorId(r)).sort();
      assert.deepEqual(ids, ['auto-deletion-transfer-claimed', 'invited'], JSON.stringify([ra.body, rb.body]));
      const bound = (await state.getTransfer(owner.id)).claimedBy.username;
      const loser = bound === a.username ? b : a;
      assert.notEqual((await accept(loser, owner)).status, 200, 'the other claimant has no invite to accept');
    });

    it('[ACTR7D] moving the date later, same beneficiary, closes the open window', async function () {
      const u = await freshUser();
      await openWindow(u, transferTo('b@actr.example.com'));
      const res = await set(u, { mode: 'date', date: inDays(60), action: 'transfer', transfer: transferTo('b@actr.example.com') });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const record = await state.getTransfer(u.id);
      assert.equal(record.status, 'cancelled');
      assert.equal(record.closedReason, 'owner-change');
    });

    it('[ACTR7E] a decline during the window (delete) erases the identity at once, even when a guard then holds the erasure', async function () {
      const u = await freshUser();
      const { s } = await openWindow(u, transferTo('b@actr.example.com', { fallback: 'delete' }));
      await state.setIdentity(u.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
      guarded.add(u.id);
      try {
        const record = await state.getTransfer(u.id);
        assert.equal((await decline(u, linkOf(u, 'decline', record.declineSalt))).status, 200);
        assert.deepEqual(await accountStorage.getAccountFieldHistory(u.id, IDENTITY_FIELD), []);
        await s.run(T0 + 22 * DAY);
        assert.ok(await exists(u), 'held by the guard');
      } finally {
        guarded.delete(u.id);
      }
    });

    it('[ACTR7F] the claimant may still decline (invite withdrawn), and refusing the invite counts as declining', async function () {
      const owner = await freshUser();
      const claimant = await freshUser('actb');
      await openWindow(owner, transferTo('b@actr.example.com'));
      let record = await state.getTransfer(owner.id);
      assert.equal((await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant)).status, 200);
      assert.equal((await decline(owner, linkOf(owner, 'decline', record.declineSalt))).status, 200);
      assert.equal((await state.getTransfer(owner.id)).status, 'declined');
      assert.equal((await state.getSetting(owner.id)).mode, 'never', 'fallback keep');
      assert.notEqual((await accept(claimant, owner)).status, 200, 'the invite is withdrawn');

      const other = await freshUser();
      const c2 = await freshUser('actc');
      const { s } = await openWindow(other, transferTo('b@actr.example.com'));
      record = await state.getTransfer(other.id);
      assert.equal((await claim(other, linkOf(other, 'claim', record.claimSalt), c2)).status, 200);
      const refused = await coreRequest.post(`/${c2.username}/delegations/controlled/${other.username}/refuse`).set('Authorization', c2.token).send({});
      assert.equal(refused.status, 200, JSON.stringify(refused.body));
      const r = await s.run(T0 + 25 * DAY);
      assert.equal(r.transfersLapsed, 1);
      const closed = await state.getTransfer(other.id);
      assert.equal(closed.status, 'lapsed');
      assert.equal(closed.closedReason, 'declined');
    });

    it('[ACTR7G] the owner\'s "started" mail is retried until it goes out; a failed claim mail is sent once later', async function () {
      const u = await freshUser();
      await armTransfer(u, transferTo('b@actr.example.com'));
      const outcome = { value: 'failed' };
      const s = await sweepFor([u]);
      const sent = [];
      const flaky = await sweepFor([u], { sendTransferMail: async (account, facts, notice) => { sent.push(notice.kind); return outcome.value; } });
      for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
      await flaky.run(T0 + 21 * DAY);
      const opened = await state.getTransfer(u.id);
      assert.equal(opened.status, 'open');
      assert.equal(opened.ownerToldAt, undefined);
      assert.deepEqual(opened.claimMailsSent, []);
      outcome.value = 'sent';
      await flaky.run(T0 + 22 * DAY);
      await flaky.run(T0 + 23 * DAY);
      const after = await state.getTransfer(u.id);
      assert.equal(typeof after.ownerToldAt, 'number');
      assert.equal(after.claimMailsSent.length, 1, 'the claim mail once');
      assert.equal(sent.filter((k) => k === 'started').length, 1, 'held while the transport was down, then sent once');
      assert.equal(sent.filter((k) => k === 'claim').length, 2, 'one failed, one sent');
    });

    it('[ACTR7H] a claim for the account itself is refused, nothing bound; account.get never shows the transfer fields', async function () {
      const owner = await freshUser();
      await openWindow(owner, transferTo('b@actr.example.com', { name: 'Bea' }));
      await state.setIdentity(owner.id, { name: 'Bea' }, transferIdentityKey(config), 'test');
      const record = await state.getTransfer(owner.id);
      const self = await claim(owner, linkOf(owner, 'claim', record.claimSalt), owner);
      assert.equal(self.status, 400, JSON.stringify(self.body));
      assert.equal((await state.getTransfer(owner.id)).claimedBy, undefined);
      const account = (await coreRequest.get(`/${owner.username}/account`).set('Authorization', owner.token)).body.account;
      assert.ok(account != null);
      assert.ok(!('autoDeletionTransferIdentity' in account) && !('autoDeletion' in account), JSON.stringify(Object.keys(account)));
    });

    it('[ACTR7J] a decline after the claimant accepted comes too late: the transfer completes, the account stays', async function () {
      const owner = await freshUser();
      const claimant = await freshUser('actb');
      const { s } = await openWindow(owner, transferTo('b@actr.example.com', { fallback: 'delete' }));
      const record = await state.getTransfer(owner.id);
      assert.equal((await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant)).status, 200);
      assert.equal((await accept(claimant, owner)).status, 200, 'accepted from the delegation list');
      const late = await decline(owner, linkOf(owner, 'decline', record.declineSalt));
      assert.equal(errorId(late), 'auto-deletion-transfer-claimed', JSON.stringify(late.body));
      assert.equal((await state.getTransfer(owner.id)).status, 'completed');
      await s.run(T0 + 30 * DAY);
      assert.ok(await exists(owner));
    });

    it('[ACTR7K] inactivity: the owner returning after a claim not yet accepted cancels it (invite withdrawn)', async function () {
      const owner = await freshUser();
      const claimant = await freshUser('actb');
      await armTransfer(owner, transferTo('b@actr.example.com', { fallback: 'delete' }), 100, 'inactivity');
      const s = await sweepFor([owner]);
      for (const d of [0, 40, 70, 93, 99, 101]) await s.run(T0 + d * DAY);
      const record = await state.getTransfer(owner.id);
      assert.equal((await claim(owner, linkOf(owner, 'claim', record.claimSalt), claimant)).status, 200);
      // A wrong link after the claim leaves the claim as it is.
      await claim(owner, 'wrong', claimant, ADDRESSES[2]);
      assert.equal((await state.getTransfer(owner.id)).claimedBy.username, claimant.username);
      await useAt(owner, T0 + 102 * DAY);
      const r = await s.run(record.endsAt + DAY);
      assert.equal(r.transfersCancelled, 1);
      assert.equal(r.erased, 0);
      assert.ok(await exists(owner));
      assert.notEqual((await accept(claimant, owner)).status, 200, 'the invite is withdrawn');
    });

    it('[ACTR7L] a decline (delete) then the owner returning: the schedule goes on as a deletion, never a transfer to them again', async function () {
      const u = await freshUser();
      await armTransfer(u, transferTo('b@actr.example.com', { fallback: 'delete' }), 100, 'inactivity');
      const s = await sweepFor([u]);
      for (const d of [0, 40, 70, 93, 99, 101]) await s.run(T0 + d * DAY);
      const record = await state.getTransfer(u.id);
      assert.equal((await decline(u, linkOf(u, 'decline', record.declineSalt))).status, 200);
      await useAt(u, T0 + 102 * DAY);
      const r = await s.run(T0 + 103 * DAY);
      assert.equal(r.erased, 0);
      assert.ok(await exists(u));
      const setting = await state.getSetting(u.id);
      assert.equal(setting.action, 'delete');
      assert.equal(setting.transfer, undefined);
    });

    it('[ACTR7I] a beneficiary notice at setup that did not go out is sent by the next pass, once', async function () {
      const u = await freshUser();
      await armTransfer(u, transferTo('b@actr.example.com', { notifyBeneficiary: 'atSetup' }), 60);
      await state.saveTransfer(u.id, { email: 'b@actr.example.com', status: 'named', createdAt: T0, declineSalt: 'salt' });
      const s = await sweepFor([u]);
      await s.run(T0 + DAY);
      await s.run(T0 + 2 * DAY);
      assert.equal(mailsOf(s, 'named', 'beneficiary').length, 1);
      assert.equal(typeof (await state.getTransfer(u.id)).namedAt, 'number');
    });
  });
});
