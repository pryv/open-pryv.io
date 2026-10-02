/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { describePlatformIntegrity } from './PlatformDB.ts';
import type { PlatformIntegrityReport } from './PlatformDB.ts';

/**
 * Periodic platform DB integrity check, THIS node's copy (the same read-only
 * check the master runs at boot). A copy can be damaged while the core runs
 * (e.g. by a snapshot restore inside rqlite), and nothing else reports it:
 * upserts then store a key twice and lookups miss rows.
 *
 * Logs an error at every failed check, and once when a check passes again
 * after a failure. A check that cannot run (store unreachable) is a warning
 * and leaves the known state unchanged. Checks never overlap.
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

interface IntegrityMonitorLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

interface IntegrityMonitorOpts {
  check: () => Promise<PlatformIntegrityReport>;
  /** 0 disables the periodic check. */
  intervalMs: number;
  /** Result of the boot check: true, false, or null when unknown. */
  initialOk?: boolean | null;
  logger: IntegrityMonitorLogger;
}

interface IntegrityMonitor {
  /** One check now (skipped while a check is running). */
  runCheck (): Promise<void>;
  stop (): void;
}

/**
 * Accepts a number or a numeric string (environment overrides arrive as
 * strings); null / undefined give the default; 0 disables.
 */
function resolveIntervalMs (value: unknown): number {
  if (value == null) return DEFAULT_INTERVAL_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`storages.platform.integrityCheckIntervalMs must be 0 (disabled) or a positive number of milliseconds (got ${JSON.stringify(value)})`);
  }
  return n;
}

function startPlatformIntegrityMonitor (opts: IntegrityMonitorOpts): IntegrityMonitor {
  const { check, intervalMs, logger } = opts;
  let lastOk: boolean | null = opts.initialOk ?? null;
  let running = false;
  let stopped = false;

  async function runCheck (): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const report = await check();
      if (stopped) return;
      if (!report.ok) {
        logger.error(`[platform-integrity] ${describePlatformIntegrity(report).join('\n  ')}`);
      } else if (lastOk === false) {
        logger.info('[platform-integrity] OK again: this node\'s platform DB passes the integrity check');
      }
      lastOk = report.ok;
    } catch (err) {
      if (!stopped) logger.warn(`[platform-integrity] periodic check could not run: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (intervalMs > 0) {
    timer = setInterval(() => { runCheck(); }, intervalMs);
    timer.unref();
  }

  return {
    runCheck,
    stop () {
      stopped = true;
      if (timer != null) clearInterval(timer);
      timer = null;
    }
  };
}

export { startPlatformIntegrityMonitor, resolveIntervalMs, DEFAULT_INTERVAL_MS };
export type { IntegrityMonitorOpts, IntegrityMonitor };
