/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ACXP] auto-deletion schedule engine, driven by a fake clock: effective
 * policy, deadlines, reminders, minimum notice, policy changes, no-email.
 */

const assert = require('node:assert/strict');
const { normalizeAutoDeletionConfig } = require('../../src/autoDeletion/config.ts');
const { effectivePolicy, evaluate, withNotice, nextReminderAt, leadsFor, DAY_SECONDS: DAY } = require('../../src/autoDeletion/deadline.ts');

const T0 = 1800000000; // a fixed "now" in pryv seconds
const config = normalizeAutoDeletionConfig({ inactivity: { defaultDays: 365 } });
const noActivity = { at: null, by: null, personal: null, app: null, delegate: null };
const used = (at, by = 'owner') => ({ at, by, personal: by === 'owner' ? at : null, app: null, delegate: by === 'delegate' ? at : null });
const preset = (days = 365) => ({ source: 'operator', mode: 'inactivity', inactivityDays: days, action: 'delete' });
const userDate = (date) => ({ source: 'user', mode: 'date', date, action: 'delete' });

// One sweep pass; a reminder it asks for is "sent" (recorded) at once.
function pass (state, now, input = {}) {
  const r = evaluate({ policy: preset(), activity: noActivity, prev: state, now, config, notifiable: true, ...input });
  let b = r.bookkeeping;
  if (r.reminder != null) b = withNotice(b, now, r.reminder);
  return { b, reminder: r.reminder, due: r.due };
}

describe('[ACXP] auto-deletion schedule engine', function () {
  it('[ACXP1] effective policy: the holder\'s setting, else the preset where it applies, else none', function () {
    const setting = { mode: 'date', date: T0 + 100 * DAY, action: 'delete', updatedAt: T0 };
    assert.deepEqual(effectivePolicy(setting, config, true), { source: 'user', mode: 'date', date: T0 + 100 * DAY, action: 'delete' });
    assert.deepEqual(effectivePolicy({ mode: 'never', action: 'delete', updatedAt: T0 }, config, true), { source: 'user', mode: 'never', action: 'delete' });
    assert.deepEqual(effectivePolicy(null, config, true), preset());
    assert.equal(effectivePolicy(null, config, false), null, 'group, controlled or no-email account');
    assert.equal(effectivePolicy(null, normalizeAutoDeletionConfig({}), true), null, 'no preset: never');
    assert.equal(effectivePolicy(setting, normalizeAutoDeletionConfig({ enabled: false }), true), null, 'feature off');
  });

  it('[ACXP2] a preset gives a dormant account the full schedule from the day it applies', function () {
    const { b, reminder, due } = pass(null, T0, { activity: used(T0 - 5 * 365 * DAY) });
    assert.equal(b.policyAppliedAt, T0);
    assert.equal(b.deadline, T0 + 365 * DAY);
    assert.equal(reminder, null);
    assert.equal(due, false);
  });

  it('[ACXP3] reminders at 60, 30, 7 and 1 days, once each, then due', function () {
    let s = pass(null, T0).b;
    const deadline = T0 + 365 * DAY;
    const sent = [];
    for (let now = T0 + DAY; now <= deadline + DAY; now += DAY / 4) {
      const r = pass(s, now);
      s = r.b;
      if (r.reminder != null) sent.push([r.reminder, (deadline - now) / DAY]);
      if (r.due) { assert.ok(now >= deadline); break; }
    }
    assert.deepEqual(sent.map(([lead]) => lead), [60, 30, 7, 1]);
    for (const [lead, daysLeft] of sent) assert.ok(daysLeft <= lead && daysLeft > lead - 1, `${lead}: ${daysLeft}`);
    assert.ok(pass(s, deadline).due);
  });

  it('[ACXP4] activity moves the deadline and restarts the reminders; same-day jitter does not', function () {
    let s = pass(null, T0).b;
    s = pass(s, T0 + 306 * DAY).b; // 60-day reminder sent
    assert.deepEqual(s.reminders.sent.map((x) => x.leadDays), [60]);
    const jitter = pass(s, T0 + 306 * DAY + 60, { activity: used(T0 + 306 * DAY + 30) });
    // activity moved the deadline a year ahead: new deadline day, list reset
    assert.deepEqual(jitter.b.reminders.sent, []);
    assert.equal(jitter.b.deadline, T0 + 306 * DAY + 30 + 365 * DAY);
    assert.equal(jitter.reminder, null);
    const again = pass(jitter.b, T0 + 306 * DAY + 3600, { activity: used(T0 + 306 * DAY + 1800) });
    assert.equal(again.b.reminders.deadlineDay, jitter.b.reminders.deadlineDay, 'same day');
  });

  it('[ACXP5] a delegate\'s use counts and is reported', function () {
    const { b } = pass(null, T0, { activity: used(T0 - DAY, 'delegate') });
    assert.equal(b.lastActivity.by, 'delegate');
    assert.equal(b.lastActivity.delegate, T0 - DAY);
  });

  it('[ACXP6] the stored activity is a floor: deleting a used access does not bring the deadline nearer', function () {
    const s = pass(null, T0, { activity: used(T0 + 10 * DAY) }).b;
    const after = pass(s, T0 + 11 * DAY, { activity: used(T0 + DAY) }).b;
    assert.equal(after.deadline, T0 + 10 * DAY + 365 * DAY);
  });

  it('[ACXP7] after downtime only the most imminent past reminder is sent', function () {
    const s = pass(null, T0).b;
    const late = pass(s, T0 + 360 * DAY); // 5 days left: 60, 30 and 7 all past
    assert.equal(late.reminder, 7);
    assert.deepEqual(late.b.reminders.sent.map((x) => [x.leadDays, !!x.skipped]).sort(), [[30, true], [60, true], [7, false]]);
    assert.equal(pass(late.b, T0 + 360 * DAY + 3600).reminder, null);
  });

  it('[ACXP8] minimum notice: never due less than 7 days after the first notice', function () {
    // a date whose reminders were all missed and that never got a notice
    const policy = userDate(T0 + 20 * DAY);
    let r = evaluate({ policy, activity: noActivity, prev: null, now: T0 + 20 * DAY, config, notifiable: true });
    assert.equal(r.due, false);
    assert.equal(r.bookkeeping.deadlineReason, 'minimum-notice');
    const noticed = withNotice(r.bookkeeping, T0 + 20 * DAY);
    r = evaluate({ policy, activity: noActivity, prev: noticed, now: T0 + 26 * DAY, config, notifiable: true });
    assert.equal(r.due, false);
    r = evaluate({ policy, activity: noActivity, prev: noticed, now: T0 + 27 * DAY, config, notifiable: true });
    assert.equal(r.due, true);
  });

  it('[ACXP9] a date 14 days out is due on the day; with no reminder of its own the confirmation is the first notice', function () {
    const policy = userDate(T0 + 14 * DAY);
    const set = withNotice(evaluate({ policy, activity: noActivity, prev: null, now: T0, config, notifiable: true }).bookkeeping, T0);
    // leads already past at setup (60, 30) are covered by the confirmation
    const pass1 = evaluate({ policy, activity: noActivity, prev: set, now: T0 + DAY, config, notifiable: true });
    assert.equal(pass1.reminder, null);
    const pass2 = evaluate({ policy, activity: noActivity, prev: pass1.bookkeeping, now: T0 + 7 * DAY, config, notifiable: true });
    assert.equal(pass2.reminder, 7);
    const sent7 = withNotice(pass2.bookkeeping, T0 + 7 * DAY, 7);
    const last = evaluate({ policy, activity: noActivity, prev: sent7, now: T0 + 14 * DAY, config, notifiable: true });
    assert.equal(last.due, true);
    assert.equal(last.bookkeeping.deadlineReason, 'date');
    // leads 60 and 30 only: no reminder can come, the confirmation counts
    const longLeads = normalizeAutoDeletionConfig({ reminders: { leadDays: [60, 30] } });
    const setLong = withNotice(evaluate({ policy, activity: noActivity, prev: null, now: T0, config: longLeads, notifiable: true }).bookkeeping, T0);
    assert.equal(evaluate({ policy, activity: noActivity, prev: setLong, now: T0 + 14 * DAY, config: longLeads, notifiable: true }).due, true);
  });

  it('[ACXP10] a shrinking policy restarts the clock, a growing one keeps it', function () {
    const s = pass(null, T0).b;
    const grown = pass(s, T0 + DAY, { policy: preset(400) }).b;
    assert.equal(grown.policyAppliedAt, T0);
    const shrunk = pass(grown, T0 + 2 * DAY, { policy: preset(180) }).b;
    assert.equal(shrunk.policyAppliedAt, T0 + 2 * DAY);
    assert.equal(shrunk.deadline, T0 + 2 * DAY + 180 * DAY);
    const toDate = pass(shrunk, T0 + 3 * DAY, { policy: userDate(T0 + 500 * DAY) }).b;
    assert.equal(toDate.policyAppliedAt, T0 + 3 * DAY, 'another mode restarts');
  });

  it('[ACXP11] a lead not shorter than the period is dropped', function () {
    assert.deepEqual(leadsFor(preset(45), config), [30, 7, 1]);
    assert.deepEqual(leadsFor(preset(90), config), [60, 30, 7, 1]);
    assert.deepEqual(leadsFor(userDate(T0), config), [60, 30, 7, 1]);
  });

  it('[ACXP12] no email: a user setting pauses unless acknowledged; the pause lifts with an email', function () {
    const policy = userDate(T0 + 30 * DAY);
    const paused = evaluate({ policy, activity: noActivity, prev: null, now: T0 + 31 * DAY, config, notifiable: false });
    assert.equal(paused.due, false);
    assert.equal(paused.bookkeeping.blocked.reason, 'no-email');
    const ack = evaluate({ policy, activity: noActivity, prev: null, now: T0 + 30 * DAY, config, notifiable: false, acknowledgedNoReminders: true });
    assert.equal(ack.due, true);
    assert.equal(ack.reminder, null);
    const back = evaluate({ policy, activity: noActivity, prev: paused.bookkeeping, now: T0 + 31 * DAY, config, notifiable: true });
    assert.equal(back.bookkeeping.blocked, undefined);
    assert.equal(back.due, false, 'still owes the minimum notice');
  });

  it('[ACXP13] never, or no policy: no schedule and no row', function () {
    assert.deepEqual(evaluate({ policy: null, activity: noActivity, prev: null, now: T0, config, notifiable: true }), { bookkeeping: null, reminder: null, due: false });
    const s = pass(null, T0).b;
    assert.equal(evaluate({ policy: { source: 'user', mode: 'never', action: 'delete' }, activity: noActivity, prev: s, now: T0, config, notifiable: true }).bookkeeping, null);
  });

  it('[ACXP14] another block (a deletion guard) holds the deletion until cleared', function () {
    const s = { ...pass(null, T0).b, blocked: { reason: 'guard', at: T0 }, firstNoticeAt: T0 };
    assert.equal(pass(s, T0 + 400 * DAY).due, false);
  });

  it('[ACXP16] an account due in this evaluation gets no reminder: its due leads are skipped', function () {
    const policy = userDate(T0 + 14 * DAY);
    const set = withNotice(evaluate({ policy, activity: noActivity, prev: null, now: T0, config, notifiable: true }).bookkeeping, T0);
    const sent7 = withNotice(evaluate({ policy, activity: noActivity, prev: set, now: T0 + 7 * DAY, config, notifiable: true }).bookkeeping, T0 + 7 * DAY, 7);
    // downtime: the 1-day reminder was never sent, the day has come
    const r = evaluate({ policy, activity: noActivity, prev: sent7, now: T0 + 14 * DAY, config, notifiable: true });
    assert.equal(r.due, true);
    assert.equal(r.reminder, null);
    assert.deepEqual(r.bookkeeping.reminders.sent.map((s) => [s.leadDays, s.skipped === true]), [[7, false], [1, true]]);
  });

  it('[ACXP17] a schedule whose reminders were never sent (a dry run) is held: the most imminent goes out, the minimum notice runs from it', function () {
    const policy = userDate(T0 + 14 * DAY);
    const set = withNotice(evaluate({ policy, activity: noActivity, prev: null, now: T0, config, notifiable: true }).bookkeeping, T0);
    // the 7- and 1-day reminders were logged by a dry run, never sent
    const r = evaluate({ policy, activity: noActivity, prev: set, now: T0 + 14 * DAY, config, notifiable: true });
    assert.equal(r.due, false, 'the confirmation alone does not stand for the reminders');
    assert.equal(r.reminder, 1);
    assert.equal(r.bookkeeping.deleteAt, T0 + 21 * DAY);
    assert.equal(r.bookkeeping.deadlineReason, 'minimum-notice');
    const sent1 = withNotice(r.bookkeeping, T0 + 14 * DAY, 1);
    assert.equal(evaluate({ policy, activity: noActivity, prev: sent1, now: T0 + 20 * DAY, config, notifiable: true }).due, false);
    const at21 = evaluate({ policy, activity: noActivity, prev: sent1, now: T0 + 21 * DAY, config, notifiable: true });
    assert.equal(at21.due, true);
    assert.equal(at21.reminder, null);
  });

  it('[ACXP18] a notice counts for the deadline it named: once use moves the deadline to another day, an unsent reminder holds the deletion', function () {
    const policy = { source: 'user', mode: 'inactivity', inactivityDays: 100, action: 'delete' };
    let s = pass(null, T0, { policy }).b;
    const r60 = pass(s, T0 + 40 * DAY, { policy });
    assert.equal(r60.reminder, 60);
    s = r60.b;
    assert.equal(s.firstNoticeAt, T0 + 40 * DAY);
    // used at T0+45d: the deadline moves to T0+145d, the notice no longer counts
    const moved = evaluate({ policy, activity: used(T0 + 45 * DAY), prev: s, now: T0 + 45 * DAY, config, notifiable: true }).bookkeeping;
    assert.equal(moved.deadline, T0 + 145 * DAY);
    assert.equal(moved.firstNoticeAt, undefined);
    assert.deepEqual(moved.reminders.sent, []);
    // no reminder ever gets through for the new deadline: never due
    const late = evaluate({ policy, activity: used(T0 + 45 * DAY), prev: moved, now: T0 + 146 * DAY, config, notifiable: true });
    assert.equal(late.due, false);
    assert.equal(late.reminder, 1, 'catch-up: the most imminent reminder is asked for');
    // same-day jitter keeps the notice
    const noticed = withNotice(moved, T0 + 46 * DAY);
    const jitter = evaluate({ policy, activity: used(T0 + 45 * DAY + 60), prev: noticed, now: T0 + 46 * DAY, config, notifiable: true }).bookkeeping;
    assert.equal(jitter.firstNoticeAt, T0 + 46 * DAY);
  });

  it('[ACXP19] without access tracking an inactivity schedule is suspended (no reminder, never due) and starts again when use is recorded', function () {
    const policy = { source: 'user', mode: 'inactivity', inactivityDays: 100, action: 'delete' };
    const s = withNotice(pass(null, T0, { policy }).b, T0 + 40 * DAY, 60);
    const off = evaluate({ policy, activity: noActivity, prev: s, now: T0 + 200 * DAY, config, notifiable: true, inactivityMeasurable: false });
    assert.equal(off.due, false);
    assert.equal(off.reminder, null);
    assert.deepEqual(off.bookkeeping.blocked, { reason: 'inactivity-unavailable', at: T0 + 200 * DAY });
    const stillOff = evaluate({ policy, activity: noActivity, prev: off.bookkeeping, now: T0 + 201 * DAY, config, notifiable: true, inactivityMeasurable: false });
    assert.deepEqual(stillOff.bookkeeping, off.bookkeeping, 'nothing to write while suspended');
    const back = evaluate({ policy, activity: noActivity, prev: stillOff.bookkeeping, now: T0 + 300 * DAY, config, notifiable: true });
    assert.equal(back.due, false);
    assert.equal(back.bookkeeping.blocked, undefined);
    assert.equal(back.bookkeeping.policyAppliedAt, T0 + 300 * DAY, 'the clock starts again');
    assert.equal(back.bookkeeping.deadline, T0 + 400 * DAY);
    // a date does not depend on use: not suspended
    const date = evaluate({ policy: userDate(T0 + 30 * DAY), activity: noActivity, prev: null, now: T0, config, notifiable: true, inactivityMeasurable: false });
    assert.equal(date.bookkeeping.blocked, undefined);
  });

  it('[ACXP15] next reminder instant for display', function () {
    const s = pass(null, T0).b;
    assert.equal(nextReminderAt(preset(), s, config, T0), T0 + 305 * DAY);
    const after60 = pass(s, T0 + 306 * DAY).b;
    assert.equal(nextReminderAt(preset(), after60, config, T0 + 306 * DAY), T0 + 335 * DAY);
    assert.equal(nextReminderAt(null, s, config, T0), null);
  });
});
