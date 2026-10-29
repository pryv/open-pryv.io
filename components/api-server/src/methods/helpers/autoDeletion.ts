/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { getLogger } from '@pryv/boiler';
import type { ConfigLike } from '@pryv/boiler';
import { getStorageLayer, getUserAccountStorage } from 'storage';
import { store as delegationStore, STATUS as DELEGATION_STATUS } from 'delegation';
import { describeMailCapability } from 'business/src/emails/mailCapability.ts';
import { getUsersRepository } from 'business/src/users/index.ts';
import type { AutoDeletionConfig } from 'business/src/autoDeletion/config.ts';
import { createAutoDeletionState } from 'business/src/autoDeletion/state.ts';
import type { Setting, Bookkeeping, AccountStorage } from 'business/src/autoDeletion/state.ts';
import { effectivePolicy, evaluate, nextReminderAt, DAY_SECONDS } from 'business/src/autoDeletion/deadline.ts';
import type { Policy, Evaluation } from 'business/src/autoDeletion/deadline.ts';
import { activityOf } from 'business/src/accesses/accountActivity.ts';
import type { AccountActivity } from 'business/src/accesses/accountActivity.ts';
import { buildMallForCmc } from './cmcMall.ts';
import { sendmail, isLoggedMailFailure } from './mailing.ts';
import { availableActions } from './autoDeletionPolicy.ts';

/**
 * What `account.getAutoDeletion` / `account.setAutoDeletion` need to know
 * about one account (its activity, whether it can receive mail, whether an
 * operator preset covers it), the view they answer, and the confirmation
 * mail sent on every change of the setting.
 */

const logger = getLogger('methods:accountAutoDeletion');

type UserRef = { id: string; username: string };
type AccessRow = {
  type?: string;
  lastUsed?: number | null;
  clientData?: { cmc?: { role?: unknown } | null; delegation?: { kind?: unknown } | null } | null;
};
type EmailSettings = Parameters<typeof sendmail>[0] & {
  enabled?: unknown;
  defaultLang?: string;
  accountDeletionScheduledTemplate?: string;
};

export type MailState = 'available' | 'no-email' | 'not-configured';

export type AccountFacts = {
  activity: AccountActivity;
  email: string | null;
  language: string | null;
  mail: MailState;
  /** The account has an email address and the core can send mail. */
  notifiable: boolean;
  /** A group account: it has member accesses. */
  isGroup: boolean;
  /** Under a delegation: it has an active delegate. */
  isControlled: boolean;
  /** An operator preset covers this account (plain account that can receive mail). */
  presetApplies: boolean;
};

export async function getState () {
  return createAutoDeletionState(await getUserAccountStorage() as unknown as AccountStorage);
}

async function findAccesses (user: UserRef): Promise<AccessRow[]> {
  const accesses = (await getStorageLayer()).accesses;
  return await new Promise((resolve, reject) => {
    accesses.find(user, {}, null, (err: Error | null, rows: AccessRow[]) => err != null ? reject(err) : resolve(rows ?? []));
  });
}

/** True when the account has an active delegate; an unreadable state counts as controlled. */
async function hasActiveDelegate (userId: string): Promise<boolean> {
  try {
    const mall = await buildMallForCmc();
    const anchors = await delegationStore.listAnchors(mall as unknown as Parameters<typeof delegationStore.listAnchors>[0], userId);
    return anchors.some((a) => (a.content as { status?: unknown } | undefined)?.status === DELEGATION_STATUS.ACTIVE);
  } catch (err) {
    logger.warn(`auto-deletion: delegation state of user ${userId} not readable, counted as controlled: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export async function loadAccountFacts (config: ConfigLike, user: UserRef): Promise<AccountFacts> {
  const accesses = await findAccesses(user);
  const account = await (await getUsersRepository()).getUserById(user.id) as { email?: unknown; language?: unknown } | null;
  const email = typeof account?.email === 'string' && account.email !== '' ? account.email : null;
  const language = typeof account?.language === 'string' && account.language !== '' ? account.language : null;
  const mailOk = describeMailCapability(config).ok;
  const mail: MailState = !mailOk ? 'not-configured' : email == null ? 'no-email' : 'available';
  const isGroup = accesses.some((a) => a?.type === 'shared' && a.clientData?.cmc?.role === 'member');
  const isControlled = await hasActiveDelegate(user.id);
  const notifiable = mail === 'available';
  return {
    activity: activityOf(accesses),
    email,
    language,
    mail,
    notifiable,
    isGroup,
    isControlled,
    presetApplies: notifiable && !isGroup && !isControlled
  };
}

export type Schedule = { policy: Policy | null; evaluation: Evaluation };

export function computeSchedule (config: AutoDeletionConfig, setting: Setting | null, facts: AccountFacts, prev: Bookkeeping | null, now: number): Schedule {
  const policy = effectivePolicy(setting, config, facts.presetApplies);
  const evaluation = evaluate({
    policy,
    activity: facts.activity,
    prev,
    now,
    config,
    notifiable: facts.notifiable,
    acknowledgedNoReminders: setting?.acknowledgedNoReminders === true
  });
  return { policy, evaluation };
}

/** The answer of `account.getAutoDeletion` (times in pryv seconds). */
export function buildView (opts: {
  config: ConfigLike;
  adConfig: AutoDeletionConfig;
  setting: Setting | null;
  facts: AccountFacts;
  prev: Bookkeeping | null;
  schedule: Schedule;
  now: number;
}): Record<string, unknown> {
  const { config, adConfig, setting, facts, prev, schedule, now } = opts;
  const { policy } = schedule;
  const b = schedule.evaluation.bookkeeping;
  const effective: Record<string, unknown> = policy == null
    ? { source: 'none', mode: 'never', action: 'delete' }
    : { source: policy.source, mode: policy.mode, action: policy.action };
  if (policy?.mode === 'date') effective.date = policy.date;
  if (policy?.mode === 'inactivity') effective.inactivityDays = policy.inactivityDays;

  const floor = prev?.lastActivity?.max ?? null;
  const at = facts.activity.at;
  const max = at == null ? floor : (floor == null ? at : Math.max(floor, at));
  return {
    effective,
    setting,
    lastActivity: {
      personal: facts.activity.personal,
      app: facts.activity.app,
      delegate: facts.activity.delegate,
      max,
      by: facts.activity.by
    },
    deadline: b?.deadline ?? null,
    deleteAt: b?.deleteAt ?? b?.deadline ?? null,
    deadlineReason: b?.deadlineReason ?? null,
    nextReminderAt: nextReminderAt(policy, b, adConfig, now),
    remindersSent: (b?.reminders.sent ?? []).filter((s) => s.skipped !== true).map((s) => ({ leadDays: s.leadDays, at: s.at })),
    blocked: b?.blocked ?? null,
    mail: facts.mail,
    bounds: { minDays: adConfig.inactivity.minDays, maxDays: adConfig.inactivity.maxDays, minLeadDays: adConfig.date.minLeadDays },
    userOverride: adConfig.userOverride,
    allowUserOptOut: adConfig.allowUserOptOut,
    actions: availableActions(config)
  };
}

function joinUrl (base: string, path: string): string {
  return base.endsWith('/') ? base + path : base + '/' + path;
}

function formatInstant (seconds: number, lang: string): string {
  const locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
  return new Date(seconds * 1000).toLocaleString(locale, {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
  });
}

/**
 * Template variables of the confirmation. Mail templates only test locals, so
 * the trigger comes both as `TRIGGER` and as one flag per value.
 */
export function confirmationSubstitutions (config: ConfigLike, user: UserRef, schedule: Schedule, lang: string, now: number): Record<string, string> {
  const { policy } = schedule;
  const b = schedule.evaluation.bookkeeping;
  const scheduled = policy != null && policy.mode !== 'never' && b != null;
  const deleteAt = scheduled ? (b.deleteAt ?? b.deadline) : null;
  const trigger = scheduled ? policy.mode : 'none';
  const accountApp = config.get('service:account');
  const accountAppUrl = typeof accountApp === 'string' ? accountApp : '';
  return {
    USERNAME: user.username,
    DEADLINE: deleteAt != null ? formatInstant(deleteAt, lang) : '',
    DAYS_LEFT: deleteAt != null ? String(Math.max(0, Math.ceil((deleteAt - now) / DAY_SECONDS))) : '',
    TRIGGER: trigger,
    SCHEDULED: scheduled ? 'true' : '',
    TRIGGER_DATE: trigger === 'date' ? 'true' : '',
    TRIGGER_INACTIVITY: trigger === 'inactivity' ? 'true' : '',
    INACTIVITY_DAYS: trigger === 'inactivity' ? String(policy!.inactivityDays) : '',
    ACTION: scheduled ? policy.action : '',
    ACCOUNT_APP_URL: accountAppUrl,
    EXPORT_URL: accountAppUrl !== '' ? joinUrl(accountAppUrl, 'account/data') : ''
  };
}

/**
 * Send the confirmation of a setting change; true when it went out. Never
 * throws: a failure is logged and the change stands.
 */
export async function sendConfirmation (config: ConfigLike, user: UserRef, facts: AccountFacts, schedule: Schedule, now: number): Promise<boolean> {
  try {
    const emailSettings = config.get('services:email') as EmailSettings | null | undefined;
    if (emailSettings == null || !facts.notifiable || facts.email == null) return false;
    const enabled = emailSettings.enabled;
    if (enabled != null && typeof enabled === 'object' && (enabled as { accountDeletionScheduled?: unknown }).accountDeletionScheduled === false) return false;
    const lang = facts.language || emailSettings.defaultLang || 'en';
    const substitutions = confirmationSubstitutions(config, user, schedule, lang, now);
    await new Promise<void>((resolve, reject) => {
      sendmail(emailSettings, emailSettings.accountDeletionScheduledTemplate || 'account-deletion-scheduled',
        { email: facts.email as string, name: user.username, type: 'to' }, substitutions, lang,
        (err?: Error | null) => (err != null ? reject(err) : resolve()));
    });
    return true;
  } catch (err: unknown) {
    if (!isLoggedMailFailure(err)) {
      logger.warn(`auto-deletion confirmation for user "${user.username}" not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }
}
