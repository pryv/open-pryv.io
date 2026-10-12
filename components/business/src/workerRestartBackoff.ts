/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Delay before the master (`bin/master.js`) forks a replacement for a worker
 * that died. A one-off crash is replaced at once. Workers of one kind that
 * keep dying soon after they started (a crash loop: a bad config, an
 * unreachable database, a request that crashes every worker it reaches) are
 * replaced after a delay that doubles with each such death, up to a cap, so
 * the loop does not burn the host's CPU and hammer the databases with boots.
 * A worker that stayed up for `stableMs` resets the count of its kind.
 */

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30000;
const DEFAULT_STABLE_MS = 60000;

type BackoffOptions = { baseMs?: number; maxMs?: number; stableMs?: number };

/** Delay for the n-th consecutive early death (0-based): 0, base, 2 base, 4 base, ... capped. */
function restartDelayMs (earlyDeaths: number, baseMs: number = DEFAULT_BASE_MS, maxMs: number = DEFAULT_MAX_MS): number {
  if (earlyDeaths <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(earlyDeaths - 1, 30));
}

function createWorkerRestartBackoff (options: BackoffOptions = {}) {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  const earlyDeaths = new Map<string, number>();
  return {
    /**
     * A worker of `kind` died after `uptimeMs`: the delay before forking its
     * replacement.
     */
    onWorkerExit (kind: string, uptimeMs: number): number {
      const previous = uptimeMs >= stableMs ? 0 : (earlyDeaths.get(kind) ?? 0);
      earlyDeaths.set(kind, previous + 1);
      return restartDelayMs(previous, baseMs, maxMs);
    }
  };
}

export { createWorkerRestartBackoff, restartDelayMs, DEFAULT_BASE_MS, DEFAULT_MAX_MS, DEFAULT_STABLE_MS };
