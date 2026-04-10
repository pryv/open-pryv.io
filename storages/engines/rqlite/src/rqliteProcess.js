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

const { spawn } = require('node:child_process');
const path = require('node:path');
const mkdirp = require('mkdirp');

let rqliteChild = null;

/**
 * Start rqlited process.
 * @param {Object} opts
 * @param {string} opts.coreId - this core's ID (used as rqlite node-id)
 * @param {string} opts.binPath - path to rqlited binary
 * @param {string} opts.dataDir - path to data directory
 * @param {number} opts.httpPort - HTTP API port (default 4001)
 * @param {number} opts.raftPort - Raft consensus port (default 4002)
 * @param {string|null} opts.dnsDomain - dns.domain (null = single-core)
 * @param {string|null} opts.coreIp - this core's IP for raft-addr binding
 * @param {Function} opts.log - logging function
 * @returns {Promise<void>} resolves when rqlite HTTP API is ready
 */
async function start (opts) {
  const {
    coreId,
    binPath,
    dataDir,
    httpPort = 4001,
    raftPort = 4002,
    dnsDomain = null,
    coreIp = null,
    log = console.log
  } = opts;

  const absDataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(process.cwd(), dataDir);
  const absBinPath = path.isAbsolute(binPath) ? binPath : path.resolve(process.cwd(), binPath);

  mkdirp.sync(absDataDir);

  const advAddr = (coreIp || '127.0.0.1');
  const httpAddr = `0.0.0.0:${httpPort}`;
  const raftAddr = advAddr + ':' + raftPort;

  const args = [
    '-node-id', coreId,
    '-http-addr', httpAddr,
    '-http-adv-addr', advAddr + ':' + httpPort,
    '-raft-addr', raftAddr,
    '-raft-cluster-remove-shutdown' // graceful leave on shutdown
  ];

  // Multi-core: DNS-based discovery
  if (dnsDomain != null) {
    const discoName = 'lsc.' + dnsDomain;
    args.push(
      '-disco-mode', 'dns',
      '-disco-config', JSON.stringify({ name: discoName, port: raftPort })
    );
  }

  args.push(absDataDir);

  log(`Starting rqlited: ${absBinPath} ${args.join(' ')}`);

  rqliteChild = spawn(absBinPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  rqliteChild.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) log(`[rqlite] ${line}`);
  });

  rqliteChild.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) log(`[rqlite:err] ${line}`);
  });

  rqliteChild.on('error', (err) => {
    log(`rqlited spawn error: ${err.message}`);
  });

  rqliteChild.on('exit', (code, signal) => {
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
 * @param {Function} [log]
 * @returns {Promise<void>}
 */
function stop (log = console.log) {
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
 * @returns {boolean}
 */
function isRunning () {
  return rqliteChild != null && rqliteChild.exitCode == null;
}

/**
 * Poll rqlite HTTP readyz endpoint until it responds.
 */
async function waitForReady (httpUrl, timeoutMs, log) {
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
 * @param {string} url - rqlite HTTP API base URL
 * @param {number} timeoutMs
 * @param {Function} log
 */
async function waitForExternal (url, timeoutMs, log) {
  await waitForReady(url, timeoutMs, log);
  log('External rqlited HTTP API ready');
}

module.exports = { start, stop, isRunning, waitForExternal };
