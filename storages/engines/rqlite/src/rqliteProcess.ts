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

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

let rqliteChild: ChildProcess | null = null;

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
  coreIp?: string | null;
  tls?: TlsConfig | null;
  log?: (msg: string) => void;
}

/**
 * Build the argv passed to rqlited. Pure function — no side effects.
 * Exported so Phase 1 (Plan 34) can unit-test argv construction without
 * spawning a real process.
 */
function buildArgs (opts: RqliteOpts): string[] {
  const {
    coreId,
    httpPort = 4001,
    raftPort = 4002,
    dnsDomain = null,
    discoveryEnabled = false,
    coreIp = null,
    tls = null,
    dataDir
  } = opts;

  const advAddr = (coreIp || '127.0.0.1');
  const httpAddr = `0.0.0.0:${httpPort}`;
  // Multi-core: advAddr is the core's public IP which is NAT'd on EC2 and
  // most cloud VMs (the network interface doesn't actually hold that IP).
  // Bind 0.0.0.0 for both listeners and pass -*-adv-addr so peers still
  // contact us at the public address. Single-core stays on 127.0.0.1.
  const isMultiCore = (coreIp != null);
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
  args.push('-raft-cluster-remove-shutdown'); // graceful leave on shutdown

  if (dnsDomain != null && discoveryEnabled) {
    const discoName = 'lsc.' + dnsDomain;
    args.push(
      '-disco-mode', 'dns',
      '-disco-config', JSON.stringify({ name: discoName, port: raftPort }),
      // rqlited requires -bootstrap-expect together with -disco-mode for
      // voting nodes. 1 lets the first core come up alone; subsequent
      // cores find it via the DNS record and join. Once the cluster is
      // formed, -bootstrap-expect is ignored on restarts (raft log wins).
      '-bootstrap-expect', '1'
    );
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

async function start (opts: RqliteOpts): Promise<void> {
  const {
    binPath,
    dataDir,
    tls = null,
    log = console.log
  } = opts;

  const absDataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(process.cwd(), dataDir);
  const absBinPath = path.isAbsolute(binPath) ? binPath : path.resolve(process.cwd(), binPath as string);

  fs.mkdirSync(absDataDir, { recursive: true });

  const args = buildArgs({ ...opts, dataDir: absDataDir });

  if (tls != null) {
    log(`rqlited TLS enabled: ca=${tls.caFile} cert=${tls.certFile} verifyClient=${tls.verifyClient !== false}`);
  }

  const httpPort = opts.httpPort || 4001;

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
  await waitForReady(httpUrl, 30000, log);
  log('rqlited HTTP API ready');
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

/**
 * Poll rqlite HTTP readyz endpoint until it responds.
 */
async function waitForReady (httpUrl: string, timeoutMs: number, log: (msg: string) => void): Promise<void> {
  const start = Date.now();
  const readyzUrl = httpUrl + '/readyz';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(readyzUrl);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`rqlited did not become ready within ${timeoutMs}ms`);
}

/**
 * Wait for an external (not managed by us) rqlite instance to be ready.
 */
async function waitForExternal (url: string, timeoutMs: number, log: (msg: string) => void): Promise<void> {
  await waitForReady(url, timeoutMs, log);
  log('External rqlited HTTP API ready');
}

module.exports = { start, stop, isRunning, waitForExternal, buildArgs };
