/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The auto-deletion sweep: one pass over the accounts of this core, applying
 * the schedule engine (`deadline.ts`). Storage, mail, the deletion guards and
 * the erasure come in as dependencies, so the pass runs with a fake clock and
 * a fake mailer in tests.
 *
 * A pass first completes the account erasures left unfinished on this core
 * (whatever started them: this sweep or `auth.delete`), from the core's record
 * of erasures in progress; this runs even with the feature off. Then, per
 * account:
 *  - nothing applies (no setting, no preset, no bookkeeping): skipped, nothing
 *    read beyond the setting and the bookkeeping, nothing written;
 *  - a reminder is due: the bookkeeping is saved first, then the mail is sent,
 *    then the notice is recorded. A crash between the send and the record
 *    sends that reminder again; none is ever skipped. A recipient the mail
 *    server refuses is logged once per account and lead; a transport failure
 *    stops the mail of the rest of the pass (one summary line), the reminders
 *    stay due for the next one;
 *  - the account is due: its activity is read again (a sign-in since the
 *    evaluation wins), the deletion guards are asked (a refusal is recorded as
 *    `blocked`, mailed to the holder once, and asked again on every later
 *    pass, silently), then the account is erased between two WARN log lines.
 *    The erasure keeps its own record: one that fails half-way is completed
 *    by a later pass.
 *
 * A `transfer` policy runs the same schedule and reminders; when it is due the
 * sweep opens the claim window instead of erasing (`transfer.claimWindowDays`):
 * the beneficiary gets the claim link (sent again 30 and 60 days later), the
 * owner is told. While the window is open, a pass completes the transfer once
 * the claimant controls the account, cancels it when the account was used
 * before a claim (inactivity schedules; the clock restarts), lifts the
 * failed-claim lock, and at the window end applies the owner's fallback:
 * `keep` lapses the transfer (the account stays), `delete` erases the account
 * as a direct deletion would (guards, self-deletion, the cap).
 *
 * A pass still running when the next one is asked for makes that one a no-op.
 * `maxDeletionsPerPass` caps the erasures a pass starts (0: no cap); the rest
 * wait for the next pass. `dryRun` logs what would be sent and erased, sends,
 * erases and writes nothing (a written bookkeeping would start the clocks the
 * real sweep reads later).
 */

import type { AutoDeletionConfig } from './config.ts';
import type { Setting, Bookkeeping, TransferRecord } from './state.ts';
import type { AccountActivity } from '../accesses/accountActivity.ts';
import { effectivePolicy, evaluate, withNotice, ENGINE_BLOCKS, DAY_SECONDS } from './deadline.ts';
import type { Policy, Evaluation } from './deadline.ts';
import { STALE_ERASURE_MS } from '../auth/erasures.ts';
import { newSalt, claimMailDue, windowEnded } from './transfer.ts';
import { completeTransfer, lapseTransfer, cancelTransfer } from './transferFlow.ts';
import type { TransferFlowState, TransferNotice, TransferFlowDeps } from './transferFlow.ts';

export type SweepAccount = { id: string; username: string };

/** What the sweep needs to know about an account (callers may pass more). */
export type SweepFacts = {
  activity: AccountActivity;
  /** The account has an email address and the core can send mail. */
  notifiable: boolean;
  /** An operator preset covers this account. */
  presetApplies: boolean;
  /** Account use is recorded; false suspends inactivity schedules (default true). */
  inactivityMeasurable?: boolean;
  /** The holder may delete the account themselves; false holds their own deletion schedules (default true). */
  selfDeletionAllowed?: boolean;
};

export type Notice = {
  policy: Policy;
  bookkeeping: Bookkeeping;
  /** The reminder's lead in days (reminders only). */
  leadDays?: number;
  now: number;
  /** The holder's setting (a transfer's beneficiary and fallback). */
  setting?: Setting | null;
};

/**
 * `off`: this mail is switched off by the operator (not a failure).
 * `rejected`: the mail server refused this recipient (this account only).
 * `failed`: the mail could not be handed over (the transport is down).
 */
export type SendOutcome = 'sent' | 'off' | 'rejected' | 'failed';

/** `guard`: the deletion guard that objected, when one did. */
export type Objection = { reason: string; message: string; guard?: string };

export type Trigger = 'date' | 'inactivity' | 'transfer-fallback';

/** The account a transfer was claimed for. */
export type ClaimedBy = NonNullable<TransferRecord['claimedBy']>;

/** An erasure left unfinished, from the core's record of erasures in progress. */
export type PendingErasure = {
  userId: string;
  username: string;
  trigger: string | null;
  /** Epoch ms of its last progress. */
  updatedAt: number;
};

export type ErasureRecord = {
  username: string;
  userId: string;
  trigger: Trigger;
  source: 'user' | 'operator';
  deadline: number | null;
  deleteAt: number | null;
  /** Send times of the notices (the confirmation, when it was the first, and the reminders). */
  notices: number[];
};

/** The three levels the sweep writes to (a narrower view than the boiler Logger, so a test can pass a capture). */
type LoggerLike = {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
};

export type SweepState = TransferFlowState;

export type SweepDeps<F extends SweepFacts = SweepFacts> = {
  /** Read at every pass: a config change applies from the next one. */
  getConfig: () => AutoDeletionConfig;
  listAccounts: () => Promise<SweepAccount[]>;
  /** The erasures in progress on this core. */
  listPendingErasures: () => Promise<PendingErasure[]>;
  state: SweepState;
  loadFacts: (account: SweepAccount) => Promise<F>;
  /** Activity only, read again right before an erasure. */
  readActivity: (account: SweepAccount) => Promise<AccountActivity>;
  sendReminder: (account: SweepAccount, facts: F, notice: Notice) => Promise<SendOutcome>;
  sendBlocked: (account: SweepAccount, facts: F, notice: Notice) => Promise<SendOutcome>;
  /** The transfer mails, to the owner or the beneficiary. */
  sendTransferMail: (account: SweepAccount, facts: F, notice: TransferNotice) => Promise<SendOutcome>;
  /** The delegation of the account to the claimant: `active` completes the transfer. Throws when it cannot be read. */
  delegationOf: (account: SweepAccount, claimedBy: ClaimedBy) => Promise<'active' | 'invite' | 'none'>;
  /** Withdraws the claimant's pending invite (window ended). Best effort. */
  withdrawInvite: (account: SweepAccount, claimedBy: ClaimedBy) => Promise<void>;
  /** The deletion guards' objection, or null. Throws when the erasure cannot be attempted (an operator problem). */
  checkErasable: (account: SweepAccount) => Promise<Objection | null>;
  /** Erases the account, or completes its unfinished erasure. */
  erase: (account: SweepAccount, options: { trigger?: Trigger }) => Promise<void>;
  /** Durable record of the erasure (an audit row that outlives the account), written before it starts. */
  recordErasure?: (account: SweepAccount, record: ErasureRecord) => Promise<void>;
  /** Pryv seconds. */
  now: () => number;
  logger: LoggerLike;
};

export type PassResult = {
  /** A pass was already running: this one did nothing. */
  skipped: boolean;
  dryRun: boolean;
  /** Accounts a policy or a bookkeeping row applies to. */
  accounts: number;
  reminders: number;
  /** Reminders refused for their recipient. */
  reminderFailures: number;
  remindersOff: number;
  /** Mails not attempted this pass after a transport failure (that one included). */
  mailHeld: number;
  erased: number;
  /** Unfinished erasures completed. */
  completed: number;
  blocked: number;
  /** Due accounts left for the next pass by `maxDeletionsPerPass`. */
  deferred: number;
  /** Accounts whose pass threw (logged), and erasures that failed. */
  failed: number;
  wouldRemind: number;
  wouldErase: number;
  /** Claim windows opened, transfers completed, lapsed (`keep`) and cancelled by account use. */
  transfersOpened: number;
  transfersCompleted: number;
  transfersLapsed: number;
  transfersCancelled: number;
  wouldOpen: number;
};

/** An erasure record untouched for this long is no longer running: it is completed. */
export { STALE_ERASURE_MS };

function emptyResult (dryRun: boolean, skipped = false): PassResult {
  return {
    skipped,
    dryRun,
    accounts: 0,
    reminders: 0,
    reminderFailures: 0,
    remindersOff: 0,
    mailHeld: 0,
    erased: 0,
    completed: 0,
    blocked: 0,
    deferred: 0,
    failed: 0,
    wouldRemind: 0,
    wouldErase: 0,
    transfersOpened: 0,
    transfersCompleted: 0,
    transfersLapsed: 0,
    transfersCancelled: 0,
    wouldOpen: 0
  };
}

/** The message of `err`, or of the error an API error wraps (its own says only "Unexpected error"). */
function errorText (err: unknown): string {
  const inner = (err as { innerError?: unknown } | null)?.innerError;
  const e = inner instanceof Error ? inner : err;
  return e instanceof Error ? e.message : String(e);
}

function withoutBlocked (b: Bookkeeping): Bookkeeping {
  const { blocked: _blocked, ...rest } = b;
  return rest as Bookkeeping;
}

const isGuardBlock = (blocked: Bookkeeping['blocked'] | undefined): boolean => blocked != null && !ENGINE_BLOCKS.includes(blocked.reason);

export function createAutoDeletionSweep<F extends SweepFacts> (deps: SweepDeps<F>) {
  const { state, logger } = deps;
  let running = false;
  // Log-once memory, per process: a recipient refused at every pass is
  // reported once, not at every pass.
  const refusedReminders = new Set<string>();

  type PassContext = {
    config: AutoDeletionConfig;
    result: PassResult;
    erasuresStarted: number;
    /** A send failed at the transport: no more mail this pass. */
    mailDown: boolean;
    /** Accounts with an erasure in progress: not scheduled again. */
    erasing: Set<string>;
  };

  async function runPass (): Promise<PassResult> {
    if (running) {
      logger.warn('auto-deletion sweep: the previous pass is still running, this one is skipped');
      return emptyResult(false, true);
    }
    running = true;
    try {
      return await pass();
    } finally {
      running = false;
    }
  }

  async function pass (): Promise<PassResult> {
    const config = deps.getConfig();
    const ctx: PassContext = { config, result: emptyResult(config.dryRun), erasuresStarted: 0, mailDown: false, erasing: new Set() };
    await completeErasures(ctx);
    if (!config.enabled) return ctx.result;
    for (const account of await deps.listAccounts()) {
      if (ctx.erasing.has(account.id)) continue;
      try {
        await processAccount(account, ctx);
      } catch (err) {
        ctx.result.failed++;
        logger.error(`auto-deletion sweep: account "${account.username}" (${account.id}) not processed, retried on the next pass: ${errorText(err)}`);
      }
    }
    const r = ctx.result;
    if (r.dryRun && (r.wouldRemind > 0 || r.wouldErase > 0 || r.wouldOpen > 0)) {
      logger.info(`auto-deletion sweep (dry run): ${r.wouldRemind} reminder(s), ${r.wouldErase} erasure(s) and ${r.wouldOpen} transfer(s) would have been done; nothing was sent, erased or written`);
    }
    if (r.transfersOpened > 0 || r.transfersCompleted > 0 || r.transfersLapsed > 0 || r.transfersCancelled > 0) {
      logger.info(`auto-deletion sweep: transfers: ${r.transfersOpened} claim window(s) opened, ${r.transfersCompleted} completed, ${r.transfersLapsed} lapsed, ${r.transfersCancelled} cancelled by account use`);
    }
    if (ctx.mailDown) {
      logger.warn(`auto-deletion sweep: the mail transport failed; ${r.mailHeld} mail(s) of this pass not sent, sent at the next pass (the deletions they announce wait for them)`);
    }
    if (r.reminders > 0 || r.erased > 0 || r.completed > 0 || r.blocked > 0 || r.deferred > 0 || r.failed > 0 || r.reminderFailures > 0) {
      logger.info(`auto-deletion sweep: ${r.accounts} account(s) with a schedule, ${r.reminders} reminder(s) sent, ${r.reminderFailures} refused, ${r.erased} account(s) erased, ${r.completed} unfinished erasure(s) completed, ${r.blocked} newly blocked, ${r.deferred} left for the next pass (maxDeletionsPerPass), ${r.failed} failure(s)`);
    }
    if (r.remindersOff > 0) {
      logger.info(`auto-deletion sweep: ${r.remindersOff} reminder(s) due but services.email.enabled.accountDeletionReminder is false: without a first notice, those accounts are not deleted`);
    }
    return r;
  }

  /** Completes the erasures left unfinished (a failed step, a crash); not counted in the cap. */
  async function completeErasures (ctx: PassContext): Promise<void> {
    let pending: PendingErasure[];
    try {
      pending = await deps.listPendingErasures();
    } catch (err) {
      ctx.result.failed++;
      logger.error(`auto-deletion sweep: the erasures in progress could not be read: ${errorText(err)}`);
      return;
    }
    const nowMs = deps.now() * 1000;
    for (const p of pending) {
      ctx.erasing.add(p.userId);
      // A fresh record is an erasure running right now, elsewhere.
      if (nowMs - p.updatedAt < STALE_ERASURE_MS) continue;
      const account = { id: p.userId, username: p.username };
      if (ctx.config.dryRun) {
        logger.info(`auto-deletion sweep (dry run): would complete the unfinished erasure of account "${p.username}" (${p.userId})`);
        continue;
      }
      const record = { username: p.username, userId: p.userId, trigger: p.trigger };
      logger.warn(`auto-deletion: completing the unfinished erasure of account "${p.username}" (${p.userId}), trigger ${p.trigger ?? 'unknown'}`, record);
      try {
        await deps.erase(account, {});
      } catch (err) {
        ctx.result.failed++;
        logger.error(`auto-deletion: the erasure of account "${p.username}" (${p.userId}) failed again, completed on a later pass: ${errorText(err)}`);
        continue;
      }
      ctx.result.completed++;
      logger.warn(`auto-deletion: account "${p.username}" (${p.userId}) erased, trigger ${p.trigger ?? 'unknown'}`, record);
    }
  }

  /** Sends one mail unless the transport already failed this pass. */
  async function send (ctx: PassContext, mail: () => Promise<SendOutcome>): Promise<SendOutcome | 'held'> {
    if (ctx.mailDown) {
      ctx.result.mailHeld++;
      return 'held';
    }
    const outcome = await mail();
    if (outcome === 'failed') {
      ctx.mailDown = true;
      ctx.result.mailHeld++;
    }
    return outcome;
  }

  async function processAccount (account: SweepAccount, ctx: PassContext): Promise<void> {
    const { config, result } = ctx;
    const setting = await state.getSetting(account.id);
    const prev = await state.getBookkeeping(account.id);
    // Nothing applies and nothing to clean up: the common case, never written.
    const nothingSet = setting == null ? config.inactivity.defaultDays == null : setting.mode === 'never';
    if (prev == null && nothingSet) return;

    const facts = await deps.loadFacts(account);
    const policy = effectivePolicy(setting, config, facts.presetApplies);
    if (policy != null && policy.mode !== 'never') result.accounts++;
    const transfer = policy?.action === 'transfer' ? await state.getTransfer(account.id) : null;

    // A guard refusal holds the engine's `due`: judge the schedule without it,
    // then ask the guards again.
    const guardBlock = isGuardBlock(prev?.blocked) ? prev!.blocked! : null;
    const judge = (activity: AccountActivity): Evaluation => evaluate({
      policy,
      activity,
      prev: guardBlock != null ? withoutBlocked(prev!) : prev,
      now: deps.now(),
      config,
      notifiable: facts.notifiable,
      acknowledgedNoReminders: setting?.acknowledgedNoReminders === true,
      inactivityMeasurable: facts.inactivityMeasurable
    });
    let evaluation = judge(facts.activity);
    let b = evaluation.bookkeeping;
    if (b?.blocked?.reason === 'inactivity-unavailable' && prev?.blocked?.reason !== 'inactivity-unavailable') {
      logger.warn(`auto-deletion sweep: the inactivity schedule of account "${account.username}" (${account.id}) is suspended: account use is not recorded (accessTracking.isActive is false)`);
    }
    let stored = prev;
    const save = async (next: Bookkeeping | null): Promise<void> => {
      if (config.dryRun) return;
      await state.saveBookkeeping(account.id, stored, next);
      stored = next;
    };

    if (policy != null && setting != null && transfer != null && (transfer.status === 'open' || transfer.status === 'claimed')) {
      await runWindow({ account, ctx, facts, setting, policy, prev, guardBlock, evaluation, save }, transfer);
      return;
    }
    if (policy != null && setting?.transfer != null && transfer?.status === 'named' && transfer.namedAt == null &&
        transfer.email === setting.transfer.email && !config.dryRun) {
      // The beneficiary's notice at setup did not go out: tried again.
      const now = deps.now();
      if (await send(ctx, () => deps.sendTransferMail(account, facts, { kind: 'named', to: 'beneficiary', record: transfer, setting, now })) === 'sent') {
        await state.saveTransfer(account.id, { ...transfer, namedAt: now });
      }
    }

    if (evaluation.reminder != null && b != null && policy != null) {
      const leadDays = evaluation.reminder;
      if (config.dryRun) {
        result.wouldRemind++;
        logger.info(`auto-deletion sweep (dry run): would send the ${leadDays}-day reminder to account "${account.username}" (${account.id})`);
      } else if (ctx.mailDown) {
        result.mailHeld++;
      } else {
        await save(b); // intent first: a crash after the send repeats it, never skips it
        const now = deps.now();
        const notice = { policy, bookkeeping: b, leadDays, now, setting };
        const outcome = await send(ctx, () => deps.sendReminder(account, facts, notice));
        const key = `${account.id}:${b.reminders.deadlineDay}:${leadDays}`;
        if (outcome === 'sent') {
          refusedReminders.delete(key);
          b = withNotice(b, now, leadDays);
          await save(b);
          result.reminders++;
        } else if (outcome === 'off') {
          result.remindersOff++;
        } else if (outcome === 'rejected') {
          result.reminderFailures++;
          if (!refusedReminders.has(key)) {
            refusedReminders.add(key);
            logger.warn(`auto-deletion sweep: the ${leadDays}-day reminder to account "${account.username}" (${account.id}) was refused by the mail server; retried at every pass, not logged again`);
          }
        }
      }
    }

    if (!evaluation.due || b == null || policy == null) {
      await save(b);
      return;
    }

    // Due. A transfer opens its claim window instead (not an erasure: no cap).
    const isTransfer = policy.action === 'transfer';
    if (!isTransfer && config.maxDeletionsPerPass > 0 && ctx.erasuresStarted >= config.maxDeletionsPerPass) {
      result.deferred++;
      if (guardBlock != null) b = { ...b, blocked: guardBlock };
      await save(b);
      return;
    }
    // A sign-in since the evaluation moves the deadline: judge again.
    const fresh = await deps.readActivity(account);
    if (fresh.at !== facts.activity.at) {
      evaluation = judge(fresh);
      b = evaluation.bookkeeping;
      if (!evaluation.due || b == null) {
        logger.info(`auto-deletion sweep: account "${account.username}" (${account.id}) was used while being checked: not ${isTransfer ? 'transferred' : 'erased'}`);
        await save(b);
        return;
      }
    }
    const p: AccountPass = { account, ctx, facts, setting, policy, prev, guardBlock, evaluation, save };
    if (isTransfer) {
      await openWindow(p, b, transfer);
      return;
    }

    // A deletion the holder chose needs self-deletion still allowed (the
    // operator may have withdrawn it since); the operator's preset does not.
    const objection = await erasureObjection(p);
    if (objection != null) {
      await hold(p, b, objection);
      return;
    }

    if (config.dryRun) {
      result.wouldErase++;
      logger.info(`auto-deletion sweep (dry run): would erase account "${account.username}" (${account.id}), trigger ${policy.mode}`);
      return;
    }
    ctx.erasuresStarted++;
    b = withoutBlocked(b);
    await save(b);
    await erase(account, b, ctx);
  }

  /** What one account's pass holds, for the steps below. */
  type AccountPass = {
    account: SweepAccount;
    ctx: PassContext;
    facts: F;
    setting: Setting | null;
    policy: Policy;
    prev: Bookkeeping | null;
    guardBlock: Bookkeeping['blocked'] | null;
    evaluation: Evaluation;
    save: (next: Bookkeeping | null) => Promise<void>;
  };

  async function erasureObjection (p: AccountPass): Promise<Objection | null> {
    if (p.policy.source === 'user' && p.facts.selfDeletionAllowed === false) {
      return { reason: 'self-deletion-disabled', message: 'user-account.delete no longer lets the holder delete the account' };
    }
    return await deps.checkErasable(p.account);
  }

  /** The erasure is refused: recorded as `blocked`, mailed once, asked again at every pass. */
  async function hold (p: AccountPass, b: Bookkeeping, objection: Objection): Promise<void> {
    const { account, ctx, facts, policy, guardBlock } = p;
    if (ctx.config.dryRun) {
      logger.info(`auto-deletion sweep (dry run): account "${account.username}" (${account.id}) is due, its deletion would be refused: ${objection.message}`);
      return;
    }
    let blocked = guardBlock != null && guardBlock.reason === objection.reason && guardBlock.guard === objection.guard ? guardBlock : null;
    if (blocked == null) {
      blocked = { reason: objection.reason, at: deps.now() };
      if (objection.guard != null) blocked.guard = objection.guard;
      ctx.result.blocked++;
      logger.warn(`auto-deletion sweep: account "${account.username}" (${account.id}) is due but its deletion is refused (${objection.message}); asked again at every pass`);
    }
    let next: Bookkeeping = { ...b, blocked };
    if (blocked.notifiedAt == null && facts.notifiable) {
      const now = deps.now();
      const notice = { policy, bookkeeping: next, now, setting: p.setting };
      if (await send(ctx, () => deps.sendBlocked(account, facts, notice)) === 'sent') {
        next = { ...next, blocked: { ...blocked, notifiedAt: now } };
      }
    }
    await p.save(next);
  }

  function flowDeps (ctx: PassContext): TransferFlowDeps<F> {
    return {
      state,
      config: ctx.config,
      now: deps.now,
      // The flow's mails respect the pass's transport state like the others.
      sendTransferMail: async (account, facts, notice) => {
        const outcome = await send(ctx, () => deps.sendTransferMail(account, facts, notice));
        return outcome === 'held' ? 'failed' : outcome;
      }
    };
  }

  /** The schedule of a transfer is due: open the claim window and tell both. */
  async function openWindow (p: AccountPass, b: Bookkeeping, previous: TransferRecord | null): Promise<void> {
    const { account, ctx, facts, setting } = p;
    const transferSetting = setting?.transfer;
    if (transferSetting == null) throw new Error('a transfer policy without its transfer setting');
    if (ctx.config.dryRun) {
      ctx.result.wouldOpen++;
      logger.info(`auto-deletion sweep (dry run): would open the transfer claim window of account "${account.username}" (${account.id})`);
      return;
    }
    const now = deps.now();
    const named = previous?.status === 'named' && previous.email === transferSetting.email ? previous : null;
    let record: TransferRecord = {
      email: transferSetting.email,
      status: 'open',
      createdAt: named?.createdAt ?? now,
      declineSalt: named?.declineSalt ?? newSalt(),
      openedAt: now,
      endsAt: now + ctx.config.transfer.claimWindowDays * DAY_SECONDS,
      claimSalt: newSalt(),
      claimMailsSent: []
    };
    if (named?.namedAt != null) record.namedAt = named.namedAt;
    await p.save(withoutBlocked(b));
    await state.saveTransfer(account.id, record);
    ctx.result.transfersOpened++;
    logger.warn(`auto-deletion: transfer of account "${account.username}" (${account.id}) started, claim window until ${new Date(record.endsAt! * 1000).toISOString()}`);
    record = await sendClaimMail(p, record);
    await send(ctx, () => deps.sendTransferMail(account, facts, { kind: 'started', to: 'owner', record, setting, now }));
  }

  async function sendClaimMail (p: AccountPass, record: TransferRecord): Promise<TransferRecord> {
    const now = deps.now();
    const outcome = await send(p.ctx, () => deps.sendTransferMail(p.account, p.facts, { kind: 'claim', to: 'beneficiary', record, setting: p.setting, now }));
    if (outcome !== 'sent') return record;
    const next = { ...record, claimMailsSent: [...(record.claimMailsSent ?? []), now] };
    await state.saveTransfer(p.account.id, next);
    return next;
  }

  /** A claim window is open (or claimed, invite out). */
  async function runWindow (p: AccountPass, record: TransferRecord): Promise<void> {
    const { account, ctx, facts } = p;
    if (ctx.config.dryRun) {
      logger.info(`auto-deletion sweep (dry run): account "${account.username}" (${account.id}) has a transfer claim window open; left as it is`);
      return;
    }
    const flow = flowDeps(ctx);
    const now = deps.now();
    if (record.status === 'claimed' && record.claimedBy != null) {
      if (await deps.delegationOf(account, record.claimedBy) === 'active') {
        await completeTransfer(flow, account, facts, record);
        ctx.result.transfersCompleted++;
        logger.warn(`auto-deletion: transfer of account "${account.username}" (${account.id}) completed: "${record.claimedBy.username}" controls it`);
        return;
      }
    }
    if (windowEnded(record, now)) {
      await endWindow(p, record);
      return;
    }
    // Used before anyone claimed it: the transfer is moot, the clock restarts.
    const used = facts.activity.at != null && record.openedAt != null && facts.activity.at > record.openedAt;
    if (record.status === 'open' && p.policy.mode === 'inactivity' && used) {
      const reason = facts.activity.by === 'delegate' ? 'delegate-activity' : 'owner-activity';
      await cancelTransfer(flow, account, facts, record, { reason, mailOwner: true, keepIdentity: true });
      await p.save(p.evaluation.bookkeeping);
      ctx.result.transfersCancelled++;
      logger.info(`auto-deletion sweep: transfer of account "${account.username}" (${account.id}) cancelled: the account was used (${reason})`);
      return;
    }
    let current = record;
    if (current.lockedAt != null || (current.failedAttempts ?? 0) > 0) {
      const { lockedAt: _l, failedAttempts: _f, ...rest } = current;
      current = rest;
      await state.saveTransfer(account.id, current);
    }
    if (claimMailDue(current, now) != null) await sendClaimMail(p, current);
  }

  /** The claim window is over: the owner's fallback. */
  async function endWindow (p: AccountPass, record: TransferRecord): Promise<void> {
    const { account, ctx, facts, setting } = p;
    const flow = flowDeps(ctx);
    if (record.status === 'claimed' && record.claimedBy != null) {
      try {
        await deps.withdrawInvite(account, record.claimedBy);
      } catch (err) {
        logger.warn(`auto-deletion sweep: the pending invite of account "${account.username}" (${account.id}) to "${record.claimedBy.username}" was not withdrawn: ${errorText(err)}`);
      }
    }
    if (setting?.transfer?.fallback !== 'delete') {
      await lapseTransfer(flow, account, facts, record);
      ctx.result.transfersLapsed++;
      logger.warn(`auto-deletion: transfer of account "${account.username}" (${account.id}) lapsed without a claim: the account is kept`);
      return;
    }
    // Fallback `delete`: as a direct deletion (cap, self-deletion, guards).
    if (ctx.config.maxDeletionsPerPass > 0 && ctx.erasuresStarted >= ctx.config.maxDeletionsPerPass) {
      ctx.result.deferred++;
      return;
    }
    const b = p.evaluation.bookkeeping ?? p.prev;
    if (b == null) throw new Error('a transfer window without a schedule');
    const objection = await erasureObjection(p);
    if (objection != null) {
      await hold(p, b, objection);
      return;
    }
    ctx.erasuresStarted++;
    const cleared = withoutBlocked(b);
    await p.save(cleared);
    await state.saveTransfer(account.id, { ...record, status: 'fallback-delete', closedAt: deps.now() });
    await erase(account, cleared, ctx, 'transfer-fallback');
  }

  async function erase (account: SweepAccount, b: Bookkeeping, ctx: PassContext, triggerOverride?: Trigger): Promise<void> {
    const trigger: Trigger = triggerOverride ?? (b.appliedPolicy.mode === 'date' ? 'date' : 'inactivity');
    const sent = b.reminders.sent.filter((s) => s.skipped !== true).map((s) => s.at);
    const notices = b.firstNoticeAt != null && !sent.includes(b.firstNoticeAt) ? [b.firstNoticeAt, ...sent] : sent;
    const record: ErasureRecord = {
      username: account.username,
      userId: account.id,
      trigger,
      source: b.appliedPolicy.source,
      deadline: b.deadline,
      deleteAt: b.deleteAt ?? b.deadline,
      notices
    };
    logger.warn(`auto-deletion: erasing account "${account.username}" (${account.id}), trigger ${trigger}`, record);
    if (deps.recordErasure != null) {
      try {
        await deps.recordErasure(account, record);
      } catch (err) {
        logger.error(`auto-deletion: the erasure record of account "${account.username}" (${account.id}) was not written: ${errorText(err)}`);
      }
    }
    try {
      await deps.erase(account, { trigger });
    } catch (err) {
      ctx.result.failed++;
      logger.error(`auto-deletion: the erasure of account "${account.username}" (${account.id}) failed, completed on a later pass: ${errorText(err)}`);
      return;
    }
    ctx.result.erased++;
    logger.warn(`auto-deletion: account "${account.username}" (${account.id}) erased, trigger ${trigger}`, record);
  }

  return { runPass, isRunning: () => running };
}

export type AutoDeletionSweep = ReturnType<typeof createAutoDeletionSweep>;
