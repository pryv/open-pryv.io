/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { getLogger } from '@pryv/boiler';
import type { ConfigLike } from '@pryv/boiler';
import { createId as cuid } from '@paralleldrive/cuid2';
import timestamp from 'unix-timestamp';
import { factory as errors } from 'errors';
import { getErasuresLocal } from 'business/src/auth/erasures.ts';
import { getUsersRepository } from 'business/src/users/index.ts';
import { effectivePolicy, withNotice, ENGINE_BLOCKS, DAY_SECONDS } from 'business/src/autoDeletion/deadline.ts';
import type { Policy } from 'business/src/autoDeletion/deadline.ts';
import { completeTransfer, cancelTransfer } from 'business/src/autoDeletion/transferFlow.ts';
import type { TransferFlowDeps } from 'business/src/autoDeletion/transferFlow.ts';
import type { Setting, Bookkeeping } from 'business/src/autoDeletion/state.ts';
import { getState, loadAccountFacts, computeSchedule, sendConfirmation, sendTransferMail } from './autoDeletion.ts';
import type { AccountFacts } from './autoDeletion.ts';
import { autoDeletionConfig } from './autoDeletionPolicy.ts';
import { getTransferDelegation } from './transferDelegation.ts';

/**
 * An administrator stops a pending auto-deletion for a holder who cannot sign
 * in yet (`system.autoDeletion.reset`). Two acts:
 *  - by default the schedule restarts: its clock starts again from now, as a
 *    sign-in would, with its full reminders; the policy (the holder's or the
 *    operator's preset) is untouched. A holder's date has no clock: refused.
 *  - `removeSetting`: the holder's own schedule is removed (the platform's
 *    policy applies again, from now). The holder's own decision: only on
 *    their verified request.
 * A claim window not claimed yet is cancelled as a use of the account would
 * (the transfer stays armed, unless the setting goes). Once the claimant
 * controls the account the transfer is done: completed, and refused (409).
 * An erasure already started is refused. Every change is mailed to the
 * holder with the administrator's reason, recorded in the account's own
 * trail and logged (never the reason or an address in the log).
 */

const logger = getLogger('methods:autoDeletionAdmin');

/** Who the setting writes are attributed to in the field's history. */
const ADMIN = 'admin';
export const ADMIN_RESET_ACTION = 'account.autoDeletion.resetByAdmin';

type UserRef = { id: string; username: string };
type PlatformLike = {
  coreId: string;
  getUserCore (username: string): Promise<string | null>;
  coreIdToUrl (coreId: string): string;
};

export type ResetParams = { username: string; reason: string; removeSetting?: boolean };

export type ScheduleSummary = {
  source: 'user' | 'operator' | 'none';
  mode: string;
  action: string;
  deleteAt: number | null;
};

export type ResetResult = {
  cleared: boolean;
  removedSetting: boolean;
  transferCancelled: boolean;
  was: ScheduleSummary & { remindersSent: number };
  autoDeletion: ScheduleSummary;
  notified: 'mail' | 'audit-only' | 'none';
};

export type ResetOutcome = { kind: 'remote'; coreUrl: string } | { kind: 'done'; result: ResetResult };

function summary (policy: Policy | null, b: Bookkeeping | null): ScheduleSummary {
  if (policy == null || policy.mode === 'never') {
    return { source: policy?.source ?? 'none', mode: 'never', action: policy?.action ?? 'delete', deleteAt: null };
  }
  return { source: policy.source, mode: policy.mode, action: policy.action, deleteAt: b?.deleteAt ?? b?.deadline ?? null };
}

const sentCount = (b: Bookkeeping | null): number => (b?.reminders.sent ?? []).filter((s) => s.skipped !== true).length;
const dayOf = (t: number | null | undefined): number | null => t == null ? null : Math.floor(t / DAY_SECONDS);

/**
 * A row a restart would leave as it is: no reminder sent, no hold of the
 * sweep, the same policy and the same deadline day. A repeated call is then
 * no change (and no second mail).
 */
function isFresh (prev: Bookkeeping, next: Bookkeeping | null): boolean {
  if (next == null) return false;
  const engineBlock = (b: Bookkeeping) => b.blocked != null && ENGINE_BLOCKS.includes(b.blocked.reason) ? b.blocked.reason : null;
  if (prev.reminders.sent.length > 0 || (prev.blocked != null && engineBlock(prev) == null)) return false;
  if (engineBlock(prev) !== engineBlock(next)) return false;
  const a = prev.appliedPolicy;
  const n = next.appliedPolicy;
  return a.source === n.source && a.mode === n.mode && a.inactivityDays === n.inactivityDays && a.date === n.date &&
    dayOf(prev.deadline) === dayOf(next.deadline);
}

function erasureInProgress () {
  return errors.invalidOperation('The erasure of this account has started; it cannot be stopped (the sweep completes it).', { reason: 'erasure-in-progress' });
}

/** Restart, or remove the holder's setting; or where the account lives, when on another core. */
export async function resetAutoDeletion (config: ConfigLike, platform: PlatformLike, params: ResetParams): Promise<ResetOutcome> {
  const adConfig = autoDeletionConfig(config);
  if (!adConfig.enabled) throw errors.unavailableMethod('Account auto-deletion is disabled on this platform.');
  const usersRepository = await getUsersRepository();
  const userId = await usersRepository.getUserIdForUsername(params.username) as string | null;
  if (userId == null) {
    const coreId = await platform.getUserCore(params.username);
    if (coreId != null && coreId !== platform.coreId) return { kind: 'remote', coreUrl: platform.coreIdToUrl(coreId) };
    throw errors.unknownResource('user', params.username);
  }
  // The name may be an alias: the account is named by its own username.
  const user: UserRef = { id: userId, username: (await usersRepository.getUsernameForUserId(userId) as string | null) ?? params.username };
  const erasures = await getErasuresLocal();
  if (await erasures.get(userId) != null) throw erasureInProgress();

  const state = await getState();
  const now = timestamp.now();
  const setting = await state.getSetting(userId);
  const prev = await state.getBookkeeping(userId);
  const transfer = await state.getTransfer(userId);
  const facts = await loadAccountFacts(config, user);
  const before = effectivePolicy(setting, adConfig, facts.presetApplies);
  const was = { ...summary(before, prev), remindersSent: sentCount(prev) };
  const flow: TransferFlowDeps<AccountFacts> = {
    state,
    config: adConfig,
    now: () => timestamp.now(),
    sendTransferMail: (account, f, notice) => sendTransferMail(config, account, f, notice)
  };
  const unchanged = (): ResetOutcome => ({
    kind: 'done',
    result: { cleared: false, removedSetting: false, transferCancelled: false, was, autoDeletion: summary(before, prev), notified: 'none' }
  });

  // A claim window, as the sweep sees one (it runs only under a setting).
  const window = setting != null && (transfer?.status === 'open' || transfer?.status === 'claimed') ? transfer : null;
  let inviteOut = false;
  if (window?.status === 'claimed' && window.claimedBy != null) {
    const rel = await getTransferDelegation()?.stateOf(user, window.claimedBy.username);
    if (rel?.status === 'active') {
      // The claimant controls the account: the transfer is done.
      await completeTransfer(flow, user, facts, window);
      logger.warn(`auto-deletion: reset of account "${user.username}" (${user.id}) refused: "${window.claimedBy.username}" controls it, transfer completed`);
      throw errors.autoDeletionTransferClaimed();
    }
    inviteOut = rel?.status === 'invite';
  }

  const holderSchedule = setting != null && (setting.mode === 'date' || setting.mode === 'inactivity');
  const removing = params.removeSetting === true && holderSchedule;
  if (setting?.mode === 'date' && !removing) {
    throw errors.invalidOperation('This account is set to be deleted or transferred on a date the holder chose: it has no clock to restart. ' +
      'Remove the holder\'s setting ("removeSetting": true) only on their own verified request.', { reason: 'date-schedule' });
  }
  // "never" is never removed: it would arm the platform's preset.
  if (setting?.mode === 'never') return unchanged();
  if (!removing && window == null) {
    if (prev == null) return unchanged();
    if (isFresh(prev, computeSchedule(adConfig, setting, facts, null, now).evaluation.bookkeeping)) return unchanged();
  }

  // The transfer: a window not claimed yet is cancelled as a use of the
  // account cancels it; one only named goes with the setting.
  let transferCancelled = false;
  let next: Setting | null = setting;
  if (window != null) {
    if (inviteOut && window.claimedBy != null) {
      try {
        await getTransferDelegation()?.withdraw(user, window.claimedBy.username);
      } catch (err) {
        logger.warn(`auto-deletion: the pending invite of account "${user.username}" (${user.id}) to "${window.claimedBy.username}" was not withdrawn: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const declined = window.closedReason === 'declined';
    await cancelTransfer(flow, user, facts, window, { reason: 'operator', mailOwner: false, keepIdentity: !removing && !declined });
    transferCancelled = true;
    // The beneficiary had declined: the schedule goes on as the owner's
    // fallback, never as a transfer to them again.
    if (declined && !removing && setting != null) {
      const { transfer: _t, ...rest } = setting;
      next = { ...rest, action: 'delete', updatedAt: now };
      await state.setSetting(userId, next, ADMIN);
    }
  }
  if (removing) {
    if (window == null && transfer?.status === 'named') {
      await cancelTransfer(flow, user, facts, transfer, { reason: 'operator', mailOwner: false });
      transferCancelled = true;
    }
    if (setting?.action === 'transfer') await state.eraseIdentity(userId);
    next = null;
    await state.setSetting(userId, null, ADMIN);
  }

  // The schedule starts again from now (the row of the old one goes).
  const schedule = computeSchedule(adConfig, next, facts, null, now);
  let b = schedule.evaluation.bookkeeping;
  await state.saveBookkeeping(userId, prev, b);
  // An erasure that started meanwhile wins: the honest answer.
  if (await erasures.get(userId) != null) throw erasureInProgress();

  const mailed = await sendConfirmation(config, user, facts, schedule, now, next, { BY_OPERATOR: 'true', OPERATOR_REASON: params.reason });
  if (mailed && b != null) {
    const noticed = withNotice(b, now);
    await state.saveBookkeeping(userId, b, noticed);
    b = noticed;
  }
  const result: ResetResult = {
    cleared: true,
    removedSetting: removing,
    transferCancelled,
    was,
    autoDeletion: summary(schedule.policy, b),
    notified: mailed ? 'mail' : 'audit-only'
  };
  await auditReset(config, userId, {
    reason: params.reason,
    removedSetting: removing,
    transferCancelled,
    was: { ...was, deadline: prev?.deadline ?? null, transferStatus: transfer?.status ?? null },
    now: { ...result.autoDeletion, deadline: b?.deadline ?? null }
  });
  logger.warn(`auto-deletion: an administrator reset the schedule of account "${user.username}" (${user.id}): ` +
    `${removing ? 'the holder\'s setting removed' : 'restarted from now'}${transferCancelled ? ', transfer cancelled' : ''}, ` +
    `was ${was.source} ${was.mode}, now ${result.autoDeletion.source} ${result.autoDeletion.mode}`);
  return { kind: 'done', result };
}

/**
 * Row of the reset in the account's own trail: what was pending and what is
 * now, and the administrator's reason; never an address. The admin call
 * itself is audited without a user (its caller holds no access of the account).
 */
async function auditReset (config: ConfigLike, userId: string, record: Record<string, unknown>): Promise<void> {
  try {
    if (config.get('audit:active') !== true) return;
    const auditSingleton = (await import('audit')).default;
    const C = auditSingleton.CONSTANTS;
    const now = timestamp.now();
    await auditSingleton.eventForUser(userId, {
      id: cuid(),
      createdBy: 'system',
      modifiedBy: 'system',
      streamIds: [C.ACTION_STREAM_ID_PREFIX + ADMIN_RESET_ACTION],
      time: now,
      endTime: now,
      created: now,
      modified: now,
      trashed: false,
      type: 'audit-log/account-auto-deletion',
      content: { action: ADMIN_RESET_ACTION, source: { name: 'admin' }, record }
    }, ADMIN_RESET_ACTION);
  } catch (err) {
    logger.error(`auto-deletion: the reset audit row of user ${userId} was not written`, err);
  }
}
