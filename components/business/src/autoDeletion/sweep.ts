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
 * Per account:
 *  - nothing applies (no setting, no preset, no bookkeeping): skipped, nothing
 *    read beyond the setting and the bookkeeping, nothing written;
 *  - a reminder is due: the bookkeeping is saved first, then the mail is sent,
 *    then the notice is recorded. A crash between the send and the record
 *    sends that reminder again; none is ever skipped. A send that keeps
 *    failing is logged once per account and lead;
 *  - the account is due: its activity is read again (a sign-in since the
 *    evaluation wins), the deletion guards are asked (a refusal is recorded as
 *    `blocked`, mailed to the holder once, and asked again on every later
 *    pass, silently), a `deleting` marker is written, then the account is
 *    erased between two WARN log lines. A marker found on a later pass (a
 *    crash, a failed step) runs the erasure again to its end.
 *
 * `transfer` policies are left alone: their action is not deletion. A pass
 * still running when the next one is asked for makes that one a no-op.
 * `maxDeletionsPerPass` caps the erasures a pass starts (0: no cap); the rest
 * wait for the next pass. `dryRun` logs what would be sent and erased, sends,
 * erases and writes nothing (a written bookkeeping would start the clocks the
 * real sweep reads later).
 */

import type { AutoDeletionConfig } from './config.ts';
import type { Setting, Bookkeeping } from './state.ts';
import type { AccountActivity } from '../accesses/accountActivity.ts';
import { effectivePolicy, evaluate, withNotice } from './deadline.ts';
import type { Policy, Evaluation } from './deadline.ts';

export type SweepAccount = { id: string; username: string };

/** What the sweep needs to know about an account (callers may pass more). */
export type SweepFacts = {
  activity: AccountActivity;
  /** The account has an email address and the core can send mail. */
  notifiable: boolean;
  /** An operator preset covers this account. */
  presetApplies: boolean;
};

export type Notice = {
  policy: Policy;
  bookkeeping: Bookkeeping;
  /** The reminder's lead in days (reminders only). */
  leadDays?: number;
  now: number;
};

/** `off`: this mail is switched off by the operator (not a failure). */
export type SendOutcome = 'sent' | 'off' | 'failed';

export type Objection = { reason: string; message: string };

export type Trigger = 'date' | 'inactivity';

export type ErasureRecord = {
  username: string;
  userId: string;
  trigger: Trigger;
  source: 'user' | 'operator';
  deadline: number | null;
  deleteAt: number | null;
  /** Send times of the notices (the confirmation, when it was the first, and the reminders). */
  notices: number[];
  /** A `deleting` marker of an earlier pass is being completed. */
  resumed: boolean;
};

type Logger = {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
};

export type SweepState = {
  getSetting (userId: string): Promise<Setting | null>;
  getBookkeeping (userId: string): Promise<Bookkeeping | null>;
  saveBookkeeping (userId: string, prev: Bookkeeping | null, next: Bookkeeping | null): Promise<boolean>;
};

export type SweepDeps<F extends SweepFacts = SweepFacts> = {
  /** Read at every pass: a config change applies from the next one. */
  getConfig: () => AutoDeletionConfig;
  listAccounts: () => Promise<SweepAccount[]>;
  state: SweepState;
  loadFacts: (account: SweepAccount) => Promise<F>;
  /** Activity only, read again right before an erasure. */
  readActivity: (account: SweepAccount) => Promise<AccountActivity>;
  sendReminder: (account: SweepAccount, facts: F, notice: Notice) => Promise<SendOutcome>;
  sendBlocked: (account: SweepAccount, facts: F, notice: Notice) => Promise<SendOutcome>;
  /** The deletion guards' objection, or null. Throws when the erasure cannot be attempted (an operator problem). */
  checkErasable: (account: SweepAccount) => Promise<Objection | null>;
  erase: (account: SweepAccount, options: { trigger: Trigger }) => Promise<void>;
  /** Durable record of the erasure (an audit row that outlives the account), written before it starts. */
  recordErasure?: (account: SweepAccount, record: ErasureRecord) => Promise<void>;
  /** Pryv seconds. */
  now: () => number;
  logger: Logger;
};

export type PassResult = {
  /** A pass was already running: this one did nothing. */
  skipped: boolean;
  dryRun: boolean;
  /** Accounts a policy or a bookkeeping row applies to. */
  accounts: number;
  reminders: number;
  reminderFailures: number;
  remindersOff: number;
  erased: number;
  blocked: number;
  /** Due accounts left for the next pass by `maxDeletionsPerPass`. */
  deferred: number;
  /** Accounts whose pass threw (logged), and erasures that failed. */
  failed: number;
  wouldRemind: number;
  wouldErase: number;
};

function emptyResult (dryRun: boolean, skipped = false): PassResult {
  return { skipped, dryRun, accounts: 0, reminders: 0, reminderFailures: 0, remindersOff: 0, erased: 0, blocked: 0, deferred: 0, failed: 0, wouldRemind: 0, wouldErase: 0 };
}

function errorText (err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withoutBlocked (b: Bookkeeping): Bookkeeping {
  const { blocked: _blocked, ...rest } = b;
  return rest as Bookkeeping;
}

const isGuardBlock = (blocked: Bookkeeping['blocked'] | undefined): boolean => blocked != null && blocked.reason !== 'no-email';

export function createAutoDeletionSweep<F extends SweepFacts> (deps: SweepDeps<F>) {
  const { state, logger } = deps;
  let running = false;
  // Log-once memories, per process: a send that keeps failing and a transfer
  // policy are reported once, not at every pass.
  const failedReminders = new Set<string>();
  const transfersSeen = new Set<string>();

  type PassContext = { config: AutoDeletionConfig; result: PassResult; erasuresStarted: number };

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
    const ctx: PassContext = { config, result: emptyResult(config.dryRun), erasuresStarted: 0 };
    if (!config.enabled) return ctx.result;
    for (const account of await deps.listAccounts()) {
      try {
        await processAccount(account, ctx);
      } catch (err) {
        ctx.result.failed++;
        logger.error(`auto-deletion sweep: account "${account.username}" (${account.id}) not processed, retried on the next pass: ${errorText(err)}`);
      }
    }
    const r = ctx.result;
    if (r.dryRun && (r.wouldRemind > 0 || r.wouldErase > 0)) {
      logger.info(`auto-deletion sweep (dry run): ${r.wouldRemind} reminder(s) and ${r.wouldErase} erasure(s) would have been done; nothing was sent, erased or written`);
    }
    if (r.reminders > 0 || r.erased > 0 || r.blocked > 0 || r.deferred > 0 || r.failed > 0 || r.reminderFailures > 0) {
      logger.info(`auto-deletion sweep: ${r.accounts} account(s) with a schedule, ${r.reminders} reminder(s) sent, ${r.reminderFailures} not sent, ${r.erased} account(s) erased, ${r.blocked} newly blocked, ${r.deferred} left for the next pass (maxDeletionsPerPass), ${r.failed} failure(s)`);
    }
    if (r.remindersOff > 0) {
      logger.info(`auto-deletion sweep: ${r.remindersOff} reminder(s) due but services.email.enabled.accountDeletionReminder is false: without a first notice, those accounts are not deleted`);
    }
    return r;
  }

  async function processAccount (account: SweepAccount, ctx: PassContext): Promise<void> {
    const { config, result } = ctx;
    const setting = await state.getSetting(account.id);
    const prev = await state.getBookkeeping(account.id);
    if (prev?.deleting != null) {
      result.accounts++;
      await resumeErasure(account, prev, ctx);
      return;
    }
    // Nothing applies and nothing to clean up: the common case, never written.
    const nothingSet = setting == null ? config.inactivity.defaultDays == null : setting.mode === 'never';
    if (prev == null && nothingSet) return;

    const facts = await deps.loadFacts(account);
    const policy = effectivePolicy(setting, config, facts.presetApplies);
    if (policy?.action === 'transfer') {
      if (!transfersSeen.has(account.id)) {
        transfersSeen.add(account.id);
        logger.info(`auto-deletion sweep: account "${account.username}" (${account.id}) is set to be transferred, not deleted: left to the transfer process`);
      }
      return;
    }
    if (policy != null && policy.mode !== 'never') result.accounts++;

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
      acknowledgedNoReminders: setting?.acknowledgedNoReminders === true
    });
    let evaluation = judge(facts.activity);
    let b = evaluation.bookkeeping;
    let stored = prev;
    const save = async (next: Bookkeeping | null): Promise<void> => {
      if (config.dryRun) return;
      await state.saveBookkeeping(account.id, stored, next);
      stored = next;
    };

    if (evaluation.reminder != null && b != null && policy != null) {
      const leadDays = evaluation.reminder;
      if (config.dryRun) {
        result.wouldRemind++;
        logger.info(`auto-deletion sweep (dry run): would send the ${leadDays}-day reminder to account "${account.username}" (${account.id})`);
      } else {
        await save(b); // intent first: a crash after the send repeats it, never skips it
        const now = deps.now();
        const outcome = await deps.sendReminder(account, facts, { policy, bookkeeping: b, leadDays, now });
        const key = `${account.id}:${b.reminders.deadlineDay}:${leadDays}`;
        if (outcome === 'sent') {
          failedReminders.delete(key);
          b = withNotice(b, now, leadDays);
          await save(b);
          result.reminders++;
        } else if (outcome === 'off') {
          result.remindersOff++;
        } else {
          result.reminderFailures++;
          if (!failedReminders.has(key)) {
            failedReminders.add(key);
            logger.warn(`auto-deletion sweep: the ${leadDays}-day reminder to account "${account.username}" (${account.id}) could not be sent; retried at every pass, not logged again`);
          }
        }
      }
    }

    if (!evaluation.due || b == null || policy == null) {
      await save(b);
      return;
    }

    // Due.
    if (config.maxDeletionsPerPass > 0 && ctx.erasuresStarted >= config.maxDeletionsPerPass) {
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
        logger.info(`auto-deletion sweep: account "${account.username}" (${account.id}) was used while being checked: not erased`);
        await save(b);
        return;
      }
    }

    const objection = await deps.checkErasable(account);
    if (objection != null) {
      if (config.dryRun) {
        logger.info(`auto-deletion sweep (dry run): account "${account.username}" (${account.id}) is due, its deletion would be refused: ${objection.message}`);
        return;
      }
      let blocked = guardBlock != null && guardBlock.reason === objection.reason ? guardBlock : null;
      if (blocked == null) {
        blocked = { reason: objection.reason, at: deps.now() };
        result.blocked++;
        logger.warn(`auto-deletion sweep: account "${account.username}" (${account.id}) is due but its deletion is refused (${objection.message}); asked again at every pass`);
      }
      b = { ...b, blocked };
      if (blocked.notifiedAt == null && facts.notifiable) {
        const now = deps.now();
        if (await deps.sendBlocked(account, facts, { policy, bookkeeping: b, now }) === 'sent') {
          b = { ...b, blocked: { ...blocked, notifiedAt: now } };
        }
      }
      await save(b);
      return;
    }

    if (config.dryRun) {
      result.wouldErase++;
      logger.info(`auto-deletion sweep (dry run): would erase account "${account.username}" (${account.id}), trigger ${policy.mode}`);
      return;
    }
    ctx.erasuresStarted++;
    b = { ...withoutBlocked(b), deleting: { startedAt: deps.now() } };
    await save(b);
    await erase(account, b, ctx, false);
  }

  async function resumeErasure (account: SweepAccount, prev: Bookkeeping, ctx: PassContext): Promise<void> {
    const { config, result } = ctx;
    if (config.dryRun) {
      result.wouldErase++;
      logger.info(`auto-deletion sweep (dry run): would complete the erasure of account "${account.username}" (${account.id}) started at ${prev.deleting!.startedAt}`);
      return;
    }
    if (config.maxDeletionsPerPass > 0 && ctx.erasuresStarted >= config.maxDeletionsPerPass) {
      result.deferred++;
      return;
    }
    ctx.erasuresStarted++;
    await erase(account, prev, ctx, true);
  }

  async function erase (account: SweepAccount, b: Bookkeeping, ctx: PassContext, resumed: boolean): Promise<void> {
    const trigger: Trigger = b.appliedPolicy.mode === 'date' ? 'date' : 'inactivity';
    const sent = b.reminders.sent.filter((s) => s.skipped !== true).map((s) => s.at);
    const notices = b.firstNoticeAt != null && !sent.includes(b.firstNoticeAt) ? [b.firstNoticeAt, ...sent] : sent;
    const record: ErasureRecord = {
      username: account.username,
      userId: account.id,
      trigger,
      source: b.appliedPolicy.source,
      deadline: b.deadline,
      deleteAt: b.deleteAt ?? b.deadline,
      notices,
      resumed
    };
    logger.warn(`auto-deletion: erasing account "${account.username}" (${account.id}), trigger ${trigger}${resumed ? ', completing an earlier attempt' : ''}`, record);
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
      logger.error(`auto-deletion: the erasure of account "${account.username}" (${account.id}) failed, completed on the next pass: ${errorText(err)}`);
      return;
    }
    ctx.result.erased++;
    logger.warn(`auto-deletion: account "${account.username}" (${account.id}) erased, trigger ${trigger}`, record);
  }

  return { runPass, isRunning: () => running };
}

export type AutoDeletionSweep = ReturnType<typeof createAutoDeletionSweep>;
