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
import { getStorageLayer } from 'storage';
import { getUsersRepository } from 'business/src/users/index.ts';
import { runDeletionGuards } from 'business/src/auth/deletionTeardown.ts';
import { getActivity } from 'business/src/accesses/accountActivity.ts';
import type { ActivityAccessesRepo } from 'business/src/accesses/accountActivity.ts';
import { createAutoDeletionSweep } from 'business/src/autoDeletion/sweep.ts';
import type { SweepDeps, AutoDeletionSweep, Notice, SweepAccount, ErasureRecord } from 'business/src/autoDeletion/sweep.ts';
import { getState, loadAccountFacts, confirmationSubstitutions, sendAutoDeletionMail } from './autoDeletion.ts';
import type { AccountFacts } from './autoDeletion.ts';
import { autoDeletionConfig } from './autoDeletionPolicy.ts';
import { Deletion } from 'business/src/auth/deletion.ts';
import { defaultIsLoopWorker } from 'cmc/src/bootRetryLoop.ts';

/**
 * The auto-deletion sweep of this core, wired to storage, mail, the deletion
 * guards and the erasure `auth.delete` runs. It runs in the API worker the
 * master designates for the core's background loops (the full stack is
 * there: mall, audit, series), after a boot delay, then every
 * `account.autoDeletion.sweepIntervalMs`.
 */

const FIRST_PASS_DELAY_MS = 10 * 60 * 1000;
export const ERASURE_AUDIT_ACTION = 'account.autoDeletion.erase';

/** The API worker that runs this core's background loops (the CMC loop's). */
export function isDesignatedLoopWorker (env: Record<string, string | undefined> = process.env): boolean {
  return defaultIsLoopWorker(env) as boolean;
}

function reminderSubstitutions (config: ConfigLike, user: SweepAccount, notice: Notice, lang: string): Record<string, string> {
  const schedule = { policy: notice.policy, evaluation: { bookkeeping: notice.bookkeeping, reminder: notice.leadDays ?? null, due: false } };
  return {
    ...confirmationSubstitutions(config, user, schedule, lang, notice.now),
    POLICY_OPERATOR: notice.policy.source === 'operator' ? 'true' : ''
  };
}

/**
 * Audit row of an erasure in the account's own trail, written before the
 * erasure starts. Only where the trail outlives the account
 * (`audit.onUserDelete: keep`); otherwise it would go with the account and
 * the WARN log lines are the record.
 */
async function auditErasure (config: ConfigLike, account: SweepAccount, record: ErasureRecord): Promise<void> {
  if (config.get('audit:active') !== true || config.get('audit:onUserDelete') !== 'keep') return;
  const auditSingleton = (await import('audit')).default;
  const C = auditSingleton.CONSTANTS;
  const now = timestamp.now();
  await auditSingleton.eventForUser(account.id, {
    id: cuid(),
    createdBy: 'system',
    modifiedBy: 'system',
    streamIds: [C.ACTION_STREAM_ID_PREFIX + ERASURE_AUDIT_ACTION],
    time: now,
    endTime: now,
    created: now,
    modified: now,
    trashed: false,
    type: 'audit-log/account-auto-deletion',
    content: { action: ERASURE_AUDIT_ACTION, source: { name: 'system' }, record }
  }, ERASURE_AUDIT_ACTION);
}

/** The sweep with its real dependencies; tests replace some (clock, mailer, list of accounts). */
export async function createAccountAutoDeletionSweep (config: ConfigLike, overrides: Partial<SweepDeps<AccountFacts>> = {}): Promise<AutoDeletionSweep> {
  const logger = getLogger('account-auto-deletion');
  const storageLayer = await getStorageLayer();
  const state = await getState();
  const deletion = new Deletion(null, storageLayer, config);
  return createAutoDeletionSweep<AccountFacts>({
    getConfig: () => autoDeletionConfig(config),
    listAccounts: async () => await (await getUsersRepository()).getAllUsersIdAndName() as SweepAccount[],
    state,
    loadFacts: (account) => loadAccountFacts(config, account),
    readActivity: (account) => getActivity(storageLayer.accesses as unknown as ActivityAccessesRepo, account),
    sendReminder: (account, facts, notice) => sendAutoDeletionMail(config, 'reminder', account, facts,
      (lang) => reminderSubstitutions(config, account, notice, lang)),
    sendBlocked: (account, facts, notice) => sendAutoDeletionMail(config, 'blocked', account, facts,
      (lang) => reminderSubstitutions(config, account, notice, lang)),
    checkErasable: async (account) => {
      // The checks auth.delete runs before erasing. An inaccessible user
      // directory is the operator's to fix: it throws (logged, retried).
      const context = { user: { id: account.id, username: account.username } };
      await new Promise<void>((resolve, reject) => {
        deletion.validateUserFilepaths(context, {}, {}, (err?: unknown) => (err != null ? reject(err) : resolve()));
      });
      const objections = await runDeletionGuards(account, logger);
      if (objections.length === 0) return null;
      return { reason: 'deletion-guard', message: objections.map((o) => o.message).join('; ') };
    },
    erase: (account, { trigger }) => deletion.eraseAccount(account, { teardown: true, trigger }),
    recordErasure: (account, record) => auditErasure(config, account, record),
    now: () => timestamp.now(),
    logger,
    ...overrides
  });
}

/**
 * Start the sweep: first pass after a boot delay, then one pass every
 * `sweepIntervalMs` after the previous one ended (passes never overlap).
 * Null when the feature is off (`account.autoDeletion.enabled: false`).
 */
export async function startAccountAutoDeletionSweep (config: ConfigLike, options: { firstPassDelayMs?: number } = {}): Promise<{ stop: () => void; sweep: AutoDeletionSweep } | null> {
  const logger = getLogger('account-auto-deletion');
  const adConfig = autoDeletionConfig(config);
  if (!adConfig.enabled) {
    logger.info('account auto-deletion is off (account.autoDeletion.enabled: false): the sweep is not started');
    return null;
  }
  const sweep = await createAccountAutoDeletionSweep(config);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      sweep.runPass()
        .catch((err: unknown) => logger.error('account auto-deletion sweep failed: ' + (err instanceof Error ? err.message : String(err))))
        .finally(() => schedule(adConfig.sweepIntervalMs));
    }, delayMs);
    timer.unref();
  };
  schedule(options.firstPassDelayMs ?? FIRST_PASS_DELAY_MS);
  logger.info(`account auto-deletion sweep started: every ${adConfig.sweepIntervalMs} ms${adConfig.dryRun ? ', dry run (nothing is sent, erased or written)' : ''}`);
  return {
    sweep,
    stop: () => {
      stopped = true;
      if (timer != null) clearTimeout(timer);
    }
  };
}
