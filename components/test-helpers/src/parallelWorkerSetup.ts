/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Plan 61 Stage 3 — per-worker parallel-test harness.
 *
 * Consumes the §2D contract documented at
 * `open-pryv.io/docs/storage-isolation-for-parallel-tests.md`:
 *
 *   - applies a deterministic set of per-worker config overrides
 *     (PG database name, SQLite path, rqlite ports + dataDir, http ports,
 *      tcpBroker port, mongo database name, filesystem previews path) so
 *     concurrent mocha worker processes can't collide on shared storage
 *     state.
 *   - spawns a worker-private rqlited bound to the per-worker ports,
 *     tracking the PID for both in-process cleanup and out-of-band
 *     `just clean-test-data-parallel` recovery.
 *   - registers cleanup via mocha's `afterAll` + process `exit` +
 *     SIGINT/SIGTERM/SIGHUP so orphan rqliteds are never left behind on
 *     clean worker exit (best-effort on crash).
 *
 * Non-parallel mode (`MOCHA_PARALLEL` unset) is a no-op so the host
 * rqlited on the standard 4001/4002 ports keeps serving sequential
 * tests unchanged.
 */

import type { ChildProcess } from 'child_process';
import { fileURLToPath } from 'node:url';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `parallelWorkerSetup.ts` lives at
// `<repo>/components/test-helpers/src/parallelWorkerSetup.ts`. The repo
// root is three levels up (src → test-helpers → components → repo).
// Resolve once at module-load — process.cwd() is unreliable here because
// scripts/components-run cd's into the component dir before mocha starts,
// so test workers' cwd is e.g. `components/api-server/` not the repo
// root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Per-worker port stride. §2D spec is `4001 + id*10`. Worker 0 collides
// with the host dev rqlited at 4001 by design — in parallel mode the
// host rqlited must be stopped first (`just clean-test-data-parallel`
// includes a stop hint).
const PORT_STRIDE = 10;

const RQLITE_HTTP_BASE = 4001;
const RQLITE_RAFT_BASE = 4002;
const HTTP_PORT_BASE = 3000;
const HFS_PORT_BASE = 4000;
const PREVIEWS_PORT_BASE = 3001;
const TCP_BROKER_PORT_BASE = 4222;

interface WorkerOverrides {
  workerId: number;
  isParallel: boolean;
  postgresqlDatabase: string;
  sqlitePath: string;
  previewsDirPath: string;
  rqliteUrl: string;
  rqliteRaftPort: number;
  rqliteDataDir: string;
  mongodbDatabase: string;
  httpPort: number;
  hfsPort: number;
  previewsPort: number;
  tcpBrokerPort: number;
}

let rqliteChild: ChildProcess | null = null;
let cleanupRegistered = false;
let setupDone = false;
let pidFilePath: string | null = null;

/**
 * Returns the current mocha worker id. Defaults to 0 when the test
 * harness is running sequentially (or when mocha hasn't set
 * `MOCHA_WORKER_ID`).
 */
export function getWorkerId (): number {
  const raw = process.env.MOCHA_WORKER_ID;
  if (raw == null || raw === '') return 0;
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id >= 0 ? id : 0;
}

/**
 * True when mocha was invoked with `MOCHA_PARALLEL=1`. The harness only
 * activates in parallel mode; sequential matrices keep using the host
 * rqlited at the standard ports.
 */
export function isParallelMode (): boolean {
  return process.env.MOCHA_PARALLEL === '1';
}

/**
 * Computes the per-worker overrides per §2D. Pure function — exported
 * for unit tests + diagnostics. `workerId === 0` returns the §2D
 * defaults (i.e. exactly the values the standalone dev harness uses);
 * the harness only applies them when `isParallelMode()` is true so
 * sequential mode is untouched.
 */
export function getPerWorkerOverrides (workerId: number = getWorkerId()): WorkerOverrides {
  const stride = workerId * PORT_STRIDE;
  // Path-typed config values must be absolute so consumers don't
  // re-resolve them against an unpredictable cwd. Engines + bin/master.js
  // both call `path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)`,
  // and test workers run from `components/<name>/`.
  return {
    workerId,
    isParallel: isParallelMode(),
    postgresqlDatabase: `pryv-node-test-w${workerId}`,
    sqlitePath: path.join(REPO_ROOT, `var-pryv/users-test-w${workerId}/`),
    previewsDirPath: path.join(REPO_ROOT, `var-pryv/previews-test-w${workerId}/`),
    rqliteUrl: `http://localhost:${RQLITE_HTTP_BASE + stride}`,
    rqliteRaftPort: RQLITE_RAFT_BASE + stride,
    rqliteDataDir: path.join(REPO_ROOT, `var-pryv/rqlite-data-w${workerId}/`),
    mongodbDatabase: `pryv-node-test-w${workerId}`,
    httpPort: HTTP_PORT_BASE + stride,
    hfsPort: HFS_PORT_BASE + stride,
    previewsPort: PREVIEWS_PORT_BASE + stride,
    tcpBrokerPort: TCP_BROKER_PORT_BASE + stride
  };
}

/**
 * Apply the per-worker config overrides via `config.set`. §2A/§2C
 * (Plan 70 Wave 1) make these reads lazy, so calling `set` before any
 * factory captures the value is enough to propagate.
 *
 * Idempotent — safe to call multiple times.
 */
export async function applyParallelWorkerConfig (): Promise<WorkerOverrides> {
  const { getConfig } = require('@pryv/boiler');
  const config = await getConfig();
  const o = getPerWorkerOverrides();

  // Even in non-parallel mode we expose getPerWorkerOverrides() to
  // diagnostics, but we DO NOT mutate the config: tests would lose the
  // ability to talk to the host rqlited at 4001.
  if (!o.isParallel) return o;

  config.set('storages:engines:postgresql:database', o.postgresqlDatabase);
  config.set('storages:engines:sqlite:path', o.sqlitePath);
  config.set('storages:engines:filesystem:previewsDirPath', o.previewsDirPath);
  config.set('storages:engines:rqlite:url', o.rqliteUrl);
  config.set('storages:engines:rqlite:raftPort', o.rqliteRaftPort);
  config.set('storages:engines:rqlite:dataDir', o.rqliteDataDir);
  config.set('storages:engines:mongodb:database', o.mongodbDatabase);
  config.set('http:port', o.httpPort);
  config.set('http:hfsPort', o.hfsPort);
  config.set('http:previewsPort', o.previewsPort);
  config.set('tcpBroker:port', o.tcpBrokerPort);

  return o;
}

/**
 * Spawn the worker-private rqlited. Returns once `/readyz` responds OK.
 * No-op when not in parallel mode (the host rqlited at 4001 serves
 * sequential tests).
 *
 * Idempotent — repeat calls within the same worker reuse the live
 * process.
 */
export async function spawnWorkerRqlited (o: WorkerOverrides): Promise<void> {
  if (!o.isParallel) return;
  if (rqliteChild != null && rqliteChild.exitCode == null) return;

  const httpPort = RQLITE_HTTP_BASE + o.workerId * PORT_STRIDE;
  const raftPort = o.rqliteRaftPort;
  const dataDir = path.isAbsolute(o.rqliteDataDir)
    ? o.rqliteDataDir
    : path.resolve(REPO_ROOT, o.rqliteDataDir);
  const binPath = path.resolve(REPO_ROOT, 'bin-ext', 'rqlited');

  if (!fs.existsSync(binPath)) {
    throw new Error(`[parallelWorkerSetup] rqlited binary missing at ${binPath} — run storages/engines/rqlite/scripts/setup`);
  }
  fs.mkdirSync(dataDir, { recursive: true });

  const args = [
    '-node-id', `single-w${o.workerId}`,
    '-http-addr', `0.0.0.0:${httpPort}`,
    '-http-adv-addr', `127.0.0.1:${httpPort}`,
    '-raft-addr', `127.0.0.1:${raftPort}`,
    '-raft-cluster-remove-shutdown',
    dataDir
  ];

  // Capture the spawned child in a local const so strictNullChecks doesn't
  // flag every subsequent use — the module-level `rqliteChild` can be reset
  // to null by the `exit` handler, but `child` is stable within this scope.
  const child = spawn(binPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  rqliteChild = child;

  // Silently drain stdio so the child doesn't block on a full pipe.
  // Mocha tests don't need rqlited's chatter; the file pidpath gives
  // operators a reproducible log target if they want to attach.
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  child.on('error', (err: Error) => {
    process.stderr.write(`[parallelWorkerSetup w${o.workerId}] rqlited spawn error: ${err.message}\n`);
  });

  child.on('exit', () => {
    rqliteChild = null;
  });

  pidFilePath = path.join(dataDir, 'rqlited.pid');
  if (child.pid != null) {
    try {
      fs.writeFileSync(pidFilePath, String(child.pid));
    } catch {
      // Pidfile is a courtesy for external cleanup; don't fail the worker over it.
    }
  }

  registerCleanupHooks();

  await waitForRqliteReady(o.rqliteUrl, 30000, o.workerId);
}

/**
 * Stop the worker-private rqlited. Idempotent. Safe to call from both
 * `afterAll` and from signal handlers.
 *
 * Returns once the child is reaped or the 5-second SIGKILL fallback
 * fires.
 */
export async function stopWorkerRqlited (): Promise<void> {
  return new Promise((resolve) => {
    if (rqliteChild == null) {
      cleanupPidFile();
      return resolve();
    }
    const child = rqliteChild;
    rqliteChild = null;
    let resolved = false;
    child.once('exit', () => {
      if (resolved) return;
      resolved = true;
      cleanupPidFile();
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
      if (resolved) return;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolved = true;
      cleanupPidFile();
      resolve();
    }, 5000).unref();
  });
}

/**
 * Convenience composite — apply config overrides + spawn rqlited.
 * Used by mochaHooks.beforeAll in `helpers-base.ts` and equivalent
 * places (e.g. the mongodb-engine test hook).
 */
export async function setupParallelWorker (): Promise<WorkerOverrides> {
  const o = await applyParallelWorkerConfig();
  await spawnWorkerRqlited(o);
  setupDone = true;
  return o;
}

/**
 * Convenience composite — stop rqlited + drop pidfile. Wired into
 * mochaHooks.afterAll. Signal-handler path uses a synchronous-best-
 * effort variant (see `registerCleanupHooks`).
 */
export async function teardownParallelWorker (): Promise<void> {
  if (!setupDone) return;
  setupDone = false;
  await stopWorkerRqlited();
}

// --- internals ----------------------------------------------------------

async function waitForRqliteReady (url: string, timeoutMs: number, workerId: number): Promise<void> {
  const start = Date.now();
  const readyz = url.replace(/\/$/, '') + '/readyz';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(readyz);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`[parallelWorkerSetup w${workerId}] rqlited at ${url} not ready within ${timeoutMs}ms`);
}

function cleanupPidFile (): void {
  if (pidFilePath == null) return;
  try { fs.unlinkSync(pidFilePath); } catch { /* gone already */ }
  pidFilePath = null;
}

function registerCleanupHooks (): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  // Synchronous best-effort on exit: spawn-sync `kill -SIGTERM <pid>` so
  // the rqlited process doesn't survive its parent worker.
  process.on('exit', () => {
    if (rqliteChild?.pid != null) {
      try { process.kill(rqliteChild.pid, 'SIGTERM'); } catch { /* gone */ }
    }
    if (pidFilePath != null) {
      try { fs.unlinkSync(pidFilePath); } catch { /* gone */ }
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      // best-effort sync kill then exit
      if (rqliteChild?.pid != null) {
        try { process.kill(rqliteChild.pid, 'SIGTERM'); } catch { /* gone */ }
      }
      if (pidFilePath != null) {
        try { fs.unlinkSync(pidFilePath); } catch { /* gone */ }
      }
      process.exit(0);
    });
  }
}

export default {
  getWorkerId,
  isParallelMode,
  getPerWorkerOverrides,
  applyParallelWorkerConfig,
  spawnWorkerRqlited,
  stopWorkerRqlited,
  setupParallelWorker,
  teardownParallelWorker
};
