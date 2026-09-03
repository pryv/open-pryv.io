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

  rqliteChild = spawn(absBinPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  rqliteChild!.stdout!.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) log(`[rqlite] ${line}`);
  });

  rqliteChild!.stderr!.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) log(`[rqlite:err] ${line}`);
  });

  rqliteChild!.on('error', (err: Error) => {
    log(`rqlited spawn error: ${err.message}`);
  });

  rqliteChild!.on('exit', (code: number | null, signal: string | null) => {
    log(`rqlited exited (code=${code} signal=${signal})`);
    rqliteChild = null;
  });

  // Wait for HTTP API to become ready
  const httpUrl = `http://127.0.0.1:${httpPort}`;
  const elapsedMs = await waitForReady(httpUrl, readyTimeoutMs, warn);
  log(`rqlited HTTP API ready in ${formatSeconds(elapsedMs)}`);
}

/**
 * Stop the rqlited process gracefully.
 */
function stop (log: (msg: string) => void = console.log): Promise<void> {
  return new Promise((resolve) => {
    if (rqliteChild == null) return resolve();
    log('Stopping rqlited...');
    rqliteChild.once('exit', () => {
      rqliteChild = null;
      resolve();
    });
    rqliteChild.kill('SIGTERM');
    // Force kill after 5s
    setTimeout(() => {
      if (rqliteChild != null) {
        rqliteChild.kill('SIGKILL');
      }
    }, 5000).unref();
  });
}

/**
 * Check if rqlited is running.
 */
function isRunning (): boolean {
  return rqliteChild != null && rqliteChild.exitCode == null;
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

export { start, stop, isRunning, waitForExternal, waitForReady, resolveReadyTimeoutMs, buildArgs, DEFAULT_READY_TIMEOUT_MS };
