/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Bounded concurrency around a scarce per-process resource.
 *
 * At most `concurrency` works run at once; further calls wait in arrival
 * order, at most `queue` of them, and the next is refused at once. A call
 * whose turn comes more than `maxWaitMs` after it arrived is refused without
 * running. A slot is held for one `work` only and released whatever its
 * outcome, so a caller that runs several works in a row re-queues between
 * them.
 *
 * Unconfigured, or configured with `concurrency: 0`, `run` calls `work`
 * directly: processes that do not serve requests (command-line tools, the
 * master, test fixtures) are never queued nor refused.
 */

/** The code a capacity refusal carries, so callers can tell it apart without importing this module. */
const CAPACITY_REFUSED = 'capacity-refused';

/**
 * A work refused for capacity: it never ran. Not a failure of the caller's
 * input; the caller retries after `retryAfterSeconds`.
 */
class CapacityRefusal extends Error {
  readonly code = CAPACITY_REFUSED;
  readonly retryAfterSeconds: number;
  constructor (message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'CapacityRefusal';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isCapacityRefusal (err: unknown): err is CapacityRefusal {
  return err != null && typeof err === 'object' && (err as { code?: unknown }).code === CAPACITY_REFUSED;
}

type LimiterSettings = {
  /** Works running at once; 0 = no limit (pass-through). */
  concurrency: number;
  /** Calls waiting for a slot; 0 = refuse as soon as every slot is busy. */
  queue: number;
  /** Longest wait for a slot, from arrival to turn. */
  maxWaitMs: number;
  /** What a refusal tells the caller to wait. */
  retryAfterSeconds: number;
};

type Limiter = {
  /** Applies `settings`; null switches the limiter to pass-through. */
  configure (settings: LimiterSettings | null): void;
  run<T> (work: () => Promise<T>): Promise<T>;
  /** Works running and calls waiting now (tests and diagnostics). */
  stats (): { running: number; waiting: number };
};

/**
 * @param what Names the resource in refusal messages ("password check").
 */
function createLimiter (what: string): Limiter {
  let settings: LimiterSettings | null = null;
  let running = 0;
  const waiting: Array<() => void> = [];

  function refusal (why: string, s: LimiterSettings): CapacityRefusal {
    return new CapacityRefusal(`Too many ${what}s are in progress on this server (${why}). Please retry later.`, s.retryAfterSeconds);
  }

  function release (): void {
    const next = waiting.shift();
    if (next != null) next(); // the slot passes to the next caller as it stands
    else running--;
  }

  return {
    configure (next: LimiterSettings | null): void {
      settings = next;
    },

    async run<T> (work: () => Promise<T>): Promise<T> {
      const s = settings;
      if (s == null || !(s.concurrency > 0)) return await work();
      const arrived = Date.now();
      if (running >= s.concurrency) {
        if (waiting.length >= s.queue) throw refusal('queue full', s);
        await new Promise<void>((resolve) => { waiting.push(resolve); });
      } else {
        running++;
      }
      // The slot is ours here: taken above or handed over by `release`.
      try {
        if (Date.now() - arrived > s.maxWaitMs) throw refusal('waited too long', s);
        return await work();
      } finally {
        release();
      }
    },

    stats () {
      return { running, waiting: waiting.length };
    }
  };
}

export { createLimiter, CapacityRefusal, isCapacityRefusal, CAPACITY_REFUSED };
export type { Limiter, LimiterSettings };
