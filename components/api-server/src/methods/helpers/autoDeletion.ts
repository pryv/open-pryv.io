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
import { describeMailCapability, isMailKindSwitchedOn } from 'business/src/emails/mailCapability.ts';
import type { MailKind } from 'business/src/emails/mailCapability.ts';
import { isStoredEmailHeldElsewhere, isEmailHeldByAnother } from 'business/src/emails/heldAddress.ts';
import type { EmailRowsIndex } from 'business/src/emails/heldAddress.ts';
import { getPlatform } from 'platform';
import { getUsersRepository } from 'business/src/users/index.ts';
import type { AutoDeletionConfig } from 'business/src/autoDeletion/config.ts';
import { createAutoDeletionState } from 'business/src/autoDeletion/state.ts';
import type { Setting, Bookkeeping, AccountStorage, TransferRecord, FailedClaims } from 'business/src/autoDeletion/state.ts';
import { deriveLinkToken, accountAppLink } from 'business/src/autoDeletion/transfer.ts';
import type { TransferNotice } from 'business/src/autoDeletion/transferFlow.ts';
import { effectivePolicy, evaluate, nextReminderAt, DAY_SECONDS } from 'business/src/autoDeletion/deadline.ts';
import type { Policy, Evaluation } from 'business/src/autoDeletion/deadline.ts';
import { activityOf } from 'business/src/accesses/accountActivity.ts';
import type { AccountActivity } from 'business/src/accesses/accountActivity.ts';
import { buildMallForCmc } from './cmcMall.ts';
import { sendmail, isLoggedMailFailure, isRecipientRejected, isRecipientDeferred } from './mailing.ts';
import { availableActions, availableTriggers, autoDeletionConfig, transferIdentityKey, transferLinkKey } from './autoDeletionPolicy.ts';
import { TRANSFER_INVITE_PURPOSE } from './transferDelegation.ts';

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
  defaultLang?: string;
};

export type MailState = 'available' | 'no-email' | 'not-configured';

export type AccountFacts = {
  activity: AccountActivity;
  email: string | null;
  /** Another account holds `email` on the platform (`mail` is then `no-email`). */
  emailHeld?: boolean;
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
  /** Account use is recorded (`accessTracking.isActive`): an inactivity schedule can run. */
  inactivityMeasurable: boolean;
  /** The holder may delete the account themselves (`user-account.delete` lists `personalToken`). */
  selfDeletionAllowed: boolean;
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

/** `now` (pryv seconds) is the clock activity is read against; the sweep passes its own. */
/**
 * `emailRows` (the sweep): the email rows read once for the pass
 * (`Platform.getUniqueValueIndex`), so that, in cleartext mode, the held
 * check of each account is not one scan of the email rows; null in hashed
 * mode (one exact read per account) and when not given.
 */
export async function loadAccountFacts (config: ConfigLike, user: UserRef, now?: number, emailRows?: () => Promise<EmailRowsIndex | null>): Promise<AccountFacts> {
  const accesses = await findAccesses(user);
  const account = await (await getUsersRepository()).getUserById(user.id) as { email?: unknown; language?: unknown } | null;
  const email = typeof account?.email === 'string' && account.email !== '' ? account.email : null;
  const language = typeof account?.language === 'string' && account.language !== '' ? account.language : null;
  const mailOk = describeMailCapability(config).ok;
  // An address another account holds is not this account's inbox: the
  // account counts as one without an address (blocked "no-email", no preset).
  // A failed lookup throws: the account is not judged on a guess.
  const emailHeld = mailOk && email != null && await isEmailHeldByAnother(await getPlatform(), user.username, email, emailRows != null ? await emailRows() : null);
  const mail: MailState = !mailOk ? 'not-configured' : (email == null || emailHeld) ? 'no-email' : 'available';
  const isGroup = accesses.some((a) => a?.type === 'shared' && a.clientData?.cmc?.role === 'member');
  const isControlled = await hasActiveDelegate(user.id);
  const notifiable = mail === 'available';
  return {
    activity: activityOf(accesses, now, { countApps: autoDeletionConfig(config).inactivity.countAppUse }),
    email,
    emailHeld,
    language,
    mail,
    notifiable,
    isGroup,
    isControlled,
    presetApplies: notifiable && !isGroup && !isControlled,
    inactivityMeasurable: availableTriggers(config).includes('inactivity'),
    selfDeletionAllowed: availableActions(config).includes('delete')
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
    acknowledgedNoReminders: setting?.acknowledgedNoReminders === true,
    inactivityMeasurable: facts.inactivityMeasurable
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
  transfer?: TransferRecord | null;
  failedClaims?: FailedClaims | null;
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
    actions: availableActions(config),
    transfer: transferView(opts.transfer ?? null, opts.failedClaims ?? null),
    claimWindowDays: adConfig.transfer.claimWindowDays
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
 * The auto-deletion mails: the mail class (its switch is
 * `services.email.send<Class>`, see `mailSwitchKey`), the template key under
 * `services.email` and the default template name.
 */
export const AUTO_DELETION_MAILS = Object.freeze({
  scheduled: { flag: 'accountDeletionScheduled', templateKey: 'accountDeletionScheduledTemplate', template: 'account-deletion-scheduled' },
  reminder: { flag: 'accountDeletionReminder', templateKey: 'accountDeletionReminderTemplate', template: 'account-deletion-reminder' },
  blocked: { flag: 'accountDeletionBlocked', templateKey: 'accountDeletionBlockedTemplate', template: 'account-deletion-blocked' },
  transferNamed: { flag: 'accountTransferNamed', templateKey: 'accountTransferNamedTemplate', template: 'account-transfer-named' },
  transferClaim: { flag: 'accountTransferClaim', templateKey: 'accountTransferClaimTemplate', template: 'account-transfer-claim' },
  transferStarted: { flag: 'accountTransferStarted', templateKey: 'accountTransferStartedTemplate', template: 'account-transfer-started' },
  transferCancelled: { flag: 'accountTransferCancelled', templateKey: 'accountTransferCancelledTemplate', template: 'account-transfer-cancelled' },
  transferLapsed: { flag: 'accountTransferLapsed', templateKey: 'accountTransferLapsedTemplate', template: 'account-transfer-lapsed' },
  transferCompleted: { flag: 'accountTransferCompleted', templateKey: 'accountTransferCompletedTemplate', template: 'account-transfer-completed' }
} satisfies Record<string, { flag: MailKind; templateKey: string; template: string }>);
export type AutoDeletionMail = keyof typeof AUTO_DELETION_MAILS;
export type MailOutcome = 'sent' | 'off' | 'rejected' | 'failed';

/**
 * Send one auto-deletion mail to the account's address (or to `to`: a
 * transfer beneficiary). `off`: the mail is switched off, or the account
 * cannot receive mail. `rejected`: the mail server refused (or deferred) this
 * recipient. `failed`: any other failure, the transport's. Never throws: a
 * failure is logged.
 */
export async function sendAutoDeletionMail (config: ConfigLike, kind: AutoDeletionMail, user: UserRef, facts: AccountFacts,
  substitutionsFor: (lang: string) => Record<string, string>, to?: { email: string }): Promise<MailOutcome> {
  const mail = AUTO_DELETION_MAILS[kind];
  try {
    const emailSettings = config.get('services:email') as EmailSettings | null | undefined;
    if (emailSettings == null) return 'off';
    // The account's own address held by another account (`loadAccountFacts`,
    // or found at the send): a notice not given, never one switched off, so
    // it is not recorded as given (`rejected`: retried, logged once by the
    // sweep). A failed lookup is a failed send, retried. The live lookup runs
    // after the switched-off cases, so a mail that would not be sent anyway
    // does not read the platform.
    if (to == null && facts.emailHeld === true) return 'rejected';
    if (to == null && (!facts.notifiable || facts.email == null)) return 'off';
    if (to != null && (facts.mail === 'not-configured' || to.email === '')) return 'off';
    if (!isMailKindSwitchedOn(emailSettings, mail.flag)) return 'off';
    if (to == null && await isStoredEmailHeldElsewhere(user.username, facts.email, `auto-deletion ${kind} mail`, logger)) return 'rejected';
    const lang = facts.language || emailSettings.defaultLang || 'en';
    const configured = (emailSettings as Record<string, unknown>)[mail.templateKey];
    const template = typeof configured === 'string' && configured !== '' ? configured : mail.template;
    const recipient = to != null ? { email: to.email, name: to.email, type: 'to' } : { email: facts.email as string, name: user.username, type: 'to' };
    await new Promise<void>((resolve, reject) => {
      sendmail(emailSettings, template, recipient, substitutionsFor(lang), lang,
        (err?: Error | null) => (err != null ? reject(err) : resolve()));
    });
    return 'sent';
  } catch (err: unknown) {
    if (!isLoggedMailFailure(err)) {
      logger.warn(`auto-deletion ${kind} mail for user "${user.username}" not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
    return isRecipientRejected(err) || isRecipientDeferred(err) ? 'rejected' : 'failed';
  }
}

/**
 * Send the confirmation of a setting change; true when it went out. Never
 * throws: a failure is logged and the change stands. `extra`: more template
 * variables (an administrator's change: `BY_OPERATOR`, `OPERATOR_REASON`).
 */
export async function sendConfirmation (config: ConfigLike, user: UserRef, facts: AccountFacts, schedule: Schedule, now: number, setting: Setting | null = null,
  extra: Record<string, string> = {}): Promise<boolean> {
  const transfer = await transferVars(config, user, schedule.policy?.action === 'transfer' ? setting : null);
  return await sendAutoDeletionMail(config, 'scheduled', user, facts,
    (lang) => ({ ...confirmationSubstitutions(config, user, schedule, lang, now), ...transfer, BY_OPERATOR: '', OPERATOR_REASON: '', ...extra })) === 'sent';
}

/**
 * What the mails say about a transfer the holder set: to whom (the name when
 * one was given, else the address), and what happens without a claim. Empty
 * values when the action is not a transfer.
 */
export async function transferVars (config: ConfigLike, user: UserRef, setting: Setting | null, email?: string): Promise<Record<string, string>> {
  const t = setting?.action === 'transfer' ? setting.transfer : undefined;
  const address = email ?? t?.email ?? '';
  let name = '';
  if (t?.identityGiven === true) {
    try {
      const key = transferIdentityKey(config);
      if (key != null) name = (await (await getState()).getIdentity(user.id, key))?.name ?? '';
    } catch (err) {
      logger.warn(`auto-deletion: the beneficiary name of account "${user.username}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    ACTION_TRANSFER: t != null ? 'true' : '',
    BENEFICIARY_EMAIL: address,
    BENEFICIARY_NAME: name,
    BENEFICIARY: name !== '' ? name : address,
    FALLBACK_DELETE: t?.fallback === 'delete' ? 'true' : '',
    FALLBACK_KEEP: t?.fallback === 'keep' ? 'true' : '',
    IDENTITY_GIVEN: t?.identityGiven === true ? 'true' : '',
    NOTIFY_AT_SETUP: t?.notifyBeneficiary === 'atSetup' ? 'true' : ''
  };
}

const TRANSFER_MAIL_KINDS: Record<TransferNotice['kind'], AutoDeletionMail> = {
  named: 'transferNamed',
  claim: 'transferClaim',
  started: 'transferStarted',
  cancelled: 'transferCancelled',
  lapsed: 'transferLapsed',
  completed: 'transferCompleted'
};

/**
 * Send one transfer mail, to the owner or to the beneficiary (the address of
 * the transfer record). The links are derived from the record's salts; the
 * claim link only while a claim can be made, the decline link only before a
 * claim.
 */
export async function sendTransferMail (config: ConfigLike, account: UserRef, facts: AccountFacts, notice: TransferNotice): Promise<MailOutcome> {
  const { record, setting } = notice;
  const vars = await transferVars(config, account, setting, record.email);
  // The name is the operator's, to identify the beneficiary: never mailed to them.
  if (notice.to === 'beneficiary') Object.assign(vars, { BENEFICIARY_NAME: '', BENEFICIARY: record.email });
  const accountApp = config.get('service:account');
  const accountAppUrl = typeof accountApp === 'string' ? accountApp : '';
  const key = transferLinkKey(config);
  const link = (page: string, kind: 'claim' | 'decline', salt: string | undefined): string =>
    key != null && salt != null && accountAppUrl !== ''
      ? accountAppLink(accountAppUrl, page, { username: account.username, token: deriveLinkToken(key, kind, account.id, salt) })
      : '';
  const claimable = record.status === 'open' || record.status === 'claimed';
  const declinable = record.status === 'named' || record.status === 'open';
  const reason = notice.reason ?? '';
  const operatorName = config.get('service:name');
  const ad = autoDeletionConfig(config);
  const substitutions = (lang: string): Record<string, string> => ({
    ...vars,
    USERNAME: account.username,
    OPERATOR_NAME: typeof operatorName === 'string' ? operatorName : '',
    TO_BENEFICIARY: notice.to === 'beneficiary' ? 'true' : '',
    CLAIM_LINK: claimable ? link('transfer-claim', 'claim', record.claimSalt) : '',
    DECLINE_LINK: declinable ? link('transfer-decline', 'decline', record.declineSalt) : '',
    WINDOW_END: record.endsAt != null ? formatInstant(record.endsAt, lang) : '',
    WINDOW_DAYS: String(ad.transfer.claimWindowDays),
    CLAIMANT: record.claimedBy?.username ?? '',
    REASON: reason,
    REASON_DECLINED: reason === 'declined' ? 'true' : '',
    REASON_OWNER_ACTIVITY: reason === 'owner-activity' ? 'true' : '',
    REASON_DELEGATE_ACTIVITY: reason === 'delegate-activity' ? 'true' : '',
    REASON_OWNER_CHANGE: reason === 'owner-change' ? 'true' : '',
    ACCOUNT_APP_URL: accountAppUrl,
    EXPORT_URL: accountAppUrl !== '' ? joinUrl(accountAppUrl, 'account/data') : ''
  });
  return await sendAutoDeletionMail(config, TRANSFER_MAIL_KINDS[notice.kind], account, facts, substitutions,
    notice.to === 'beneficiary' ? { email: record.email } : undefined);
}

/**
 * The accept check of a delegation invite (the delegation's `acceptCheck`):
 * an invite sent for an account transfer (its purpose, or the relationship
 * the transfer record names) is accepted only while that transfer is still
 * claimed by the invited account. A transfer cancelled, lapsed or declined
 * while its invite could not be withdrawn never hands the account over.
 * Asked again once the relationship is active (`activated`): a transfer the
 * sweep completed meanwhile, on seeing it active, still counts.
 * Other invites: null (no say).
 */
export async function transferInviteRefusal (input: { bUserId: string; relId: string; delegateUsername: string; purpose?: string; activated?: boolean }): Promise<string | null> {
  const record = await (await getState()).getTransfer(input.bUserId);
  const named = record?.claimedBy?.relId != null && record.claimedBy.relId === input.relId;
  if (input.purpose !== TRANSFER_INVITE_PURPOSE && !named) return null;
  const holds = record?.status === 'claimed' || (input.activated === true && record?.status === 'completed');
  const claimedBy = holds ? record?.claimedBy : null;
  if (claimedBy != null && claimedBy.username.toLowerCase() === input.delegateUsername.toLowerCase() &&
      (claimedBy.relId == null || claimedBy.relId === input.relId)) {
    return null;
  }
  logger.warn(`auto-deletion: a transfer invite of account ${input.bUserId} to "${input.delegateUsername}" refused: the transfer is not claimed by this account (${record?.status ?? 'no record'}); the invite withdrawn`);
  return 'This invite was for an account transfer that is no longer open.';
}

/** What `account.getAutoDeletion` shows of a transfer (never the beneficiary's name or date of birth). */
export function transferView (record: TransferRecord | null, failedClaims: FailedClaims | null = null): Record<string, unknown> | null {
  if (record == null) return null;
  const view: Record<string, unknown> = { status: record.status, email: record.email };
  if (record.namedAt != null) view.beneficiaryNotifiedAt = record.namedAt;
  if (record.openedAt != null) view.openedAt = record.openedAt;
  if (record.endsAt != null) view.endsAt = record.endsAt;
  if (record.claimedBy != null) view.claimedBy = { username: record.claimedBy.username, at: record.claimedBy.at };
  if (failedClaims != null) view.failedClaims = { count: failedClaims.count, lastAt: failedClaims.lastAt };
  if (record.ownerToldAt != null) view.ownerNotifiedAt = record.ownerToldAt;
  if (record.closedAt != null) view.closedAt = record.closedAt;
  if (record.closedReason != null) view.closedReason = record.closedReason;
  return view;
}
