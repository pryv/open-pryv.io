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
 * @param {Object|null} opts.tls - mTLS material for the Raft channel (null = plain TCP)
 * @param {string} opts.tls.caFile - PEM CA cert used to verify peer certs
 * @param {string} opts.tls.certFile - PEM cert for this node
 * @param {string} opts.tls.keyFile - PEM key for this node
 * @param {boolean} [opts.tls.verifyClient=true] - require mTLS on incoming Raft
 * @param {string|null} [opts.tls.verifyServerName=null] - expected SAN/CN on peers; null = use hostname
 * @param {Function} opts.log - logging function
 * @returns {Promise<void>} resolves when rqlite HTTP API is ready
 */
/**
 * Build the argv passed to rqlited. Pure function — no side effects.
 * Exported so Phase 1 (Plan 34) can unit-test argv construction without
 * spawning a real process.
 */
function buildArgs (opts) {
  const {
    coreId,
    httpPort = 4001,
    raftPort = 4002,
    dnsDomain = null,
    coreIp = null,
    tls = null,
    dataDir
  } = opts;

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

  if (dnsDomain != null) {
    const discoName = 'lsc.' + dnsDomain;
    args.push(
      '-disco-mode', 'dns',
      '-disco-config', JSON.stringify({ name: discoName, port: raftPort })
    );
  }

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

async function start (opts) {
  const {
    binPath,
    dataDir,
    tls = null,
    log = console.log
  } = opts;

  const absDataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(process.cwd(), dataDir);
  const absBinPath = path.isAbsolute(binPath) ? binPath : path.resolve(process.cwd(), binPath);

  mkdirp.sync(absDataDir);

  const args = buildArgs({ ...opts, dataDir: absDataDir });

  if (tls != null) {
    log(`rqlited TLS enabled: ca=${tls.caFile} cert=${tls.certFile} verifyClient=${tls.verifyClient !== false}`);
  }

  const httpPort = opts.httpPort || 4001;

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

module.exports = { start, stop, isRunning, waitForExternal, buildArgs };
