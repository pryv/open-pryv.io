/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The schedule of one account: which policy applies, when the account is due,
 * which reminder to send now. Pure: time comes in as `now`, nothing is read
 * or written here (the sweep and `account.getAutoDeletion` both call it).
 *
 * Rules:
 *  - The effective policy is the holder's setting, else the core's preset
 *    (plain accounts that can receive mail only), else none.
 *  - An inactivity clock starts at the latest of the account's last activity
 *    and the instant the current policy first applied to it, so a preset never
 *    deletes a dormant account without the full reminder schedule. A policy
 *    that shrinks (shorter period, earlier date, other mode) restarts it; one
 *    that grows keeps it.
 *  - Reminders are sent at most once per (deadline day, lead). Leads already
 *    past when the policy applied are covered by the confirmation; leads that
 *    became due together (downtime) send only the most imminent one.
 *  - No account that can receive mail is deleted less than `minNoticeDays`
 *    after its first notice for the current deadline: its first reminder
 *    when the schedule has reminders of its own, else the confirmation. A
 *    deadline moved to another day (use of the account) starts the notices
 *    over.
 *  - An inactivity schedule is suspended while account use is not recorded,
 *    and starts again from the day it is.
 */

import type { AutoDeletionConfig } from './config.ts';
import type { Setting, Bookkeeping, Mode, Action } from './state.ts';
import type { AccountActivity } from '../accesses/accountActivity.ts';

export const DAY_SECONDS = 24 * 60 * 60;

export type Policy = {
  source: 'user' | 'operator';
  mode: Mode;
  date?: number;
  inactivityDays?: number;
  action: Action;
};

/**
 * @param presetApplies the account is a plain account (not a group account,
 *   not under a delegation) that can receive mail: only then does an operator
 *   preset cover it.
 */
export function effectivePolicy (setting: Setting | null, config: AutoDeletionConfig, presetApplies: boolean): Policy | null {
  if (!config.enabled) return null;
  if (setting != null) {
    const p: Policy = { source: 'user', mode: setting.mode, action: setting.action ?? 'delete' };
    if (setting.mode === 'date') p.date = setting.date;
    if (setting.mode === 'inactivity') p.inactivityDays = setting.inactivityDays;
    return p;
  }
  const days = config.inactivity.defaultDays;
  if (days != null && presetApplies) return { source: 'operator', mode: 'inactivity', inactivityDays: days, action: 'delete' };
  return null;
}

export type EvaluateInput = {
  policy: Policy | null;
  activity: AccountActivity;
  prev: Bookkeeping | null;
  now: number;
  config: AutoDeletionConfig;
  /** The account has an email address and the core can send mail. */
  notifiable: boolean;
  /** The holder accepted a schedule without reminders (user setting only). */
  acknowledgedNoReminders?: boolean;
  /**
   * Account use is recorded (`accessTracking.isActive`). False: nothing can
   * show the account is in use, so an inactivity schedule is suspended.
   */
  inactivityMeasurable?: boolean;
};

/** Blocks the engine sets and lifts by itself (the others come from the sweep). */
export const ENGINE_BLOCKS: readonly string[] = Object.freeze(['no-email', 'inactivity-unavailable']);

export type Evaluation = {
  /** Next bookkeeping; null when no schedule applies (the row goes). */
  bookkeeping: Bookkeeping | null;
  /** Reminder to send now (its lead in days), if any. */
  reminder: number | null;
  /** The deadline is reached: delete (or start the transfer) now. */
  due: boolean;
};

/** Whether `next` brings the deletion nearer than `prev` (restarts the clock). */
export function isShrink (prev: Bookkeeping['appliedPolicy'] | null | undefined, next: Policy): boolean {
  if (prev == null || prev.mode !== next.mode) return true;
  if (next.mode === 'inactivity') return (next.inactivityDays as number) < (prev.inactivityDays as number);
  if (next.mode === 'date') return (next.date as number) < (prev.date as number);
  return false;
}

/** Leads (days) that apply to a policy: a lead not shorter than the period is dropped. */
export function leadsFor (policy: Policy, config: AutoDeletionConfig): number[] {
  const leads = config.reminders.leadDays;
  return policy.mode === 'inactivity' ? leads.filter((l) => l < (policy.inactivityDays as number)) : leads.slice();
}

export function evaluate (input: EvaluateInput): Evaluation {
  const { policy, activity, prev, now, config, notifiable } = input;
  if (policy == null || policy.mode === 'never') return { bookkeeping: null, reminder: null, due: false };

  const applied = { source: policy.source, mode: policy.mode } as Bookkeeping['appliedPolicy'];
  if (policy.mode === 'inactivity') applied.inactivityDays = policy.inactivityDays;
  if (policy.mode === 'date') applied.date = policy.date;
  // A suspended inactivity schedule (use was not recorded) starts again from
  // the day use is recorded again: the time in between proves nothing.
  const wasSuspended = prev?.blocked?.reason === 'inactivity-unavailable';
  const resumed = wasSuspended && input.inactivityMeasurable !== false;
  const restart = prev == null || isShrink(prev.appliedPolicy, policy) || resumed;
  const policyAppliedAt = restart ? now : prev.policyAppliedAt;

  const floor = prev?.lastActivity?.max ?? null;
  const max = activity.at == null ? floor : (floor == null ? activity.at : Math.max(floor, activity.at));
  const lastActivity = { personal: activity.personal, app: activity.app, delegate: activity.delegate, max, by: activity.by };

  const base = policy.mode === 'date'
    ? policy.date as number
    : Math.max(max ?? policyAppliedAt, policyAppliedAt) + (policy.inactivityDays as number) * DAY_SECONDS;
  const deadlineDay = Math.floor(base / DAY_SECONDS);
  // Notices count for the deadline they named: one that moved to another day
  // (use of the account) starts the reminders and the notice over.
  const sameDeadline = !restart && prev.reminders?.deadlineDay === deadlineDay;
  const firstNoticeAt = sameDeadline ? (prev.firstNoticeAt ?? null) : null;

  const next: Bookkeeping = {
    appliedPolicy: applied,
    policyAppliedAt,
    lastActivity,
    deadline: base,
    deleteAt: base,
    deadlineReason: policy.mode,
    reminders: {
      deadlineDay,
      sent: sameDeadline ? prev.reminders.sent.slice() : []
    }
  };
  if (firstNoticeAt != null) next.firstNoticeAt = firstNoticeAt;
  if (prev?.blocked != null && !ENGINE_BLOCKS.includes(prev.blocked.reason) && !restart) next.blocked = prev.blocked;

  if (policy.mode === 'inactivity' && input.inactivityMeasurable === false) {
    next.blocked = wasSuspended && !restart ? prev.blocked : { reason: 'inactivity-unavailable', at: now };
    return { bookkeeping: next, reminder: null, due: false };
  }

  if (!notifiable) {
    if (policy.source === 'user' && input.acknowledgedNoReminders === true) {
      return { bookkeeping: next, reminder: null, due: now >= base && next.blocked == null };
    }
    next.blocked = prev?.blocked?.reason === 'no-email' ? prev.blocked : { reason: 'no-email', at: now };
    return { bookkeeping: next, reminder: null, due: false };
  }

  // Minimum notice: never less than minNoticeDays after the first notice.
  // When the schedule has reminders of its own (leads still ahead when the
  // policy applied), it counts from the first reminder actually sent: a
  // confirmation alone never stands for the reminders promised (e.g. reminders
  // not sent during a dry run). Otherwise the first notice (the confirmation)
  // counts.
  const scheduled = leadsFor(policy, config).filter((lead) => base - lead * DAY_SECONDS > policyAppliedAt);
  const reminderTimes = next.reminders.sent.filter((s) => s.skipped !== true).map((s) => s.at);
  const firstReminderAt = reminderTimes.length > 0 ? Math.min(...reminderTimes) : null;
  const noticeFrom = scheduled.length > 0 ? firstReminderAt : firstNoticeAt;
  const minNotice = config.reminders.minNoticeDays * DAY_SECONDS;
  const noticeBound = (noticeFrom ?? now) + minNotice;
  if (noticeBound > base) {
    next.deleteAt = noticeBound;
    next.deadlineReason = 'minimum-notice';
  }

  const due = noticeFrom != null && now >= (next.deleteAt ?? base) && next.blocked == null;

  // A reminder is pointless once the account is due: its leads are skipped.
  let reminder: number | null = null;
  const sentLeads = new Set(next.reminders.sent.map((s) => s.leadDays));
  const dueLeads = scheduled
    .filter((lead) => !sentLeads.has(lead))
    .filter((lead) => base - lead * DAY_SECONDS <= now);
  if (dueLeads.length > 0) {
    reminder = due ? null : Math.min(...dueLeads);
    for (const lead of dueLeads) {
      if (lead !== reminder) next.reminders.sent.push({ leadDays: lead, at: now, skipped: true });
    }
  }

  return { bookkeeping: next, reminder, due };
}

/** Records a notice (confirmation or reminder) actually sent at `at`. */
export function withNotice (b: Bookkeeping, at: number, leadDays?: number): Bookkeeping {
  const next: Bookkeeping = { ...b, reminders: { ...b.reminders, sent: b.reminders.sent.slice() } };
  if (next.firstNoticeAt == null) next.firstNoticeAt = at;
  if (leadDays != null) next.reminders.sent.push({ leadDays, at });
  return next;
}

/** Next reminder instant still to come (for display), or null. */
export function nextReminderAt (policy: Policy | null, b: Bookkeeping | null, config: AutoDeletionConfig, now: number): number | null {
  if (policy == null || b == null || b.reminders.deadlineDay == null || policy.mode === 'never') return null;
  const base = b.deadline;
  if (base == null) return null;
  const sent = new Set(b.reminders.sent.map((s) => s.leadDays));
  const upcoming = leadsFor(policy, config)
    .filter((lead) => !sent.has(lead))
    .map((lead) => base - lead * DAY_SECONDS)
    .filter((t) => t > now);
  return upcoming.length > 0 ? Math.min(...upcoming) : null;
}
