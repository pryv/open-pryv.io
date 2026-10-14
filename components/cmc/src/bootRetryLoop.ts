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

// Mall handle — pure pass-through to dispatch/retryScheduler (untyped
// requires); never inspected here.
import type { MallLike } from './_types.ts';
import type { MemberSweep } from './memberSweep.ts';
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
};

function defaultIsLoopWorker (): boolean {
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
    deps.logger?.warn?.('cmc/bootRetryLoop: cmc.retryLoop.enabled is false: undeliverable revoke notices are not retried, residual member accesses are not re-swept, expired memberships are not swept');
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
  // Both passes visit the accounts that hold CMC state only: the hidden
  // retries stream exists once the account made its first CMC write (the
  // reserved parents are provisioned together), so its absence is "nothing
  // to do", cached for CMC_STATE_RECHECK_MS; its presence is kept for the
  // life of the process. Without a stream probe on the mall, every account
  // is visited.
  const userIdsProvider = withCmcState(deps.userIdsProvider, deps.mall, deps.logger);

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
    userIdsProvider,
    perUserLimit,
    logger: deps.logger,
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
      userIdsProvider,
      logger: deps.logger,
      runRetryLoop: async ({ userId }: { userId: string }) => {
        const r = await sweep.runLedgerPass(userId);
        return { processed: r.swept + r.expired + r.residuals + r.pruned, succeeded: r.swept + r.residuals, rescheduled: 0, failedPermanent: 0, skipped: 0 };
      },
    });
    ledgerScheduler.start(sweepIntervalMs);
    ledgerScheduler.tick().catch((err: unknown) => {
      deps.logger?.warn?.('cmc/bootRetryLoop: the first member ledger pass failed', { error: String((err as Error)?.message || err) });
    });
    (scheduler as { ledgerScheduler?: unknown }).ledgerScheduler = ledgerScheduler;
    deps.logger?.info?.('cmc/bootRetryLoop: member ledger pass started', { sweepIntervalMs });
  }
  // One handle to stop both at shutdown (the in-flight tick is awaited).
  (scheduler as { stopAll?: () => Promise<void> }).stopAll = async () => {
    await scheduler.stop();
    const ledger = (scheduler as { ledgerScheduler?: { stop: () => Promise<void> } }).ledgerScheduler;
    if (ledger != null) await ledger.stop();
  };
  return scheduler;
}

const CMC_STATE_RECHECK_MS = 10 * 60 * 1000;

/**
 * The provider filtered to the accounts whose hidden retries stream exists
 * (the probe is `streams.getOneWithNoChildren`; absent on the mall, no
 * filtering). A negative verdict is re-checked after CMC_STATE_RECHECK_MS,
 * a positive one kept; a probe that throws counts as "has state" (the loop
 * then reads the queue, which reports the real error).
 */
function withCmcState (provider: () => Promise<string[]> | string[], mall: MallLike, logger?: CmcLogger): () => Promise<string[]> {
  const probe = (mall as { streams?: { getOneWithNoChildren?: (userId: string, streamId: string) => Promise<unknown> } }).streams?.getOneWithNoChildren;
  if (typeof probe !== 'function') return async () => await Promise.resolve(provider());
  const verdicts = new Map<string, { has: boolean; at: number }>();
  return async () => {
    const ids = await Promise.resolve(provider());
    const now = Date.now();
    const out: string[] = [];
    for (const userId of ids) {
      const v = verdicts.get(userId);
      if (v != null && (v.has || now - v.at < CMC_STATE_RECHECK_MS)) {
        if (v.has) out.push(userId);
        continue;
      }
      let has = true;
      try {
        has = (await probe(userId, C.NS_INTERNAL_RETRIES)) != null;
      } catch (err: unknown) {
        logger?.debug?.('cmc/bootRetryLoop: the CMC state probe failed, the account is visited', { userId, error: String((err as Error)?.message || err) });
      }
      verdicts.set(userId, { has, at: now });
      if (has) out.push(userId);
    }
    // Accounts gone from the provider leave the cache.
    if (verdicts.size > ids.length * 2 + 100) {
      const keep = new Set(ids);
      for (const k of verdicts.keys()) if (!keep.has(k)) verdicts.delete(k);
    }
    return out;
  };
}

export {
  startRetryLoopIfEnabled,
  defaultIsLoopWorker,
  withCmcState,
  CMC_STATE_RECHECK_MS,
};
