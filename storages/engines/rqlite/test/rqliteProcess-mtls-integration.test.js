/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Integration test for Plan 34 Phase 1 — actually spawns two rqlited
 * processes with mTLS on the Raft channel and verifies that the cluster
 * forms and replicates writes. This validates that the flag names and
 * ordering produced by buildArgs() match what the real rqlited binary
 * accepts.
 *
 * Prerequisites (the test skip()s when any are missing):
 *   - `openssl` on PATH  (to generate a self-signed CA + node certs)
 *   - `./bin-ext/rqlited` binary
 *
 * The test uses loopback addresses and non-default ports
 * (14xxx range) so it can run on a developer machine without
 * clashing with any rqlited already listening on 4001/4002.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const { buildArgs } = require('../src/rqliteProcess');

const RQLITED_BIN = path.resolve(__dirname, '../../../../bin-ext/rqlited');
const BOOT_TIMEOUT_MS = 30_000;
const CLUSTER_FORM_TIMEOUT_MS = 30_000;

describe('[RQMTLS] rqlited two-node mTLS cluster', function () {
  this.timeout(120_000);

  let tmpDir;
  let nodeA = null;
  let nodeB = null;

  before(function () {
    if (!fs.existsSync(RQLITED_BIN)) {
      console.log(`  skipping: rqlited not found at ${RQLITED_BIN}`);
      this.skip();
    }
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      console.log('  skipping: openssl not available');
      this.skip();
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-rqlite-mtls-'));
    generatePKI(tmpDir);
  });

  after(async function () {
    this.timeout(15_000);
    await stopProc(nodeB, 'node-b');
    await stopProc(nodeA, 'node-a');
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('forms a cluster and replicates writes across the mTLS Raft channel', async () => {
    const tls = {
      caFile: path.join(tmpDir, 'ca.crt'),
      certFile: path.join(tmpDir, 'node.crt'),
      keyFile: path.join(tmpDir, 'node.key'),
      verifyClient: true
      // verifyServerName left null → rqlite default
    };

    // --- node-a: bootstrap the cluster as a single node ---
    const portsA = { http: 14001, raft: 14002 };
    nodeA = spawnRqlited({
      nodeId: 'node-a',
      dataDir: path.join(tmpDir, 'node-a-data'),
      httpPort: portsA.http,
      raftPort: portsA.raft,
      tls,
      coreIp: '127.0.0.1'
    });
    try {
      await waitForReady(`http://127.0.0.1:${portsA.http}`, BOOT_TIMEOUT_MS);
    } catch (e) {
      dumpLogs(nodeA, 'node-a');
      throw e;
    }

    // --- node-b: join node-a via HTTP (the join handshake is plain HTTP,
    // after which inter-node Raft traffic flows over mTLS) ---
    const portsB = { http: 14003, raft: 14004 };
    nodeB = spawnRqlited({
      nodeId: 'node-b',
      dataDir: path.join(tmpDir, 'node-b-data'),
      httpPort: portsB.http,
      raftPort: portsB.raft,
      tls,
      coreIp: '127.0.0.1',
      // -join in rqlite points to a peer's Raft port (not HTTP). Once joined,
      // the inter-node Raft traffic flows over mTLS.
      joinUrl: `127.0.0.1:${portsA.raft}`
    });
    try {
      await waitForReady(`http://127.0.0.1:${portsB.http}`, BOOT_TIMEOUT_MS);
    } catch (e) {
      dumpLogs(nodeA, 'node-a');
      dumpLogs(nodeB, 'node-b');
      throw e;
    }

    // --- wait for cluster to agree on a leader ---
    await waitForClusterSize(`http://127.0.0.1:${portsA.http}`, 2, CLUSTER_FORM_TIMEOUT_MS);

    // --- write on node-a ---
    const writeRes = await fetch(`http://127.0.0.1:${portsA.http}/db/execute?level=strong`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)'],
        ['INSERT INTO t (k, v) VALUES (?, ?)', 'plan-34', 'phase-1-ok']
      ])
    });
    assert.equal(writeRes.status, 200, 'write to node-a returns 200');
    const writeBody = await writeRes.json();
    assert(!writeBody.results.some(r => r.error), `write errors: ${JSON.stringify(writeBody)}`);

    // --- read on node-b (with level=strong to ensure it went through Raft) ---
    const readRes = await fetch(`http://127.0.0.1:${portsB.http}/db/query?level=strong`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([['SELECT v FROM t WHERE k = ?', 'plan-34']])
    });
    assert.equal(readRes.status, 200, 'read from node-b returns 200');
    const readBody = await readRes.json();
    const rows = readBody.results[0].values || [];
    assert.deepEqual(rows, [['phase-1-ok']], `row not replicated; body=${JSON.stringify(readBody)}`);
  });
});

// --- PKI helpers ---------------------------------------------------------

/**
 * Generate a self-signed CA and one node cert signed by it. Both nodes
 * use the same cert in this test (both listen on 127.0.0.1); in real
 * deployments each node gets its own cert.
 */
function generatePKI (dir) {
  // CA key + cert
  const caKey = path.join(dir, 'ca.key');
  const caCert = path.join(dir, 'ca.crt');
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKey]);
  execFileSync('openssl', ['req', '-x509', '-new', '-key', caKey, '-days', '1', '-out', caCert,
    '-subj', '/CN=pryv-test-ca']);

  // Node key + CSR
  const nodeKey = path.join(dir, 'node.key');
  const nodeCsr = path.join(dir, 'node.csr');
  const nodeCert = path.join(dir, 'node.crt');
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', nodeKey]);
  execFileSync('openssl', ['req', '-new', '-key', nodeKey, '-out', nodeCsr,
    '-subj', '/CN=127.0.0.1']);

  // Sign node CSR with CA, adding SAN=IP:127.0.0.1 + DNS:localhost
  const extFile = path.join(dir, 'node.ext');
  fs.writeFileSync(extFile, 'subjectAltName = IP:127.0.0.1, DNS:localhost\n');
  execFileSync('openssl', ['x509', '-req', '-in', nodeCsr, '-CA', caCert, '-CAkey', caKey,
    '-CAcreateserial', '-out', nodeCert, '-days', '1', '-extfile', extFile]);
}

// --- rqlited helpers -----------------------------------------------------

function spawnRqlited ({ nodeId, dataDir, httpPort, raftPort, tls, coreIp, joinUrl = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const args = buildArgs({
    coreId: nodeId,
    dataDir,
    httpPort,
    raftPort,
    tls,
    coreIp
  });
  // Insert -join before the final dataDir positional argument
  if (joinUrl != null) {
    const dd = args.pop();
    args.push('-join', joinUrl, dd);
  }
  const proc = spawn(RQLITED_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc._logs = [];
  proc.stdout.on('data', (d) => { proc._logs.push(`[${nodeId}] ${d.toString().trim()}`); });
  proc.stderr.on('data', (d) => { proc._logs.push(`[${nodeId}:err] ${d.toString().trim()}`); });
  return proc;
}

async function stopProc (proc, name) {
  if (proc == null) return;
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode == null) proc.kill('SIGKILL');
    }, 5000).unref();
  });
}

async function waitForReady (httpUrl, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(httpUrl + '/readyz');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`rqlited at ${httpUrl} did not become ready within ${timeoutMs}ms`);
}

async function waitForClusterSize (httpUrl, expectedSize, timeoutMs) {
  const start = Date.now();
  let lastStatus = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(httpUrl + '/nodes');
      if (res.ok) {
        const body = await res.json();
        const size = Object.keys(body).length;
        lastStatus = body;
        if (size >= expectedSize) {
          const allReachable = Object.values(body).every(n => n.reachable === true);
          if (allReachable) return;
        }
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`cluster did not reach size ${expectedSize} within ${timeoutMs}ms; last /nodes=${JSON.stringify(lastStatus)}`);
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function dumpLogs (proc, name) {
  if (proc == null || proc._logs == null) return;
  console.log(`--- last 40 log lines of ${name} ---`);
  for (const line of proc._logs.slice(-40)) console.log(line);
  console.log(`--- exit code: ${proc.exitCode} ---`);
}
