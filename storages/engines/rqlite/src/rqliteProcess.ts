/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Manages the rqlited child process lifecycle.
 * Spawned by master.js before workers start.
 *
 * Single-core: starts rqlited as a standalone node (no join).
 * Multi-core: uses DNS discovery via lsc.{dns.domain} to find peers.
 */

import type { ChildProcess } from 'child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

let rqliteChild: ChildProcess | null = null;

/**
 * Default budget for rqlited's HTTP API to answer /readyz at boot.
 * Overridden by `storages.engines.rqlite.readyTimeoutMs`.
 */
const DEFAULT_READY_TIMEOUT_MS = 30000;

/**
 * How long `stop()` waits for rqlited to exit after SIGTERM before sending
 * SIGKILL. rqlited takes a snapshot when it closes (tens of milliseconds
 * normally, more on a large store or a slow disk); a SIGKILL in the middle of
 * it can leave the snapshot store missing data, which a later restore copies
 * into the live database. Kept above a slow snapshot and below a supervisor's
 * stop timeout (systemd units commonly use 30 s).
 */
const STOP_KILL_TIMEOUT_MS = 20000;

interface TlsConfig {
  caFile: string;
  certFile: string;
  keyFile: string;
  verifyClient?: boolean;
  verifyServerName?: string | null;
}

interface RqliteOpts {
  coreId: string;
  binPath?: string;
  dataDir: string;
  httpPort?: number;
  raftPort?: number;
  dnsDomain?: string | null;
  discoveryEnabled?: boolean;
  nonVoter?: boolean;
  coreIp?: string | null;
  tls?: TlsConfig | null;
  readyTimeoutMs?: number;
  /**
   * File rqlited appends its stdout and stderr to. Null (default): rqlited
   * writes to the master's own stdout and stderr. Never a pipe read by the
   * master: rqlited must outlive the master's output handling, see `start()`.
   */
  logFile?: string | null;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * Build the argv passed to rqlited. Pure function — no side effects.
 * Exported so callers can unit-test argv construction without spawning
 * a real process.
 */
function buildArgs (opts: RqliteOpts): string[] {
  const {
    coreId,
    httpPort = 4001,
    raftPort = 4002,
    dnsDomain = null,
    discoveryEnabled = false,
    nonVoter = false,
    coreIp = null,
    tls = null,
    dataDir
  } = opts;

  const advAddr = (coreIp || '127.0.0.1');
  // Multi-core: advAddr is the core's public IP which is NAT'd on EC2 and
  // most cloud VMs (the network interface doesn't actually hold that IP).
  // Bind 0.0.0.0 for both listeners and pass -*-adv-addr so peers still
  // contact us at the public address. Single-core stays on 127.0.0.1 for
  // BOTH listeners: the HTTP API is plaintext and unauthenticated (the tls
  // block below only secures the raft channel), so it must never be
  // reachable from outside the host when no peer needs it.
  const isMultiCore = (coreIp != null);
  const httpAddr = isMultiCore ? `0.0.0.0:${httpPort}` : `127.0.0.1:${httpPort}`;
  const raftBindAddr = isMultiCore ? `0.0.0.0:${raftPort}` : `${advAddr}:${raftPort}`;

  const args: string[] = [
    '-node-id', coreId,
    '-http-addr', httpAddr,
    '-http-adv-addr', advAddr + ':' + httpPort,
    '-raft-addr', raftBindAddr
  ];
  if (isMultiCore) {
    args.push('-raft-adv-addr', `${advAddr}:${raftPort}`);
  }
  // A node must NOT remove itself from the Raft cluster on shutdown: a
  // restart (crash, upgrade, container reschedule) is not a decommission.
  // Auto-removal made multi-core clusters shrink on every restart and be
  // fragile under orchestrators. Permanent removal of a node is a deliberate
  // operator action, not a side effect of the process stopping.

  // A non-voter (read-only) node replicates the store and forwards writes to
  // the leader but does NOT count toward quorum or vote in elections. Joining
  // a new core as a non-voter means an unreachable/stranded joiner can never
  // stall the existing cluster. Promotion to voter is a deliberate operator
  // step (remove + rejoin as voter), reserved for >=3-core clusters.
  if (nonVoter) {
    args.push('-raft-non-voter');
  }

  if (dnsDomain != null && discoveryEnabled) {
    const discoName = 'lsc.' + dnsDomain;
    args.push(
      '-disco-mode', 'dns',
      '-disco-config', JSON.stringify({ name: discoName, port: raftPort })
    );
    // rqlited requires -bootstrap-expect together with -disco-mode for
    // VOTING nodes. 1 lets the first core come up alone; subsequent cores
    // find it via the DNS record and join. Once the cluster is formed,
    // -bootstrap-expect is ignored on restarts (raft log wins).
    // A non-voter must NOT get -bootstrap-expect: read-only nodes cannot
    // bootstrap a cluster, and rqlited terminates with an error if it sees
    // both flags together.
    if (!nonVoter) {
      args.push('-bootstrap-expect', '1');
    }
  }
  // Single-core (discoveryEnabled=false) deliberately gets neither flag —
  // rqlited auto-bootstraps a 1-node cluster on first run from an empty
  // data dir and reuses the raft log on restart.

  if (tls != null) {
    const { caFile, certFile, keyFile, verifyClient = true, verifyServerName = null } = tls;
    if (caFile == null || certFile == null || keyFile == null) {
      throw new Error('rqlite tls config requires caFile, certFile and keyFile (or set tls: null to disable)');
    }
    args.push(
      '-node-ca-cert', caFile,
      '-node-cert', certFile,
      '-node-key', keyFile
    );
    if (verifyClient) args.push('-node-verify-client');
    if (verifyServerName != null) args.push('-node-verify-server-name', verifyServerName);
  }

  args.push(dataDir);
  return args;
}

/**
 * Resolve the readiness budget from config. Accepts a number or a numeric
 * string (environment overrides arrive as strings); null / undefined fall
 * back to the default. Anything else is a config error and must fail the
 * boot loudly rather than produce a loop that never polls.
 */
function resolveReadyTimeoutMs (value: unknown): number {
  if (value == null) return DEFAULT_READY_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`storages.engines.rqlite.readyTimeoutMs must be a positive number of milliseconds (got ${JSON.stringify(value)})`);
  }
  return n;
}

async function start (opts: RqliteOpts): Promise<void> {
  const {
    binPath,
    dataDir,
    tls = null,
    log = console.log,
    warn = log
  } = opts;

  const absDataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(process.cwd(), dataDir);
  const absBinPath = path.isAbsolute(binPath) ? binPath : path.resolve(process.cwd(), binPath as string);

  fs.mkdirSync(absDataDir, { recursive: true });

  const args = buildArgs({ ...opts, dataDir: absDataDir });

  if (tls != null) {
    log(`rqlited TLS enabled: ca=${tls.caFile} cert=${tls.certFile} verifyClient=${tls.verifyClient !== false}`);
  }

  const httpPort = opts.httpPort || 4001;
  // Resolved before spawn so a bad config value never orphans a child process.
  const readyTimeoutMs = resolveReadyTimeoutMs(opts.readyTimeoutMs);

  log(`Starting rqlited: ${absBinPath} ${args.join(' ')}`);

  // rqlited's output must not go through pipes read by this process. When the
  // reader is gone (the master exited, crashed, or stopped reading), the next
  // line rqlited logs kills it with SIGPIPE, and rqlited logs while it takes
  // its snapshot-on-close: dying there leaves the snapshot store missing data,
  // which a later restore copies into the live database. It therefore writes
  // straight to the master's own stdout / stderr (inherited file descriptors,
  // owned by whatever collects the master's output), or to `logFile`.
  const stdio = openOutput(opts.logFile, log);
  try {
    rqliteChild = spawn(absBinPath, args, { stdio });
  } finally {
    // The child holds its own copy of the descriptor.
    if (typeof stdio[1] === 'number') fs.closeSync(stdio[1]);
  }

  // The master can leave through `process.exit()` without running `stop()`: a
  // failed boot check after the spawn (hosted sites), the startup catch for
  // anything that throws later in the boot (migrations, DNS, ACME, fork), or an
  // uncaught exception. rqlited would then outlive the master, keep the data dir
  // open, and a restarted master would find a second rqlited on the same files
  // (rqlite is a single-writer store). Terminate it on any exit.
  const child = rqliteChild!;

  // If our own child dies before it is ready (typically: another rqlited already
  // holds the port or the data dir), fail instead of letting the readiness poll
  // report "ready" from whatever else answers on that port.
  let rejectEarlyExit: (err: Error) => void = () => {};
  const earlyExit = new Promise<never>((_resolve, reject) => { rejectEarlyExit = reject; });
  earlyExit.catch(() => {}); // settled by the race below; avoid an unhandled rejection
  const onEarlyExit = (code: number | null, signal: string | null) => {
    rejectEarlyExit(new Error(`rqlited exited before becoming ready (code=${code} signal=${signal}); ` +
      `something else may already hold port ${httpPort} or the data dir ${absDataDir}`));
  };
  child.on('error', (err: Error) => {
    log(`rqlited spawn error: ${err.message}`);
  });
  const onSpawnError = (err: Error) => {
    rejectEarlyExit(new Error(`rqlited could not be started: ${err.message}`));
  };
  child.once('exit', onEarlyExit);
  child.once('error', onSpawnError);
  const terminateOnExit = () => {
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  };
  process.once('exit', terminateOnExit);

  rqliteChild!.on('exit', (code: number | null, signal: string | null) => {
    process.removeListener('exit', terminateOnExit);
    log(`rqlited exited (code=${code} signal=${signal})`);
    rqliteChild = null;
  });

  // Wait for HTTP API to become ready
  const httpUrl = `http://127.0.0.1:${httpPort}`;
  let elapsedMs: number;
  try {
    elapsedMs = await Promise.race([waitForReady(httpUrl, readyTimeoutMs, warn), earlyExit]);
  } finally {
    child.removeListener('exit', onEarlyExit);
    child.removeListener('error', onSpawnError);
  }
  // Readiness only proves that SOMETHING answers on the port: another rqlited
  // (an orphan of a previous master, or one started by hand) answers at once,
  // before our child has even failed to bind. Require the answering process to
  // be our own child.
  const answeringPid = await fetchStatusPid(httpUrl);
  if (answeringPid !== child.pid) {
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    throw new Error(`rqlited exited before becoming ready: the rqlited answering on port ${httpPort} ` +
      `(pid ${answeringPid ?? 'unknown'}) is not the one just started (pid ${child.pid}); another ` +
      `rqlited already holds the port or the data dir ${absDataDir}. Stop it before starting the master.`);
  }
  log(`rqlited HTTP API ready in ${formatSeconds(elapsedMs)}`);
}

/**
 * Stop the rqlited process gracefully. Resolves once rqlited has exited.
 * SIGKILL after `killTimeoutMs`, logged as an error: a kill during the
 * snapshot-on-close can leave the snapshot store incomplete.
 */
function stop (log: (msg: string) => void = console.log,
  error: (msg: string) => void = log,
  killTimeoutMs: number = STOP_KILL_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const child = rqliteChild;
    if (child == null) return resolve();
    log('Stopping rqlited...');
    const killTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        error(`rqlited did not stop within ${formatSeconds(killTimeoutMs)}, killed: its snapshot may be incomplete`);
        child.kill('SIGKILL');
      }
    }, killTimeoutMs);
    killTimer.unref();
    child.once('exit', () => {
      clearTimeout(killTimer);
      if (rqliteChild === child) rqliteChild = null;
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * Check if rqlited is running.
 */
function isRunning (): boolean {
  return rqliteChild != null && rqliteChild.exitCode == null;
}

/**
 * The pid of the rqlited answering at `httpUrl` (`/status` -> `os.pid`), or
 * null when it cannot be read.
 */
async function fetchStatusPid (httpUrl: string): Promise<number | null> {
  try {
    const res = await fetch(httpUrl + '/status');
    if (!res.ok) return null;
    const status = await res.json() as { os?: { pid?: unknown } };
    return typeof status?.os?.pid === 'number' ? status.os.pid : null;
  } catch {
    return null;
  }
}

/**
 * The stdio for rqlited: stdin ignored, stdout + stderr either inherited from
 * this process or appended to `logFile` (relative paths resolve against the
 * working directory, like `dataDir`).
 */
function openOutput (logFile: string | null | undefined, log: (msg: string) => void): ['ignore', 'inherit' | number, 'inherit' | number] {
  if (logFile == null || logFile === '') return ['ignore', 'inherit', 'inherit'];
  const absLogFile = path.isAbsolute(logFile) ? logFile : path.resolve(process.cwd(), logFile);
  fs.mkdirSync(path.dirname(absLogFile), { recursive: true });
  const fd = fs.openSync(absLogFile, 'a');
  log(`rqlited output: ${absLogFile}`);
  return ['ignore', fd, fd];
}

function formatSeconds (ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

/**
 * Poll rqlite HTTP readyz endpoint until it responds OK.
 * Warns once at 50% and once at 80% of the budget so a slow start is
 * visible in the log before the boot fails. Resolves with the elapsed ms.
 */
async function waitForReady (httpUrl: string, timeoutMs: number, warn: (msg: string) => void, pollIntervalMs: number = 500): Promise<number> {
  const start = Date.now();
  const readyzUrl = httpUrl + '/readyz';
  const thresholds = [0.5, 0.8];
  let nextThreshold = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(readyzUrl);
      if (res.ok) return Date.now() - start;
    } catch {
      // not ready yet
    }
    const elapsed = Date.now() - start;
    while (nextThreshold < thresholds.length && elapsed >= timeoutMs * thresholds[nextThreshold]) {
      const pct = Math.round(thresholds[nextThreshold] * 100);
      warn(`rqlited HTTP API still not ready after ${formatSeconds(elapsed)} (${pct}% of the ${timeoutMs}ms budget, storages.engines.rqlite.readyTimeoutMs)`);
      nextThreshold++;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`rqlited did not become ready within ${timeoutMs}ms (${readyzUrl}). If this node needs longer to start, raise storages.engines.rqlite.readyTimeoutMs.`);
}

/**
 * Wait for an external (not managed by us) rqlite instance to be ready.
 * `timeoutMs` may be undefined (config key absent) and is resolved the
 * same way as for the managed process.
 */
async function waitForExternal (url: string, timeoutMs: number | undefined, log: (msg: string) => void, warn: (msg: string) => void = log): Promise<void> {
  const elapsedMs = await waitForReady(url, resolveReadyTimeoutMs(timeoutMs), warn);
  log(`External rqlited HTTP API ready in ${formatSeconds(elapsedMs)}`);
}

export { start, stop, isRunning, waitForExternal, waitForReady, resolveReadyTimeoutMs, buildArgs, DEFAULT_READY_TIMEOUT_MS, STOP_KILL_TIMEOUT_MS };
