/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin — per-worker in-memory rate-limit for outbound deliveries.
 *
 * Sliding-window per (source, recipient) tuple. Cheap, no I/O; counters
 * reset on worker restart. N× drift accepted on N-worker cores (the
 * quota is defensive against abuse, not a strict guarantee — see
 * components/cmc/README.md "Data residency" + "Open questions" sections).
 *
 * If drift matters in practice, the same-core upgrade path is `cluster_kv`
 * (master-held in-process primitive from Plan 55, not cross-core); the
 * cross-core gap stays unsolved by design.
 */

type WindowEntry = {
  bucket: number[]; // unix timestamps (ms) of recent allowed deliveries
};

type LimiterDeps = {
  windowMs?: number;
  maxInWindow?: number;
  now?: () => number;
};

const DEFAULT_WINDOW_MS = 60 * 1000;       // 1 minute
const DEFAULT_MAX_IN_WINDOW = 100;          // 100 events / minute / (source, recipient)

class RateLimiter {
  private windows: Map<string, WindowEntry>;
  private windowMs: number;
  private maxInWindow: number;
  private now: () => number;

  constructor (deps: LimiterDeps = {}) {
    this.windows = new Map();
    this.windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxInWindow = deps.maxInWindow ?? DEFAULT_MAX_IN_WINDOW;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Check if a delivery is permitted; if yes, record it.
   * Returns { allowed: true } or { allowed: false, retryAfterMs }.
   */
  checkAndRecord (params: { source: string; recipient: string }): { allowed: boolean; retryAfterMs?: number; currentCount: number } {
    const key = params.source + '|' + params.recipient;
    const t = this.now();
    const cutoff = t - this.windowMs;

    let entry = this.windows.get(key);
    if (entry == null) {
      entry = { bucket: [] };
      this.windows.set(key, entry);
    }
    // Trim old timestamps outside the window.
    while (entry.bucket.length > 0 && entry.bucket[0] < cutoff) {
      entry.bucket.shift();
    }
    if (entry.bucket.length >= this.maxInWindow) {
      const oldest = entry.bucket[0];
      const retryAfterMs = Math.max(0, oldest + this.windowMs - t);
      return { allowed: false, retryAfterMs, currentCount: entry.bucket.length };
    }
    entry.bucket.push(t);
    return { allowed: true, currentCount: entry.bucket.length };
  }

  /**
   * Inspect current count for a (source, recipient) pair without recording.
   * Trims old entries as a side effect.
   */
  countFor (params: { source: string; recipient: string }): number {
    const key = params.source + '|' + params.recipient;
    const entry = this.windows.get(key);
    if (entry == null) return 0;
    const cutoff = this.now() - this.windowMs;
    while (entry.bucket.length > 0 && entry.bucket[0] < cutoff) {
      entry.bucket.shift();
    }
    return entry.bucket.length;
  }

  /**
   * Drop all in-memory windows. Useful for tests.
   */
  reset (): void {
    this.windows.clear();
  }

  /**
   * Number of (source, recipient) keys currently tracked. Useful for
   * memory-usage observability + tests.
   */
  size (): number {
    return this.windows.size;
  }
}

export {
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_IN_WINDOW,
  RateLimiter,
};
