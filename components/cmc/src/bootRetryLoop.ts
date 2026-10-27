/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — retry-loop bootstrap helper.
 *
 * Wires `RetryScheduler` onto the api-server worker, gated on:
 *   1. config `cmc.retryLoop.enabled` (default false).
 *   2. cluster.worker?.id === 1 — only ONE worker runs the loop so we
 *      don't dispatch the same retry from N workers in parallel. In
 *      non-cluster mode (no worker id), starts unconditionally.
 *
 * Operator must supply a `userIdsProvider` callback that yields the
 * userIds to scan each tick. Deliberately not derived from the platform
 * — deployments scope this differently (shard-aware, recent-activity-
 * only, etc.). If absent, the loop is not started even when enabled.
 *
 * Returns the `RetryScheduler` instance (or null when disabled) so
 * tests + operators can introspect / stop it.
 */

const { RetryScheduler } = require('./retryScheduler.ts');
const { dispatch } = require('./dispatch.ts');
const retryQueue: typeof import('./retryQueue.ts') = require('./retryQueue.ts');

// Mall handle — pure pass-through to dispatch/retryScheduler (untyped
// requires); never inspected here.
import type { MallLike } from './_types.ts';
import type { MemberSweep } from './memberSweep.ts';
import type { DeletionOutbox } from './retryQueue.ts';
import * as C from './constants.ts';
type Identity = { username?: string; host?: string; apiEndpoint?: string; [k: string]: unknown };
type BootDeps = {
  config: { get: (key: string) => unknown };
  mall: MallLike;
  selfIdentityFor: (userId: string) => Identity;
  fetch: (url: string, init?: Record<string, unknown>) => Promise<Response>;
  logger?: CmcLogger;
  userIdsProvider?: () => Promise<string[]> | string[];
  // Optional: a cluster worker id check. Defaults to checking the
  // node:cluster module if available.
  isLoopWorker?: () => boolean;
  // Account delegation, forwarded to the dispatch (see handleAccept.ts): a
  // retried accept given through a delegation must still find its lineage
  // and its relationship.
  lineageOf?: (access: unknown) => { kind?: unknown; relId?: unknown; delegate?: unknown; viaAccessId?: unknown } | null;
  relationshipExists?: (userId: string, relId: string) => Promise<boolean> | boolean;
  // Group accounts (memberSweep.ts): forwarded to the dispatch (a retried
  // revoke sweeps), and its periodic ledger pass runs on its own scheduler
  // beside the retry loop (`cmc:memberAccess:sweepIntervalMs`), once at boot
  // then on the interval, on the same designated worker.
  memberSweep?: MemberSweep;
  // The core's outbox of revoke notices from deleted accounts (host-resolved,
  // storage-agnostic here): drained by a pass of its own on the same worker,
  // at the retry-loop interval, once at boot (a row queued before a restart
  // goes out as soon as it is due).
  deletionOutbox?: () => Promise<DeletionOutbox>;
};

/**
 * Which process runs the loop. The master names it (`PRYV_CMC_LOOP_WORKER`
 * `'1'` on the API worker it designates, `'0'` on the others; the
 * replacement of a dead designated worker gets `'1'`, like the webhooks
 * service), so a worker crash never stops the loop for good. Without the
 * variable (an older master, a test harness): cluster worker id 1, or a
 * standalone process.
 */
function defaultIsLoopWorker (env: Record<string, string | undefined> = process.env): boolean {
  const named = env.PRYV_CMC_LOOP_WORKER;
  if (named === '1') return true;
  if (named === '0') return false;
  try {
    const cluster = require('node:cluster');
    // Worker mode → only worker id 1 runs the loop.
    if (cluster.isWorker) {
      return cluster.worker?.id === 1;
    }
    // Standalone / primary process: always run.
    return true;
  } catch (_e) {
    return true;
  }
}

/**
 * Start the retry-loop scheduler if config allows it + we're the
 * designated worker. Returns the scheduler instance or null.
 *
 * The caller is responsible for `await scheduler.stop()` on shutdown
 * if it wants a graceful drain.
 */
function startRetryLoopIfEnabled (deps: BootDeps): unknown {
  const enabled = deps.config.get('cmc:retryLoop:enabled');
  if (enabled !== true) {
    // Worth the operator's eye: a consent revoke that could not reach its
    // counterparty is not retried, a member offboarding that left residuals
    // on a patient core is not re-swept, memberships that expired or vanished
    // are not swept (their children expire on their own, within maxTtl).
    deps.logger?.warn?.('cmc/bootRetryLoop: cmc.retryLoop.enabled is false: undeliverable revoke notices are not retried (the notices of a deleted account included), residual member accesses are not re-swept, expired memberships are not swept');
    return null;
  }
  if (deps.userIdsProvider == null) {
    deps.logger?.warn?.('cmc/bootRetryLoop: enabled but no userIdsProvider supplied — loop not started');
    return null;
  }
  // Queueing on, scheduler off: the in-process test core (its suites drive
  // the loop by hand) and an operator who runs the loop elsewhere.
  if (deps.config.get('cmc:retryLoop:startScheduler') === false) {
    deps.logger?.info?.('cmc/bootRetryLoop: cmc.retryLoop.startScheduler is false: records are queued, the loop is not started here');
    return null;
  }
  const isLoopWorker = (deps.isLoopWorker ?? defaultIsLoopWorker)();
  if (!isLoopWorker) {
    deps.logger?.debug?.('cmc/bootRetryLoop: not the designated worker — skipping');
    return null;
  }

  const intervalMs = deps.config.get('cmc:retryLoop:intervalMs') || 60_000;
  const perUserLimit = deps.config.get('cmc:retryLoop:perUserLimit') || 100;
  // Each pass backs off from the accounts it found idle: a pass that saw no
  // pending retry record (the retry loop) or no live or residual ledger
  // record (the ledger pass) marks the account idle for IDLE_RECHECK_MS and
  // skips it until then. Every account has the hidden streams, so presence
  // tells nothing; idleness does. A record queued meanwhile waits at most
  // that long for its first loop attempt (its schedule runs in hours).
  const retryIdle = idleBackoff(deps.userIdsProvider);
  const ledgerIdle = idleBackoff(deps.userIdsProvider);

  const retryDeps = {
    mall: deps.mall,
    dispatch,
    dispatchDeps: {
      mall: deps.mall,
      fetch: deps.fetch,
      logger: deps.logger,
      selfIdentityFor: deps.selfIdentityFor,
      lineageOf: deps.lineageOf,
      relationshipExists: deps.relationshipExists,
      memberSweep: deps.memberSweep,
      // The retry loop OWNS the retry lifecycle: processRetryEvent
      // reschedules (or retires) the very event it is re-dispatching. The
      // dispatch it calls must therefore NOT also auto-enqueue a fresh retry
      // on failure — that would leave a still-failing item both rescheduled
      // AND re-queued as a duplicate, and each duplicate spawns its own, so
      // one stuck delivery fans the retries stream out geometrically.
      enqueueRetries: false,
    },
    logger: deps.logger,
  };

  const scheduler = new RetryScheduler({
    retryDeps,
    userIdsProvider: retryIdle.provider,
    perUserLimit,
    logger: deps.logger,
    runRetryLoop: async (params: { userId: string; deps: unknown; limit?: number }) => {
      const summary = await retryQueue.runRetryLoop(params as Parameters<typeof retryQueue.runRetryLoop>[0]);
      retryIdle.note(params.userId, summary.pendingTotal === 0);
      return summary;
    },
  });
  scheduler.start(intervalMs);
  deps.logger?.info?.('cmc/bootRetryLoop: started', { intervalMs, perUserLimit });

  // The member ledger pass: expired memberships swept, settled records
  // pruned. Its own scheduler (its own interval), eager first run.
  if (deps.memberSweep != null) {
    const sweep = deps.memberSweep;
    const sweepIntervalMs = (deps.config.get('cmc:memberAccess:sweepIntervalMs') as number) || C.MEMBER_ACCESS_CONFIG_DEFAULTS.sweepIntervalMs;
    const ledgerScheduler = new RetryScheduler({
      retryDeps,
      userIdsProvider: ledgerIdle.provider,
      logger: deps.logger,
      runRetryLoop: async ({ userId }: { userId: string }) => {
        const r = await sweep.runLedgerPass(userId);
        ledgerIdle.note(userId, r.records === 0);
        return { processed: r.swept + r.expired + r.residuals + r.pruned, succeeded: r.swept + r.residuals, rescheduled: 0, failedPermanent: 0, skipped: 0, pendingTotal: r.records };
      },
    });
    ledgerScheduler.start(sweepIntervalMs);
    ledgerScheduler.tick().catch((err: unknown) => {
      deps.logger?.warn?.('cmc/bootRetryLoop: the first member ledger pass failed', { error: String((err as Error)?.message || err) });
    });
    (scheduler as { ledgerScheduler?: unknown }).ledgerScheduler = ledgerScheduler;
    deps.logger?.info?.('cmc/bootRetryLoop: member ledger pass started', { sweepIntervalMs });
  }
  // The deletion outbox pass: not per user (the accounts are gone), so its
  // scheduler visits one sentinel id and the pass reads the outbox itself.
  if (deps.deletionOutbox != null) {
    const getOutbox = deps.deletionOutbox;
    const outboxScheduler = new RetryScheduler({
      retryDeps,
      userIdsProvider: () => ['deletion-outbox'],
      logger: deps.logger,
      runRetryLoop: async () => {
        const r = await retryQueue.runDeletionOutboxPass({ outbox: await getOutbox(), deps: retryDeps, limit: perUserLimit as number });
        return { processed: r.processed, succeeded: r.succeeded + r.settled, rescheduled: r.rescheduled, failedPermanent: r.failedPermanent, skipped: 0, pendingTotal: r.pendingTotal };
      },
    });
    outboxScheduler.start(intervalMs);
    outboxScheduler.tick().catch((err: unknown) => {
      deps.logger?.warn?.('cmc/bootRetryLoop: the first deletion outbox pass failed', { error: String((err as Error)?.message || err) });
    });
    (scheduler as { outboxScheduler?: unknown }).outboxScheduler = outboxScheduler;
    deps.logger?.info?.('cmc/bootRetryLoop: deletion outbox pass started', { intervalMs });
  }
  // One handle to stop them all at shutdown (the in-flight tick is awaited).
  (scheduler as { stopAll?: () => Promise<void> }).stopAll = async () => {
    await scheduler.stop();
    const others = scheduler as { ledgerScheduler?: { stop: () => Promise<void> }; outboxScheduler?: { stop: () => Promise<void> } };
    if (others.ledgerScheduler != null) await others.ledgerScheduler.stop();
    if (others.outboxScheduler != null) await others.outboxScheduler.stop();
  };
  return scheduler;
}

const IDLE_RECHECK_MS = 10 * 60 * 1000;

/**
 * An idle back-off over a user list: `provider()` leaves out the accounts
 * noted idle less than IDLE_RECHECK_MS ago; `note(userId, idle)` is called
 * by the pass with what it found (an active account is visited again on the
 * next tick). Accounts gone from the list leave the map.
 */
function idleBackoff (provider: () => Promise<string[]> | string[], now: () => number = Date.now): { provider: () => Promise<string[]>; note: (userId: string, idle: boolean) => void } {
  const idleSince = new Map<string, number>();
  return {
    provider: async () => {
      const ids = await Promise.resolve(provider());
      const t = now();
      const out = ids.filter((userId) => {
        const since = idleSince.get(userId);
        return since == null || t - since >= IDLE_RECHECK_MS;
      });
      if (idleSince.size > ids.length * 2 + 100) {
        const keep = new Set(ids);
        for (const k of idleSince.keys()) if (!keep.has(k)) idleSince.delete(k);
      }
      return out;
    },
    note: (userId, idle) => {
      if (idle) idleSince.set(userId, now());
      else idleSince.delete(userId);
    },
  };
}

export {
  startRetryLoopIfEnabled,
  defaultIsLoopWorker,
  idleBackoff,
  IDLE_RECHECK_MS,
};
