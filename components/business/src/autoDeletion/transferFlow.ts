/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The ends of a transfer, shared by the sweep and the claim / decline methods:
 * completed (the claimant controls the account), lapsed (window ended, the
 * owner chose to keep the account), cancelled (owner change, account use
 * before a claim, a decline). Each closes the record, erases the beneficiary's
 * identity and mails who needs to know. Storage and mail come in as
 * dependencies.
 *
 * A closed record is kept: it is the record of what happened (who claimed the
 * account, when). A new transfer replaces it.
 */

import type { AutoDeletionConfig } from './config.ts';
import type { Setting, Bookkeeping, TransferRecord, TransferStatus } from './state.ts';

export type TransferMailKind = 'named' | 'claim' | 'started' | 'cancelled' | 'lapsed' | 'completed';

export type TransferNotice = {
  kind: TransferMailKind;
  to: 'owner' | 'beneficiary';
  record: TransferRecord;
  /** The holder's setting when the mail is built (the beneficiary's address, the fallback). */
  setting: Setting | null;
  now: number;
  /** Why it was cancelled / how it ended (`owner-change`, `owner-activity`, `delegate-activity`, `declined`). */
  reason?: string;
};

export type TransferSendOutcome = 'sent' | 'off' | 'rejected' | 'failed';

export type TransferAccount = { id: string; username: string };

export type TransferFlowState = {
  getSetting (userId: string): Promise<Setting | null>;
  setSetting (userId: string, setting: Setting | null, createdBy: string): Promise<void>;
  getBookkeeping (userId: string): Promise<Bookkeeping | null>;
  saveBookkeeping (userId: string, prev: Bookkeeping | null, next: Bookkeeping | null): Promise<boolean>;
  getTransfer (userId: string): Promise<TransferRecord | null>;
  saveTransfer (userId: string, record: TransferRecord | null): Promise<void>;
  eraseIdentity (userId: string): Promise<void>;
};

export type TransferFlowDeps<F> = {
  state: TransferFlowState;
  config: AutoDeletionConfig;
  sendTransferMail: (account: TransferAccount, facts: F, notice: TransferNotice) => Promise<TransferSendOutcome>;
  now: () => number;
};

function closed (record: TransferRecord, status: TransferStatus, now: number, reason?: string): TransferRecord {
  const next: TransferRecord = { ...record, status, closedAt: now };
  if (reason != null) next.closedReason = reason;
  return next;
}

/** Mails one party; a failure is the mailer's to log, it never stops the flow. */
async function tell<F> (deps: TransferFlowDeps<F>, account: TransferAccount, facts: F, notice: TransferNotice): Promise<void> {
  try {
    await deps.sendTransferMail(account, facts, notice);
  } catch (_err) { /* best effort: the mailer logs */ }
}

/**
 * The claimant controls the account: the holder's setting goes (the account
 * continues under its controller; a new schedule needs the owner's own
 * login), the schedule goes, the identity is erased, both are mailed.
 */
export async function completeTransfer<F> (deps: TransferFlowDeps<F>, account: TransferAccount, facts: F, record: TransferRecord): Promise<TransferRecord> {
  const now = deps.now();
  const setting = await deps.state.getSetting(account.id);
  const done = closed(record, 'completed', now);
  await deps.state.saveTransfer(account.id, done);
  // Mailed before the identity goes: the owner's copy names the beneficiary as they did.
  await tell(deps, account, facts, { kind: 'completed', to: 'owner', record: done, setting, now });
  await tell(deps, account, facts, { kind: 'completed', to: 'beneficiary', record: done, setting, now });
  await finishTransfer(deps, account, done);
  return done;
}

/**
 * The state changes that follow a closed `completed` or `lapsed` record, no
 * mail: the identity goes, then the setting (cleared, or kept as "never").
 * Run right after the record is closed, and again by the sweep when a
 * process stopped in between (the record is closed first, so a half-done end
 * is never taken for a transfer still to open).
 */
export async function finishTransfer<F> (deps: TransferFlowDeps<F>, account: TransferAccount, record: TransferRecord): Promise<void> {
  await deps.state.eraseIdentity(account.id);
  if (record.status === 'lapsed') {
    await keepAccount(deps, account);
    return;
  }
  if (await deps.state.getSetting(account.id) != null) await deps.state.setSetting(account.id, null, 'system');
  const prev = await deps.state.getBookkeeping(account.id);
  if (prev != null) await deps.state.saveBookkeeping(account.id, prev, null);
}

/**
 * The holder's setting once a transfer can no longer happen and the owner
 * chose to keep the account: "never" where the holder may opt out, else the
 * platform's policy (its full schedule starts again: the schedule row goes).
 */
export async function keepAccount<F> (deps: TransferFlowDeps<F>, account: TransferAccount): Promise<void> {
  const now = deps.now();
  const setting: Setting | null = deps.config.allowUserOptOut ? { mode: 'never', action: 'delete', updatedAt: now } : null;
  await deps.state.setSetting(account.id, setting, 'system');
  const prev = await deps.state.getBookkeeping(account.id);
  if (prev != null) await deps.state.saveBookkeeping(account.id, prev, null);
}

/** Window ended without a claim, fallback `keep`: the account stays, the owner is told. */
export async function lapseTransfer<F> (deps: TransferFlowDeps<F>, account: TransferAccount, facts: F, record: TransferRecord, reason?: string): Promise<TransferRecord> {
  const now = deps.now();
  const setting = await deps.state.getSetting(account.id);
  const done = closed(record, 'lapsed', now, reason);
  await deps.state.saveTransfer(account.id, done);
  await tell(deps, account, facts, { kind: 'lapsed', to: 'owner', record: done, setting, now, reason });
  await finishTransfer(deps, account, done);
  return done;
}

/**
 * Closes an open transfer as cancelled (or declined). The beneficiary is
 * mailed only when they had been told about it (at setup, or a claim mail);
 * the owner when `mailOwner` (they did not cause it themselves in the app).
 * The identity is erased unless the holder's transfer setting stays
 * (`keepIdentity`: account use cancels this window, the transfer is armed
 * again).
 */
export async function cancelTransfer<F> (deps: TransferFlowDeps<F>, account: TransferAccount, facts: F, record: TransferRecord,
  opts: { status?: 'cancelled' | 'declined'; reason: string; mailOwner: boolean; keepIdentity?: boolean }): Promise<TransferRecord> {
  const now = deps.now();
  const setting = await deps.state.getSetting(account.id);
  const done = closed(record, opts.status ?? 'cancelled', now, opts.reason);
  await deps.state.saveTransfer(account.id, done);
  if (opts.keepIdentity !== true) await deps.state.eraseIdentity(account.id);
  const beneficiaryKnows = record.namedAt != null || (record.claimMailsSent?.length ?? 0) > 0;
  if (beneficiaryKnows && opts.status !== 'declined') {
    await tell(deps, account, facts, { kind: 'cancelled', to: 'beneficiary', record: done, setting, now, reason: opts.reason });
  }
  if (opts.mailOwner) await tell(deps, account, facts, { kind: 'cancelled', to: 'owner', record: done, setting, now, reason: opts.reason });
  return done;
}
