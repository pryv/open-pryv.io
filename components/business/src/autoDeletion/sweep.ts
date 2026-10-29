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

/**
 * `off`: this mail is switched off by the operator (not a failure).
 * `rejected`: the mail server refused this recipient (this account only).
 * `failed`: the mail could not be handed over (the transport is down).
 */
export type SendOutcome = 'sent' | 'off' | 'rejected' | 'failed';

export type Objection = { reason: string; message: string };

export type Trigger = 'date' | 'inactivity';

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
  /** The erasures in progress on this core. */
  listPendingErasures: () => Promise<PendingErasure[]>;
  state: SweepState;
  loadFacts: (account: SweepAccount) => Promise<F>;
  /** Activity only, read again right before an erasure. */
  readActivity: (account: SweepAccount) => Promise<AccountActivity>;
  sendReminder: (account: SweepAccount, facts: F, notice: Notice) => Promise<SendOutcome>;
  sendBlocked: (account: SweepAccount, facts: F, notice: Notice) => Promise<SendOutcome>;
  /** The deletion guards' objection, or null. Throws when the erasure cannot be attempted (an operator problem). */
  checkErasable: (account: SweepAccount) => Promise<Objection | null>;
  /** Erases the account, or completes its unfinished erasure. */
  erase: (account: SweepAccount, options: { trigger?: Trigger }) => Promise<void>;
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
};

/** An erasure record untouched for this long is no longer running: it is completed. */
export const STALE_ERASURE_MS = 15 * 60 * 1000;

function emptyResult (dryRun: boolean, skipped = false): PassResult {
  return { skipped, dryRun, accounts: 0, reminders: 0, reminderFailures: 0, remindersOff: 0, mailHeld: 0, erased: 0, completed: 0, blocked: 0, deferred: 0, failed: 0, wouldRemind: 0, wouldErase: 0 };
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

const isGuardBlock = (blocked: Bookkeeping['blocked'] | undefined): boolean => blocked != null && blocked.reason !== 'no-email';

export function createAutoDeletionSweep<F extends SweepFacts> (deps: SweepDeps<F>) {
  const { state, logger } = deps;
  let running = false;
  // Log-once memories, per process: a recipient refused at every pass and a
  // transfer policy are reported once, not at every pass.
  const refusedReminders = new Set<string>();
  const transfersSeen = new Set<string>();

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
    if (r.dryRun && (r.wouldRemind > 0 || r.wouldErase > 0)) {
      logger.info(`auto-deletion sweep (dry run): ${r.wouldRemind} reminder(s) and ${r.wouldErase} erasure(s) would have been done; nothing was sent, erased or written`);
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
      } else if (ctx.mailDown) {
        result.mailHeld++;
      } else {
        await save(b); // intent first: a crash after the send repeats it, never skips it
        const now = deps.now();
        const notice = { policy, bookkeeping: b, leadDays, now };
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
        const notice = { policy, bookkeeping: b, now };
        if (await send(ctx, () => deps.sendBlocked(account, facts, notice)) === 'sent') {
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
    b = withoutBlocked(b);
    await save(b);
    await erase(account, b, ctx);
  }

  async function erase (account: SweepAccount, b: Bookkeeping, ctx: PassContext): Promise<void> {
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
