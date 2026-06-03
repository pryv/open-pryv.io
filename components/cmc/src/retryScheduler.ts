/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — retry-loop scheduler.
 *
 * A small wrapper that drives `retryQueue.runRetryLoop` per user on an
 * interval. The operator provides a `userIdsProvider` callback that
 * yields the users to scan; the scheduler iterates them sequentially
 * each tick and stops cleanly on `stop()`.
 *
 * Behaviour:
 *   - `start(intervalMs)` schedules a fresh tick after `intervalMs`.
 *   - Each tick: await `userIdsProvider()`, then for every userId
 *     await `runRetryLoop({ userId, deps })`.
 *   - Errors per-user are caught and logged; one user's failure
 *     doesn't poison the rest of the tick.
 *   - Ticks don't overlap — if the previous tick is still running
 *     when the timer fires, the new tick is skipped (logged via
 *     `info` if available).
 *   - `stop()` clears the timer and waits for the in-flight tick.
 *
 * The scheduler does NOT enumerate users itself — that's deliberately
 * operator-provided so deployments can scope (per-shard, per-worker,
 * recent-activity-only) however they want.
 */

const retryQueue = require('./retryQueue.ts');

type RunRetryLoopFn = typeof import('./retryQueue.ts').runRetryLoop;

type Logger = { debug?: Function; warn?: Function; info?: Function };

type SchedulerDeps = {
  // Forwarded into runRetryLoop. Same shape as RetryDeps in retryQueue.ts
  // — must include mall, dispatch, dispatchDeps, etc.
  retryDeps: Record<string, unknown>;
  // Returns the list of userIds to process on each tick. Operator-defined.
  userIdsProvider: () => Promise<string[]> | string[];
  // Optional override of the runRetryLoop function (tests inject a stub).
  runRetryLoop?: RunRetryLoopFn;
  // Maximum events per user per tick (forwarded into runRetryLoop.limit).
  perUserLimit?: number;
  // Logger; optional.
  logger?: Logger;
};

class RetryScheduler {
  private deps: SchedulerDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private intervalMs: number = 60_000;
  private ticks = 0;
  private skipped = 0;
  private errors = 0;

  constructor (deps: SchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Start the loop. `intervalMs` defaults to 60s. The first tick fires
   * after `intervalMs` (not immediately) so callers wanting an eager
   * first run can call `tick()` separately before `start()`.
   */
  start (intervalMs?: number): void {
    if (this.running) return;
    this.running = true;
    if (typeof intervalMs === 'number' && intervalMs > 0) {
      this.intervalMs = intervalMs;
    }
    this.scheduleNext();
  }

  /**
   * Stop the loop. Returns a promise that resolves once any in-flight
   * tick is finished.
   */
  async stop (): Promise<void> {
    this.running = false;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight != null) {
      await this.inFlight.catch(() => {});
    }
  }

  /**
   * One manual tick. Useful for tests + eager-first-run callers.
   * Resolves with per-tick stats.
   */
  async tick (): Promise<{ users: number; succeeded: number; rescheduled: number; failedPermanent: number; errors: number }> {
    if (this.inFlight != null) {
      this.skipped += 1;
      this.deps.logger?.info?.('cmc/retryScheduler: tick skipped — previous still in-flight');
      // Wait for the in-flight one, then return empty stats — caller can
      // re-run if needed.
      await this.inFlight.catch(() => {});
      return { users: 0, succeeded: 0, rescheduled: 0, failedPermanent: 0, errors: 0 };
    }
    let resolveFn: () => void = () => {};
    this.inFlight = new Promise<void>((resolve) => { resolveFn = resolve; });
    try {
      this.ticks += 1;
      const userIds = await Promise.resolve(this.deps.userIdsProvider());
      let succeeded = 0;
      let rescheduled = 0;
      let failedPermanent = 0;
      let tickErrors = 0;
      const runLoop = this.deps.runRetryLoop ?? retryQueue.runRetryLoop;
      for (const userId of userIds) {
        try {
          const summary = await runLoop({
            userId,
            deps: this.deps.retryDeps,
            limit: this.deps.perUserLimit,
          });
          succeeded += summary.succeeded;
          rescheduled += summary.rescheduled;
          failedPermanent += summary.failedPermanent;
        } catch (err: unknown) {
          tickErrors += 1;
          this.errors += 1;
          const message = err instanceof Error ? err.message : String(err);
          this.deps.logger?.warn?.('cmc/retryScheduler: per-user run failed', {
            userId,
            error: message,
          });
        }
      }
      return { users: userIds.length, succeeded, rescheduled, failedPermanent, errors: tickErrors };
    } finally {
      const f = resolveFn;
      this.inFlight = null;
      f();
    }
  }

  /**
   * Snapshot counters for observability. tests use this.
   */
  stats (): { ticks: number; skipped: number; errors: number; running: boolean } {
    return { ticks: this.ticks, skipped: this.skipped, errors: this.errors, running: this.running };
  }

  private scheduleNext (): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => {
          this.deps.logger?.warn?.('cmc/retryScheduler: tick threw', {
            error: String(err?.message || err),
          });
        })
        .finally(() => {
          if (this.running) this.scheduleNext();
        });
    }, this.intervalMs);
  }
}

export {
  RetryScheduler,
};
