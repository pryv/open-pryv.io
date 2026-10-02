/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shutdown sequence of the master process (`bin/master.js`).
 *
 * The master exits only once rqlited has exited. rqlited takes a snapshot of
 * the platform database when it closes; a master that exits first takes it
 * down mid-snapshot (container teardown when the master is PID 1, supervisor
 * cleanup of the process group), and an interrupted snapshot can leave the
 * snapshot store missing data that a later restore copies into the live
 * database.
 *
 *  1. SIGTERM the workers, stop the master's own services (timers, ACME, DNS);
 *  2. wait for the workers to exit (bounded; SIGKILL the ones left);
 *  3. stop rqlited and wait for it to exit (it has its own SIGKILL fallback);
 *  4. exit(0).
 *
 * An overall deadline forces exit(1) if a step hangs. The defaults fit in a
 * 30 s supervisor stop timeout: 5 s for the workers, up to 20 s for rqlited.
 */

const DEFAULT_WORKERS_TIMEOUT_MS = 5000;
const DEFAULT_DEADLINE_MS = 28000;

interface WorkerLike {
  process: { kill (signal?: NodeJS.Signals): unknown };
  isDead?: () => boolean;
}

interface ClusterLike {
  workers?: Record<string, WorkerLike | undefined>;
}

interface MasterShutdownOpts {
  cluster: ClusterLike;
  /** Stops the master's own services (timers, ACME, DNS). */
  stopServices?: () => Promise<void> | void;
  /** Resolves once rqlited has exited (or at once when none runs). */
  stopRqlite: () => Promise<void>;
  log: (msg: string) => void;
  warn?: (msg: string) => void;
  exit: (code: number) => void;
  workersTimeoutMs?: number;
  deadlineMs?: number;
}

interface MasterShutdown {
  /** Runs the sequence once; later calls are no-ops. */
  shutdown (signal: string): Promise<void>;
  /** To call on every cluster `exit` (and `disconnect`) event. */
  onWorkerExit (): void;
  isShuttingDown (): boolean;
}

function createMasterShutdown (opts: MasterShutdownOpts): MasterShutdown {
  const {
    cluster,
    stopServices,
    stopRqlite,
    log,
    warn = log,
    exit,
    workersTimeoutMs = DEFAULT_WORKERS_TIMEOUT_MS,
    deadlineMs = DEFAULT_DEADLINE_MS
  } = opts;

  let shuttingDown = false;
  let onAllWorkersGone: (() => void) | null = null;

  // A worker stays in `cluster.workers` until it has both exited and
  // disconnected, in either order: judge by its state, not by membership.
  function liveWorkers (): WorkerLike[] {
    return Object.values(cluster.workers ?? {})
      .filter((w): w is WorkerLike => w != null && !(typeof w.isDead === 'function' && w.isDead()));
  }

  function waitForWorkers (): Promise<boolean> {
    if (liveWorkers().length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        onAllWorkersGone = null;
        resolve(false);
      }, workersTimeoutMs);
      onAllWorkersGone = () => {
        clearTimeout(timer);
        onAllWorkersGone = null;
        resolve(true);
      };
    });
  }

  function onWorkerExit (): void {
    if (onAllWorkersGone != null && liveWorkers().length === 0) onAllWorkersGone();
  }

  async function shutdown (signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down workers...`);
    const deadline = setTimeout(() => {
      warn(`Shutdown did not complete within ${deadlineMs} ms, forcing exit`);
      exit(1);
    }, deadlineMs);
    try {
      for (const w of liveWorkers()) {
        try { w.process.kill('SIGTERM'); } catch { /* already gone */ }
      }
      try {
        await stopServices?.();
      } catch (err) {
        warn(`Stopping master services failed: ${(err as Error).message}`);
      }
      if (await waitForWorkers()) {
        log('All workers stopped');
      } else {
        const left = liveWorkers();
        warn(`${left.length} worker(s) still running after ${workersTimeoutMs} ms, killing them`);
        for (const w of left) {
          try { w.process.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }
      // Workers first, so their last platform writes reach rqlited.
      try {
        await stopRqlite();
      } catch (err) {
        warn(`Stopping rqlited failed: ${(err as Error).message}`);
      }
    } finally {
      clearTimeout(deadline);
    }
    log('Master exiting');
    exit(0);
  }

  return {
    shutdown,
    onWorkerExit,
    isShuttingDown: () => shuttingDown
  };
}

export { createMasterShutdown, DEFAULT_WORKERS_TIMEOUT_MS, DEFAULT_DEADLINE_MS };
export type { MasterShutdownOpts, MasterShutdown };
