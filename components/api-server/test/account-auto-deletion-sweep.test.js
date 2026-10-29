/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ACSW] account auto-deletion sweep, on real storage with a fake clock and a
 * fake mailer: reminders, activity, presets, guards, no-email accounts, the
 * erasure and its resumption, the pass guards (overlap, cap, dry run).
 * [ACRM] the same sweep with its real mailer (mail transport mocked): the
 * reminder and blocked mails, the confirmation as the first notice, failures.
 *
 * Each sweep here lists only the test's own accounts.
 */

const timestamp = require('unix-timestamp');
const { getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { createAutoDeletionState } = require('business/src/autoDeletion/state.ts');
const { getActivity } = require('business/src/accesses/accountActivity.ts');
const { setDeletionGuard } = require('business/src/auth/deletionTeardown.ts');
const { Deletion } = require('business/src/auth/deletion.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { createAccountAutoDeletionSweep, startAccountAutoDeletionSweep, isDesignatedLoopWorker } = require('api-server/src/methods/helpers/autoDeletionSweep.ts');
const { withInjectedConfig, injectTestConfigSnapshot } = require('test-helpers');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, sinon */

const DAY = 24 * 60 * 60;
const PASSWORD = 'acsw-password-123';
const DELEGATE_KIND = { delegation: { kind: 'delegate-pat', relId: 'acsw-rel', delegate: { username: 'acsw-parent', hostSlug: 'core' } } };
const BASE_CONFIG = {
  'user-account': { delete: ['adminToken', 'personalToken'] },
  services: { email: { enabled: { accountDeletionScheduled: false, accountDeletionReminder: false, accountDeletionBlocked: false } } }
};

// Accounts the guard below objects to.
const guarded = new Set();

describe('[ACSW] account auto-deletion sweep', function () {
  this.timeout(60000);

  let config, storageLayer, state, usersRepository, restoreBase, T0;

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();
    storageLayer = await getStorageLayer();
    state = createAutoDeletionState(require('storages').userAccountStorage);
    usersRepository = await getUsersRepository();
    restoreBase = injectTestConfigSnapshot(BASE_CONFIG);
    setDeletionGuard('acsw-test-guard', async (account) => guarded.has(account.id) ? { message: 'test objection', data: { test: true } } : null);
  });

  after(function () {
    restoreBase();
    guarded.clear();
  });

  beforeEach(function () {
    T0 = Math.floor(timestamp.now());
  });

  async function freshUser (opts = {}) {
    const username = ('acsw' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const attrs = { password: PASSWORD, language: 'en' };
    attrs.email = opts.email === false ? null : username + '@acsw.example.com';
    const fu = await getNewFixture().user(username, attrs);
    const token = cuid();
    const access = await fu.access({ type: 'personal', token });
    await fu.session(token);
    return { fu, username, token, id: fu.attrs.id, personalAccessId: access.attrs.id };
  }

  function setLastUsed (u, accessId, lastUsed) {
    return new Promise((resolve, reject) => storageLayer.accesses.updateOne({ id: u.id, username: u.username }, { id: accessId }, { lastUsed },
      (err) => (err ? reject(err) : resolve())));
  }

  function accessesOf (u) {
    return new Promise((resolve, reject) => storageLayer.accesses.find({ id: u.id, username: u.username }, {}, null,
      (err, rows) => (err ? reject(err) : resolve(rows ?? []))));
  }

  const inactivity = (days, extra = {}) => ({ mode: 'inactivity', inactivityDays: days, action: 'delete', updatedAt: T0, ...extra });
  const onDate = (date, extra = {}) => ({ mode: 'date', date, action: 'delete', updatedAt: T0, ...extra });

  /**
   * What `read` answers for an erased account, `empty` when per-user file
   * storage (SQLite) refuses to reopen the erased account's files.
   */
  async function goneOr (read, empty) {
    try {
      return await read();
    } catch (err) {
      if (/user directory erased/.test(String(err?.message))) return empty;
      throw err;
    }
  }

  async function exists (u) {
    return (await usersRepository.getUserIdForUsername(u.username)) != null;
  }

  function captureLogger () {
    const lines = [];
    const logger = {};
    for (const level of ['info', 'warn', 'error']) logger[level] = (msg, ctx) => lines.push({ level, msg, ctx });
    return { lines, logger };
  }

  /** A sweep over `users`, with a fake clock, a fake mailer and a captured log. */
  async function sweepFor (users, overrides = {}) {
    const clock = { t: T0 };
    const { lines, logger } = captureLogger();
    const sent = { reminder: [], blocked: [] };
    const mail = { outcome: 'sent' };
    const sweep = await createAccountAutoDeletionSweep(config, {
      listAccounts: async () => users.map((u) => ({ id: u.id, username: u.username })),
      now: () => clock.t,
      logger,
      sendReminder: async (account, facts, notice) => { sent.reminder.push({ username: account.username, leadDays: notice.leadDays, at: notice.now }); return mail.outcome; },
      sendBlocked: async (account) => { sent.blocked.push({ username: account.username }); return 'sent'; },
      ...overrides
    });
    return {
      sweep,
      clock,
      lines,
      sent,
      mail,
      run: async (t) => { if (t != null) clock.t = t; return await sweep.runPass(); }
    };
  }

  const leadsTo = (s, username) => s.sent.reminder.filter((m) => m.username === username).map((m) => m.leadDays);

  it('[ACSW1] accounts without a policy are skipped and never written', async function () {
    const plain = await freshUser();
    const never = await freshUser();
    const noEmail = await freshUser({ email: false });
    const group = await freshUser();
    await group.fu.access({ type: 'shared', token: cuid(), name: 'acsw-member', permissions: [{ streamId: '*', level: 'read' }], clientData: { cmc: { role: 'member' } } });
    await state.setSetting(never.id, { mode: 'never', action: 'delete', updatedAt: T0 }, 'test');
    const s = await sweepFor([plain, never, noEmail, group]);
    for (const t of [T0, T0 + 400 * DAY]) {
      const r = await s.run(t);
      assert.equal(r.accounts, 0);
    }
    await withInjectedConfig({ account: { autoDeletion: { inactivity: { defaultDays: 365 } } } }, async () => {
      await s.run(T0 + 500 * DAY);
    });
    for (const u of [never, noEmail, group]) {
      assert.equal(await state.getBookkeeping(u.id), null, u.username + ': no bookkeeping row');
      assert.ok(await exists(u));
    }
    assert.ok(await state.getBookkeeping(plain.id) != null, 'the preset covers the plain account');
    assert.deepEqual(s.sent.reminder, []);
  });

  it('[ACSW2] reminders at 60, 30, 7 and 1 days, each once, then the account is erased', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    const s = await sweepFor([u]);
    await s.run(T0);
    const b0 = await state.getBookkeeping(u.id);
    assert.equal(b0.policyAppliedAt, T0);
    assert.equal(b0.deadline, T0 + 100 * DAY);
    for (const d of [40, 40.25, 70, 70.5, 93, 99, 99.25]) await s.run(T0 + d * DAY);
    assert.deepEqual(leadsTo(s, u.username), [60, 30, 7, 1]);
    assert.ok(await exists(u), 'not before the deadline');
    const r = await s.run(T0 + 100 * DAY);
    assert.equal(r.erased, 1);
    assert.equal(await exists(u), false);
  });

  it('[ACSW3] a date trigger erases the account between two WARN lines, the trigger passed to the erasure', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
    const s = await sweepFor([u]);
    const spy = sinon.spy(Deletion.prototype, 'eraseAccount');
    try {
      for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
      assert.deepEqual(leadsTo(s, u.username), [7, 1], 'leads already past when the date was set are not sent');
      const r = await s.run(T0 + 20 * DAY);
      assert.equal(r.erased, 1, JSON.stringify(s.lines));
      const calls = spy.getCalls().filter((c) => c.args[0].id === u.id);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args[1], { teardown: true, trigger: 'date' });
    } finally {
      spy.restore();
    }
    const warns = s.lines.filter((l) => l.level === 'warn');
    const before = warns.findIndex((l) => l.msg.includes('erasing account') && l.msg.includes(u.username) && l.msg.includes(u.id));
    const afterIdx = warns.findIndex((l) => l.msg.includes('erased') && !l.msg.includes('erasing') && l.msg.includes(u.username));
    assert.ok(before >= 0 && afterIdx > before, JSON.stringify(warns));
    assert.equal(warns[before].ctx.trigger, 'date');
    assert.equal(warns[before].ctx.source, 'user');
    assert.equal(warns[before].ctx.notices.length, 2);
    assert.ok(!JSON.stringify(s.lines).includes('@acsw.example.com'), 'no email address in the log');
    // gone: index, accesses, account state (per-user files refuse to reopen)
    assert.equal(await usersRepository.getUserIdForUsername(u.username), null);
    assert.equal(await usersRepository.usersIndex.getUsername(u.id), null);
    assert.deepEqual(await goneOr(() => accessesOf(u), []), []);
    assert.equal(await goneOr(() => state.getBookkeeping(u.id), null), null);
    assert.equal(await goneOr(() => state.getSetting(u.id), null), null);
  });

  it('[ACSW4] use of the account moves the deadline and restarts the reminders; a pass moves no lastUsed', async function () {
    const u = await freshUser();
    await setLastUsed(u, u.personalAccessId, T0 - DAY);
    await state.setSetting(u.id, inactivity(100), 'test');
    const s = await sweepFor([u]);
    await s.run(T0);
    await s.run(T0 + 40 * DAY);
    assert.deepEqual(leadsTo(s, u.username), [60]);
    const lastUsed = (await accessesOf(u)).map((a) => a.lastUsed);
    assert.deepEqual(lastUsed, [T0 - DAY], 'the sweep is not use of the account');
    await setLastUsed(u, u.personalAccessId, T0 + 45 * DAY);
    await s.run(T0 + 45 * DAY);
    const b = await state.getBookkeeping(u.id);
    assert.equal(b.deadline, T0 + 145 * DAY);
    assert.deepEqual(b.reminders.sent, [], 'the schedule restarts');
    await s.run(T0 + 85 * DAY);
    assert.deepEqual(leadsTo(s, u.username), [60, 60]);
  });

  it('[ACSW5] shared-access use is ignored, a delegate\'s use counts and is reported', async function () {
    const sharedUser = await freshUser();
    const shared = await sharedUser.fu.access({ type: 'shared', token: cuid(), name: 'acsw-shared', permissions: [{ streamId: '*', level: 'read' }] });
    const delegated = await freshUser();
    const delegate = await delegated.fu.access({ type: 'personal', token: 'deleg-' + cuid(), name: 'delegation:acsw-parent@core', clientData: DELEGATE_KIND });
    for (const u of [sharedUser, delegated]) await state.setSetting(u.id, inactivity(100), 'test');
    const s = await sweepFor([sharedUser, delegated]);
    await s.run(T0);
    await setLastUsed(sharedUser, shared.attrs.id, T0 + 50 * DAY);
    await setLastUsed(delegated, delegate.attrs.id, T0 + 50 * DAY);
    await s.run(T0 + 50 * DAY);
    assert.equal((await state.getBookkeeping(sharedUser.id)).deadline, T0 + 100 * DAY);
    const b = await state.getBookkeeping(delegated.id);
    assert.equal(b.deadline, T0 + 150 * DAY);
    assert.equal(b.lastActivity.by, 'delegate');
    assert.equal(b.lastActivity.delegate, T0 + 50 * DAY);
  });

  it('[ACSW6] a preset gives a dormant account the full schedule; shrinking restarts the clock, growing keeps it', async function () {
    const u = await freshUser();
    await setLastUsed(u, u.personalAccessId, T0 - 1000 * DAY);
    const s = await sweepFor([u]);
    const preset = (days) => ({ account: { autoDeletion: { inactivity: { defaultDays: days } } } });
    await withInjectedConfig(preset(365), async () => {
      await s.run(T0);
      await s.run(T0 + DAY);
    });
    let b = await state.getBookkeeping(u.id);
    assert.equal(b.appliedPolicy.source, 'operator');
    assert.equal(b.policyAppliedAt, T0);
    assert.equal(b.deadline, T0 + 365 * DAY);
    assert.ok(await exists(u));
    assert.deepEqual(s.sent.reminder, []);
    await withInjectedConfig(preset(200), async () => { await s.run(T0 + 10 * DAY); });
    b = await state.getBookkeeping(u.id);
    assert.equal(b.policyAppliedAt, T0 + 10 * DAY, 'shrink: the clock restarts');
    assert.equal(b.deadline, T0 + 210 * DAY);
    await withInjectedConfig(preset(300), async () => { await s.run(T0 + 20 * DAY); });
    b = await state.getBookkeeping(u.id);
    assert.equal(b.policyAppliedAt, T0 + 10 * DAY, 'growth: the clock is kept');
    assert.equal(b.deadline, T0 + 310 * DAY);
  });

  it('[ACSW7] after downtime one reminder is sent and the minimum notice holds the erasure back', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    const s = await sweepFor([u]);
    await s.run(T0);
    await s.run(T0 + 99.5 * DAY);
    assert.deepEqual(leadsTo(s, u.username), [1]);
    const b = await state.getBookkeeping(u.id);
    assert.equal(b.deadlineReason, 'minimum-notice');
    assert.equal(b.deleteAt, T0 + 106.5 * DAY);
    await s.run(T0 + 101 * DAY);
    assert.ok(await exists(u), 'held back by the minimum notice');
    assert.equal((await s.run(T0 + 106.5 * DAY)).erased, 1);
    assert.equal(await exists(u), false);
  });

  it('[ACSW8] a guard refusal blocks the erasure, is mailed once, retried silently, then the erasure goes ahead', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
    const s = await sweepFor([u]);
    guarded.add(u.id);
    try {
      for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
      const r = await s.run(T0 + 20 * DAY);
      assert.equal(r.blocked, 1);
      assert.ok(await exists(u));
      let b = await state.getBookkeeping(u.id);
      assert.equal(b.blocked.reason, 'deletion-guard');
      assert.equal(b.blocked.notifiedAt, T0 + 20 * DAY);
      assert.equal(s.sent.blocked.length, 1);
      const warnsBefore = s.lines.filter((l) => l.level === 'warn').length;
      const again = await s.run(T0 + 21 * DAY);
      assert.equal(again.blocked, 0);
      assert.equal(s.sent.blocked.length, 1, 'mailed once');
      assert.equal(s.lines.filter((l) => l.level === 'warn').length, warnsBefore, 'retried silently');
      b = await state.getBookkeeping(u.id);
      assert.equal(b.blocked.at, T0 + 20 * DAY);
    } finally {
      guarded.delete(u.id);
    }
    assert.equal((await s.run(T0 + 22 * DAY)).erased, 1);
    assert.equal(await exists(u), false);
  });

  it('[ACSW9] no email: a preset skips the account, a user setting pauses unless acknowledged', async function () {
    const underPreset = await freshUser({ email: false });
    const paused = await freshUser({ email: false });
    const acknowledged = await freshUser({ email: false });
    await state.setSetting(paused.id, inactivity(100), 'test');
    await state.setSetting(acknowledged.id, inactivity(100, { acknowledgedNoReminders: true }), 'test');
    const s = await sweepFor([underPreset, paused, acknowledged]);
    await withInjectedConfig({ account: { autoDeletion: { inactivity: { defaultDays: 365 } } } }, async () => {
      await s.run(T0);
      await s.run(T0 + 99 * DAY);
      assert.equal(await state.getBookkeeping(underPreset.id), null);
      assert.equal((await state.getBookkeeping(paused.id)).blocked.reason, 'no-email');
      await s.run(T0 + 400 * DAY);
    });
    assert.ok(await exists(underPreset));
    assert.ok(await exists(paused), 'paused');
    assert.equal(await exists(acknowledged), false, 'acknowledged: runs without reminders');
    assert.deepEqual(s.sent, { reminder: [], blocked: [] });
  });

  it('[ACSW10] enabled: false makes the sweep inert and keeps it from starting', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
    const s = await sweepFor([u]);
    await withInjectedConfig({ account: { autoDeletion: { enabled: false } } }, async () => {
      for (const d of [0, 19, 30]) {
        const r = await s.run(T0 + d * DAY);
        assert.equal(r.accounts, 0);
      }
      assert.equal(await startAccountAutoDeletionSweep(config), null);
    });
    assert.equal(await state.getBookkeeping(u.id), null, 'nothing written');
    assert.ok(await exists(u));
    assert.deepEqual(s.sent.reminder, []);
    const started = await startAccountAutoDeletionSweep(config, { firstPassDelayMs: 3600 * 1000 });
    assert.ok(started != null);
    started.stop();
  });

  it('[ACSW11] a pass still running makes the next one a no-op', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    let release, signalEntered;
    let entered = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const inSend = new Promise((resolve) => { signalEntered = resolve; });
    const s = await sweepFor([u], {
      sendReminder: async () => { entered++; signalEntered(); await gate; return 'sent'; }
    });
    await s.run(T0);
    s.clock.t = T0 + 40 * DAY;
    const first = s.sweep.runPass();
    await inSend;
    assert.equal(entered, 1);
    const second = await s.sweep.runPass();
    assert.equal(second.skipped, true);
    release();
    const r = await first;
    assert.equal(r.reminders, 1);
    assert.equal(entered, 1, 'one send');
    assert.ok(s.lines.some((l) => l.msg.includes('still running')));
  });

  it('[ACSW12] maxDeletionsPerPass caps the erasures of a pass; the rest wait for the next one', async function () {
    const users = [await freshUser(), await freshUser(), await freshUser()];
    for (const u of users) await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
    const s = await sweepFor(users);
    for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
    await withInjectedConfig({ account: { autoDeletion: { maxDeletionsPerPass: 2 } } }, async () => {
      const r = await s.run(T0 + 20 * DAY);
      assert.equal(r.erased, 2);
      assert.equal(r.deferred, 1);
      const next = await s.run(T0 + 20.25 * DAY);
      assert.equal(next.erased, 1);
    });
    for (const u of users) assert.equal(await exists(u), false);
  });

  it('[ACSW13] a dry run sends, erases and writes nothing', async function () {
    const reminded = await freshUser();
    const due = await freshUser();
    const dormant = await freshUser();
    await state.setSetting(reminded.id, onDate(T0 + 40 * DAY), 'test');
    await state.setSetting(due.id, onDate(T0 + 20 * DAY), 'test');
    const s = await sweepFor([reminded, due, dormant]);
    for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
    const sentBefore = s.sent.reminder.length;
    const before = [await state.getBookkeeping(reminded.id), await state.getBookkeeping(due.id)];
    await withInjectedConfig({ account: { autoDeletion: { dryRun: true, inactivity: { defaultDays: 365 } } } }, async () => {
      const r = await s.run(T0 + 33 * DAY);
      assert.equal(r.wouldRemind, 1);
      assert.equal(r.wouldErase, 1);
      assert.equal(r.erased, 0);
      assert.equal(r.reminders, 0);
    });
    assert.equal(s.sent.reminder.length, sentBefore);
    assert.ok(await exists(due));
    assert.deepEqual([await state.getBookkeeping(reminded.id), await state.getBookkeeping(due.id)], before);
    assert.equal(await state.getBookkeeping(dormant.id), null, 'the preset\'s clock is not started by a dry run');
    assert.ok(s.lines.some((l) => l.msg.includes('dry run') && l.msg.includes('would erase') && l.msg.includes(due.username)));
  });

  it('[ACSW14] an erasure that fails half-way is completed on the next pass', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
    const s = await sweepFor([u]);
    for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
    // Fault between two steps: files, series and attachments are gone, the
    // audit erasure fails.
    const stub = sinon.stub(Deletion.prototype, 'deleteAuditDataStorage').callsFake(function (context, params, result, next) {
      next(new Error('injected fault'));
    });
    let r;
    try {
      r = await s.run(T0 + 20 * DAY);
    } finally {
      stub.restore();
    }
    assert.equal(r.erased, 0);
    assert.equal(r.failed, 1);
    assert.ok(await exists(u), 'half-erased');
    const b = await state.getBookkeeping(u.id);
    assert.equal(b.deleting.startedAt, T0 + 20 * DAY);
    assert.ok(s.lines.some((l) => l.level === 'error' && l.msg.includes('failed') && l.msg.includes('injected fault')));
    const again = await s.run(T0 + 20.25 * DAY);
    assert.equal(again.erased, 1, JSON.stringify(s.lines.slice(-4)));
    assert.equal(await exists(u), false);
    assert.ok(s.lines.some((l) => l.level === 'warn' && l.msg.includes('completing an earlier attempt')));
  });

  it('[ACSW15] a transfer is never erased by the sweep, reported once', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, onDate(T0 + 20 * DAY, { action: 'transfer', transfer: { email: 'b@acsw.example.com', notifyBeneficiary: 'atTrigger', fallback: 'delete' } }), 'test');
    const s = await sweepFor([u]);
    for (const d of [0, 19, 30, 31]) await s.run(T0 + d * DAY);
    assert.ok(await exists(u));
    assert.deepEqual(s.sent.reminder, []);
    assert.equal(s.lines.filter((l) => l.msg.includes('transferred')).length, 1);
  });

  it('[ACSW16] a use of the account between the evaluation and the erasure wins', async function () {
    const u = await freshUser();
    await state.setSetting(u.id, inactivity(100), 'test');
    let race = false;
    const s = await sweepFor([u], {
      readActivity: async (account) => {
        if (race) await setLastUsed(u, u.personalAccessId, s.clock.t);
        return await getActivity(storageLayer.accesses, account);
      }
    });
    for (const d of [0, 40, 70, 93, 99]) await s.run(T0 + d * DAY);
    race = true;
    const r = await s.run(T0 + 100 * DAY);
    assert.equal(r.erased, 0);
    assert.ok(await exists(u));
    assert.equal((await state.getBookkeeping(u.id)).deadline, T0 + 200 * DAY);
    assert.ok(s.lines.some((l) => l.msg.includes('used while being checked')));
  });

  it('[ACSW17] where the audit outlives the account, the erasure leaves an audit row', async function () {
    if (config.get('audit:active') !== true) this.skip();
    const auditStorage = require('storages').auditStorage;
    const userLocalDirectory = require('storage').userLocalDirectory;
    const u = await freshUser();
    await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
    const s = await sweepFor([u]);
    for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
    try {
      await withInjectedConfig({ audit: { onUserDelete: 'keep' } }, async () => {
        assert.equal((await s.run(T0 + 20 * DAY)).erased, 1);
      });
      assert.equal(await exists(u), false);
      const events = await (await auditStorage.forUser(u.id)).getEvents({ query: [], options: { limit: 1000 } });
      const row = (events ?? []).find((e) => e.content?.action === 'account.autoDeletion.erase');
      assert.ok(row != null, 'audit row of the erasure');
      assert.equal(row.createdBy, 'system');
      assert.equal(row.content.record.trigger, 'date');
      assert.equal(row.content.record.username, u.username);
    } finally {
      await auditStorage.deleteUser(u.id);
      await userLocalDirectory.deleteUserDirectory(u.id);
    }
  });

  it('[ACSW18] the sweep runs in the worker the master designates for the background loops', function () {
    assert.equal(isDesignatedLoopWorker({ PRYV_CMC_LOOP_WORKER: '1' }), true);
    assert.equal(isDesignatedLoopWorker({ PRYV_CMC_LOOP_WORKER: '0' }), false);
  });

  describe('[ACRM] reminder and blocked mails', function () {
    const nock = require('nock');
    const { useNock } = require('test-helpers/src/nockScope.ts');
    useNock();
    const MANDRILL = 'https://mandrillapp.local';
    const MANDRILL_PATH = '/api/1.0/messages/send-template.json';
    const MAIL_ON = {
      services: { email: { enabled: { accountDeletionScheduled: true, accountDeletionReminder: true, accountDeletionBlocked: true } } },
      service: { account: 'https://account.acsw.example.com/' }
    };

    afterEach(function () {
      nock.cleanAll();
    });

    function capture () {
      const captured = [];
      nock(MANDRILL).post(MANDRILL_PATH).times(20).reply(200, (uri, body) => { captured.push(body); return {}; });
      return captured;
    }

    const varsOf = (mail) => Object.fromEntries(mail.message.global_merge_vars.map((x) => [x.name, x.content]));

    /** The sweep with its real mailer, over `users`. */
    async function realMailSweep (users) {
      const clock = { t: T0 };
      const { lines, logger } = captureLogger();
      const sweep = await createAccountAutoDeletionSweep(config, {
        listAccounts: async () => users.map((u) => ({ id: u.id, username: u.username })),
        now: () => clock.t,
        logger
      });
      return { clock, lines, run: async (t) => { clock.t = t; return await sweep.runPass(); } };
    }

    it('[ACRM1] a reminder goes out with the schedule\'s variables, once', async function () {
      await withInjectedConfig(MAIL_ON, async () => {
        const u = await freshUser();
        const preset = await freshUser();
        await state.setSetting(u.id, inactivity(100), 'test');
        const s = await realMailSweep([u, preset]);
        await withInjectedConfig({ account: { autoDeletion: { inactivity: { defaultDays: 365 } } } }, async () => {
          await s.run(T0);
          const captured = capture();
          await s.run(T0 + 40 * DAY);
          await s.run(T0 + 40.25 * DAY);
          assert.equal(captured.length, 1, 'once');
          const mail = captured[0];
          assert.equal(mail.template_name, 'account-deletion-reminder');
          assert.equal(mail.message.to[0].email, u.username + '@acsw.example.com');
          const vars = varsOf(mail);
          assert.equal(vars.USERNAME, u.username);
          assert.equal(vars.DAYS_LEFT, '60');
          assert.equal(vars.TRIGGER, 'inactivity');
          assert.equal(vars.TRIGGER_INACTIVITY, 'true');
          assert.equal(vars.INACTIVITY_DAYS, '100');
          assert.equal(vars.ACTION, 'delete');
          assert.equal(vars.POLICY_OPERATOR, '');
          assert.ok(vars.DEADLINE.length > 0);
          assert.equal(vars.ACCOUNT_APP_URL, 'https://account.acsw.example.com/');
          assert.equal(vars.EXPORT_URL, 'https://account.acsw.example.com/account/data');
          const b = await state.getBookkeeping(u.id);
          assert.deepEqual(b.reminders.sent.map((x) => x.leadDays), [60]);
          nock.cleanAll();
          const presetMails = capture();
          await s.run(T0 + 305 * DAY);
          const vp = varsOf(presetMails.find((m) => m.message.to[0].email.startsWith(preset.username)));
          assert.equal(vp.POLICY_OPERATOR, 'true');
          assert.equal(vp.INACTIVITY_DAYS, '365');
        });
      });
    });

    it('[ACRM2] the confirmation is the first notice: a date two weeks out is erased on the day', async function () {
      await withInjectedConfig(MAIL_ON, async () => {
        const confirmed = await freshUser();
        const unconfirmed = await freshUser();
        const date = new Date((T0 + 15 * DAY) * 1000).toISOString();
        capture();
        const res = await coreRequest.put(`/${confirmed.username}/account/auto-deletion`).set('Authorization', confirmed.token).send({ mode: 'date', date, password: PASSWORD });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(typeof (await state.getBookkeeping(confirmed.id)).firstNoticeAt, 'number');
        await withInjectedConfig({ services: { email: { enabled: { accountDeletionScheduled: false } } } }, async () => {
          const res2 = await coreRequest.put(`/${unconfirmed.username}/account/auto-deletion`).set('Authorization', unconfirmed.token).send({ mode: 'date', date, password: PASSWORD });
          assert.equal(res2.status, 200, JSON.stringify(res2.body));
        });
        assert.equal((await state.getBookkeeping(unconfirmed.id)).firstNoticeAt, undefined);
        const s = await realMailSweep([confirmed, unconfirmed]);
        const at = Date.parse(date) / 1000;
        await s.run(at);
        assert.equal(await exists(confirmed), false, 'erased on the day');
        assert.ok(await exists(unconfirmed), 'its first notice is the reminder sent today');
        const b = await state.getBookkeeping(unconfirmed.id);
        assert.equal(b.deadlineReason, 'minimum-notice');
        assert.equal(b.deleteAt, at + 7 * DAY);
        await s.run(at + 7 * DAY);
        assert.equal(await exists(unconfirmed), false);
      });
    });

    it('[ACRM3] a failed reminder is not recorded, logged once, and sent at a later pass', async function () {
      await withInjectedConfig(MAIL_ON, async () => {
        const u = await freshUser();
        await state.setSetting(u.id, inactivity(100), 'test');
        const s = await realMailSweep([u]);
        await s.run(T0);
        nock(MANDRILL).post(MANDRILL_PATH).times(2).reply(500, {});
        await s.run(T0 + 40 * DAY);
        await s.run(T0 + 40.25 * DAY);
        assert.deepEqual((await state.getBookkeeping(u.id)).reminders.sent, []);
        assert.equal(s.lines.filter((l) => l.level === 'warn' && l.msg.includes('60-day reminder')).length, 1, 'logged once');
        const captured = capture();
        await s.run(T0 + 40.5 * DAY);
        assert.equal(captured.length, 1);
        assert.deepEqual((await state.getBookkeeping(u.id)).reminders.sent.map((x) => x.leadDays), [60]);
      });
    });

    it('[ACRM4] a blocked erasure is mailed once with its own template', async function () {
      await withInjectedConfig(MAIL_ON, async () => {
        const u = await freshUser();
        await state.setSetting(u.id, onDate(T0 + 20 * DAY), 'test');
        const s = await realMailSweep([u]);
        guarded.add(u.id);
        try {
          capture();
          for (const d of [0, 13, 19]) await s.run(T0 + d * DAY);
          nock.cleanAll();
          const captured = capture();
          await s.run(T0 + 20 * DAY);
          await s.run(T0 + 21 * DAY);
          const blocked = captured.filter((m) => m.template_name === 'account-deletion-blocked');
          assert.equal(blocked.length, 1);
          const vars = varsOf(blocked[0]);
          assert.equal(vars.USERNAME, u.username);
          assert.equal(vars.TRIGGER, 'date');
          assert.ok(vars.DEADLINE.length > 0);
        } finally {
          guarded.delete(u.id);
        }
      });
    });

    it('[ACRM5] reminders switched off: nothing is sent and the account is not erased', async function () {
      await withInjectedConfig({ ...MAIL_ON, services: { email: { enabled: { accountDeletionReminder: false } } } }, async () => {
        const u = await freshUser();
        await state.setSetting(u.id, inactivity(100), 'test');
        const s = await realMailSweep([u]);
        const captured = capture();
        await s.run(T0);
        const r = await s.run(T0 + 40 * DAY);
        assert.equal(r.remindersOff, 1);
        await s.run(T0 + 200 * DAY);
        assert.equal(captured.length, 0);
        assert.ok(await exists(u), 'no notice, no erasure');
      });
    });
  });
});
