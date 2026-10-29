/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `account.autoDeletion`: deletion (or transfer) of an account at a date the
 * user picks or after a period of inactivity, with reminders.
 *
 * Per-core block. An operator preset (`inactivity.defaultDays`) applies to
 * every plain account of the core; set the same values on every core for a
 * platform-wide preset. The shipped default is "never delete".
 *
 * `normalizeAutoDeletionConfig` fills the defaults and never throws (it runs
 * on request paths); `describeAutoDeletionConfig` is the boot-time check.
 */

type Problem = { message: string; path: string[] };
type Raw = Record<string, unknown>;

export type AutoDeletionConfig = {
  enabled: boolean;
  dryRun: boolean;
  inactivity: { defaultDays: number | null; minDays: number; maxDays: number };
  userOverride: boolean;
  allowUserOptOut: boolean;
  date: { minLeadDays: number };
  reminders: { leadDays: number[]; minNoticeDays: number };
  sweepIntervalMs: number;
  maxDeletionsPerPass: number;
  transfer: { claimWindowDays: number; identitySecretsKey: string | null };
};

export const AUTO_DELETION_DEFAULTS: AutoDeletionConfig = Object.freeze({
  enabled: true,
  dryRun: false,
  inactivity: { defaultDays: null, minDays: 90, maxDays: 3650 },
  userOverride: true,
  allowUserOptOut: true,
  date: { minLeadDays: 14 },
  reminders: { leadDays: [60, 30, 7, 1], minNoticeDays: 7 },
  sweepIntervalMs: 6 * 60 * 60 * 1000,
  maxDeletionsPerPass: 20,
  transfer: { claimWindowDays: 90, identitySecretsKey: null }
}) as AutoDeletionConfig;

/** Below this, a sweep interval is a typo (milliseconds read as seconds). */
const MIN_SWEEP_INTERVAL_MS = 60 * 1000;
const IDENTITY_KEY_BYTES = 32;

const obj = (v: unknown): Raw => (v != null && typeof v === 'object' && !Array.isArray(v)) ? v as Raw : {};
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function pick<T> (value: unknown, valid: (v: unknown) => boolean, fallback: T): T {
  return value !== undefined && valid(value) ? value as T : fallback;
}

function isLeadDays (v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  for (let i = 0; i < v.length; i++) {
    if (!isPosInt(v[i])) return false;
    if (i > 0 && v[i] >= v[i - 1]) return false;
  }
  return true;
}

export function normalizeAutoDeletionConfig (rawBlock: unknown): AutoDeletionConfig {
  const d = AUTO_DELETION_DEFAULTS;
  const raw = obj(rawBlock);
  const inactivity = obj(raw.inactivity);
  const date = obj(raw.date);
  const reminders = obj(raw.reminders);
  const transfer = obj(raw.transfer);
  return {
    enabled: pick(raw.enabled, (v) => typeof v === 'boolean', d.enabled),
    dryRun: pick(raw.dryRun, (v) => typeof v === 'boolean', d.dryRun),
    inactivity: {
      defaultDays: pick(inactivity.defaultDays, (v) => v === null || isPosInt(v), d.inactivity.defaultDays),
      minDays: pick(inactivity.minDays, isPosInt, d.inactivity.minDays),
      maxDays: pick(inactivity.maxDays, isPosInt, d.inactivity.maxDays)
    },
    userOverride: pick(raw.userOverride, (v) => typeof v === 'boolean', d.userOverride),
    allowUserOptOut: pick(raw.allowUserOptOut, (v) => typeof v === 'boolean', d.allowUserOptOut),
    date: { minLeadDays: pick(date.minLeadDays, isPosInt, d.date.minLeadDays) },
    reminders: {
      leadDays: pick(reminders.leadDays, isLeadDays, d.reminders.leadDays).slice(),
      minNoticeDays: pick(reminders.minNoticeDays, isPosInt, d.reminders.minNoticeDays)
    },
    sweepIntervalMs: pick(raw.sweepIntervalMs, (v) => isPosInt(v) && v >= MIN_SWEEP_INTERVAL_MS, d.sweepIntervalMs),
    maxDeletionsPerPass: pick(raw.maxDeletionsPerPass, isNonNegInt, d.maxDeletionsPerPass),
    transfer: {
      claimWindowDays: pick(transfer.claimWindowDays, isPosInt, d.transfer.claimWindowDays),
      identitySecretsKey: pick(transfer.identitySecretsKey, isIdentityKey, d.transfer.identitySecretsKey)
    }
  };
}

function isIdentityKey (v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  return Buffer.from(v, 'base64').length === IDENTITY_KEY_BYTES;
}

export type AutoDeletionEnvironment = {
  /** `accessTracking:isActive`: without it inactivity cannot be measured. */
  accessTrackingActive: boolean;
  /** Mail can be sent (`describeMailCapability(config).ok`). */
  mailOk: boolean;
  /** `service.account` is set: reminder mails link to the account app. */
  accountAppSet: boolean;
};

/**
 * Boot-time check of `account.autoDeletion`.
 *  - `problems`: settings that cannot work; the boot is refused.
 *  - `warnings`: settings that work only partly; logged.
 * Pure: takes the raw block and the facts it depends on.
 */
export function describeAutoDeletionConfig (rawBlock: unknown, env: AutoDeletionEnvironment): { problems: Problem[]; warnings: string[] } {
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const base = ['account', 'autoDeletion'];
  if (rawBlock != null && (typeof rawBlock !== 'object' || Array.isArray(rawBlock))) {
    problems.push({ message: 'must be a map of settings.', path: base });
    return { problems, warnings };
  }
  const raw = obj(rawBlock);
  const inactivity = obj(raw.inactivity);
  const date = obj(raw.date);
  const reminders = obj(raw.reminders);
  const transfer = obj(raw.transfer);
  const bad = (path: string[], message: string) => problems.push({ message, path: [...base, ...path] });
  const has = (o: Raw, k: string) => o[k] !== undefined;

  for (const k of ['enabled', 'dryRun', 'userOverride', 'allowUserOptOut']) {
    if (has(raw, k) && typeof raw[k] !== 'boolean') bad([k], 'must be true or false.');
  }
  if (has(inactivity, 'defaultDays') && inactivity.defaultDays !== null && !isPosInt(inactivity.defaultDays)) {
    bad(['inactivity', 'defaultDays'], 'must be null (never delete) or a positive number of days.');
  }
  for (const k of ['minDays', 'maxDays']) {
    if (has(inactivity, k) && !isPosInt(inactivity[k])) bad(['inactivity', k], 'must be a positive number of days.');
  }
  if (has(date, 'minLeadDays') && !isPosInt(date.minLeadDays)) bad(['date', 'minLeadDays'], 'must be a positive number of days.');
  if (has(reminders, 'leadDays') && !isLeadDays(reminders.leadDays)) {
    bad(['reminders', 'leadDays'], 'must be a non-empty list of positive day counts in strictly decreasing order, e.g. [60, 30, 7, 1].');
  }
  if (has(reminders, 'minNoticeDays') && !isPosInt(reminders.minNoticeDays)) bad(['reminders', 'minNoticeDays'], 'must be a positive number of days.');
  if (has(raw, 'sweepIntervalMs') && !(isPosInt(raw.sweepIntervalMs) && raw.sweepIntervalMs >= MIN_SWEEP_INTERVAL_MS)) {
    bad(['sweepIntervalMs'], `must be a number of milliseconds, at least ${MIN_SWEEP_INTERVAL_MS}.`);
  }
  if (has(raw, 'maxDeletionsPerPass') && !isNonNegInt(raw.maxDeletionsPerPass)) bad(['maxDeletionsPerPass'], 'must be 0 (no limit) or a positive integer.');
  if (has(transfer, 'claimWindowDays') && !isPosInt(transfer.claimWindowDays)) bad(['transfer', 'claimWindowDays'], 'must be a positive number of days.');
  if (has(transfer, 'identitySecretsKey') && !isIdentityKey(transfer.identitySecretsKey)) {
    bad(['transfer', 'identitySecretsKey'], `must be null or ${IDENTITY_KEY_BYTES} bytes in base64.`);
  }
  if (problems.length > 0) return { problems, warnings };

  // Relations, judged on the values in effect (defaults filled in).
  const c = normalizeAutoDeletionConfig(rawBlock);
  const { defaultDays, minDays, maxDays } = c.inactivity;
  if (minDays > maxDays) bad(['inactivity', 'minDays'], `(${minDays}) is above inactivity.maxDays (${maxDays}).`);
  if (defaultDays != null && (defaultDays < minDays || defaultDays > maxDays)) {
    bad(['inactivity', 'defaultDays'], `(${defaultDays}) is outside inactivity.minDays..maxDays (${minDays}..${maxDays}).`);
  }
  if (c.date.minLeadDays < c.reminders.minNoticeDays) {
    bad(['date', 'minLeadDays'], `(${c.date.minLeadDays}) is below reminders.minNoticeDays (${c.reminders.minNoticeDays}): a date that close could never be honoured.`);
  }
  if (c.enabled && defaultDays == null && !env.accessTrackingActive) {
    warnings.push("'accessTracking.isActive' is false: account use is not recorded, so inactivity auto-deletion schedules set by users are suspended (no reminder, no deletion) until it is turned on again; date schedules run as set.");
  }
  if (c.enabled && defaultDays != null) {
    if (!env.accessTrackingActive) {
      bad(['inactivity', 'defaultDays'], 'is set while accessTracking.isActive is false: inactivity cannot be measured. Turn access tracking on or remove the preset.');
    }
    if (!env.mailOk) {
      warnings.push("'account.autoDeletion.inactivity.defaultDays' is set but mail is not configured: the preset applies only to accounts that can receive reminders, so it applies to none.");
    }
    if (!env.accountAppSet) {
      warnings.push("'account.autoDeletion.inactivity.defaultDays' is set but 'service.account' is not: reminder mails cannot link to the account app.");
    }
  }
  return { problems, warnings };
}
