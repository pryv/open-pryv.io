/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * rqlited logs while it takes its snapshot-on-close. When its stdout / stderr
 * were pipes read by the master, a master that exited first left rqlited
 * writing to a closed pipe: rqlited died of SIGPIPE in the middle of the
 * snapshot. Its output must survive the master, and `stop()` must wait for it
 * to exit, killing it only after a generous delay, loudly.
 *
 * The fake `rqlited` answers /readyz and /status, and on SIGTERM "snapshots"
 * for a moment, logs to stdout and stderr (a write to a closed pipe throws
 * EPIPE and kills it, like SIGPIPE kills rqlited), then records that it
 * closed cleanly.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/rqliteProcess.ts');

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function isAlive (pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor (cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return cond();
}

/**
 * A fake rqlited. `onTerm`: 'snapshot' (log for a while, then exit 0) or
 * 'ignore' (never exit on SIGTERM).
 */
function writeFake (dir, name, onTerm) {
  const bin = path.join(dir, name);
  const closedFile = path.join(dir, name + '.closed');
  const pidFile = path.join(dir, name + '.pid');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    "const http = require('node:http');",
    "const fs = require('node:fs');",
    "const i = process.argv.indexOf('-http-addr');",
    "const [host, port] = process.argv[i + 1].split(':');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ os: { pid: process.pid } })); }).listen(Number(port), host);",
    onTerm === 'ignore'
      ? "process.on('SIGTERM', () => {});"
      : [
          "fs.writeSync(1, 'fake-rqlited started\\n');",
          "process.on('SIGTERM', () => {",
          '  server.close();',
          '  setTimeout(() => {',
          "    for (let n = 0; n < 50; n++) { fs.writeSync(1, 'snapshot-on-close line ' + n + '\\n'); fs.writeSync(2, 'store line ' + n + '\\n'); }",
          // the last output line first: a test reads the log once the marker exists
          "    fs.writeSync(1, 'fake-rqlited closed\\n');",
          `    fs.writeFileSync(${JSON.stringify(closedFile)}, 'clean');`,
          '    process.exit(0);',
          '  }, 300);',
          '});'
        ].join('\n'),
    ''
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  return { bin, closedFile, pidFile };
}

/**
 * Runs a driver process that starts rqliteProcess, then exits at once without
 * stopping it (as a master that does not wait). Resolves when the driver's
 * stdout and stderr are closed, i.e. every process writing to them is gone.
 */
async function runDriverThatExitsEarly (dir, fake, extraOpts = '') {
  const httpPort = await freePort();
  const driver = path.join(dir, 'driver-' + path.basename(fake.bin) + '.cjs');
  fs.writeFileSync(driver, [
    `const rp = require(${JSON.stringify(SRC)});`,
    'rp.start({',
    "  coreId: 'rqou',",
    `  binPath: ${JSON.stringify(fake.bin)},`,
    `  dataDir: ${JSON.stringify(path.join(dir, 'data-' + path.basename(fake.bin)))},`,
    `  httpPort: ${httpPort},`,
    `  raftPort: ${httpPort + 1},`,
    '  readyTimeoutMs: 10000,',
    extraOpts,
    '  log: () => {}',
    '}).then(() => process.exit(0), (err) => { console.error(err); process.exit(2); });',
    ''
  ].join('\n'));
  const p = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const [code] = await Promise.all([
    new Promise((resolve) => p.on('exit', resolve)),
    new Promise((resolve) => p.stdout.on('end', resolve)),
    new Promise((resolve) => p.stderr.on('end', resolve))
  ]);
  return { code, out, err };
}

describe('[RQOU] rqlited output and stop do not depend on the master', function () {
  this.timeout(30000);

  let dir;
  const fakes = [];

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqou-'));
  });

  after(() => {
    for (const f of fakes) {
      try {
        const pid = Number(fs.readFileSync(f.pidFile, 'utf8'));
        if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL');
      } catch { /* never started */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('[RQO1] by default rqlited writes to the master\'s own output and finishes closing after the master exits', async () => {
    const fake = writeFake(dir, 'fake-inherit', 'snapshot');
    fakes.push(fake);
    const { code, out, err } = await runDriverThatExitsEarly(dir, fake);
    assert.equal(code, 0, 'the driver reached its process.exit(0) after rqlited was ready: ' + err);
    assert.ok(await waitFor(() => fs.existsSync(fake.closedFile), 5000),
      'rqlited (fake) must complete its close after the master exited, not die on a closed pipe');
    assert.match(out, /fake-rqlited started/);
    assert.match(out, /snapshot-on-close line 49/);
    assert.match(out, /fake-rqlited closed/);
    assert.match(err, /store line 49/);
  });

  it('[RQO2] with logFile, rqlited appends its output to that file', async () => {
    const fake = writeFake(dir, 'fake-file', 'snapshot');
    fakes.push(fake);
    const logFile = path.join(dir, 'logs', 'rqlited.log');
    const { code, out } = await runDriverThatExitsEarly(dir, fake, `  logFile: ${JSON.stringify(logFile)},`);
    assert.equal(code, 0);
    assert.ok(await waitFor(() => fs.existsSync(fake.closedFile), 5000),
      'rqlited (fake) must complete its close after the master exited');
    const logged = fs.readFileSync(logFile, 'utf8');
    assert.match(logged, /fake-rqlited started/);
    assert.match(logged, /snapshot-on-close line 49/);
    assert.match(logged, /store line 49/);
    assert.match(logged, /fake-rqlited closed/);
    assert.doesNotMatch(out, /snapshot-on-close/, 'nothing goes to the master output');
  });

  it('[RQO3] stop() resolves only once rqlited has exited', async () => {
    const rp = require(SRC);
    const fake = writeFake(dir, 'fake-slow', 'snapshot');
    fakes.push(fake);
    const httpPort = await freePort();
    await rp.start({
      coreId: 'rqou3',
      binPath: fake.bin,
      dataDir: path.join(dir, 'data3'),
      httpPort,
      raftPort: httpPort + 1,
      readyTimeoutMs: 10000,
      logFile: path.join(dir, 'rqo3.log'),
      log: () => {}
    });
    const pid = Number(fs.readFileSync(fake.pidFile, 'utf8'));
    const errors = [];
    await rp.stop(() => {}, (msg) => errors.push(msg));
    assert.ok(fs.existsSync(fake.closedFile), 'the snapshot-on-close completed before stop() resolved');
    assert.equal(isAlive(pid), false);
    assert.equal(rp.isRunning(), false);
    assert.deepEqual(errors, []);
  });

  it('[RQO4] stop() kills an rqlited that does not exit in time and logs an error', async () => {
    const rp = require(SRC);
    const fake = writeFake(dir, 'fake-stuck', 'ignore');
    fakes.push(fake);
    const httpPort = await freePort();
    await rp.start({
      coreId: 'rqou4',
      binPath: fake.bin,
      dataDir: path.join(dir, 'data4'),
      httpPort,
      raftPort: httpPort + 1,
      readyTimeoutMs: 10000,
      logFile: path.join(dir, 'rqo4.log'),
      log: () => {}
    });
    const pid = Number(fs.readFileSync(fake.pidFile, 'utf8'));
    const errors = [];
    const t0 = Date.now();
    await rp.stop(() => {}, (msg) => errors.push(msg), 500);
    assert.ok(Date.now() - t0 >= 450, 'SIGKILL only after the timeout');
    assert.equal(isAlive(pid), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /rqlited did not stop within 0\.5s, killed: its snapshot may be incomplete/);
  });

  it('[RQTW4] start() of a multi-core node without Raft TLS logs the warning and keeps the HTTP API on loopback', async () => {
    const rp = require(SRC);
    const fake = writeFake(dir, 'fake-warn', 'snapshot');
    fakes.push(fake);
    const httpPort = await freePort();
    const warnings = [];
    const logged = [];
    await rp.start({
      coreId: 'rqtw4',
      binPath: fake.bin,
      dataDir: path.join(dir, 'data-tw4'),
      httpPort,
      raftPort: httpPort + 1,
      coreIp: '127.0.0.1',
      tls: null,
      readyTimeoutMs: 10000,
      logFile: path.join(dir, 'rqtw4.log'),
      log: (msg) => logged.push(msg),
      warn: (msg) => warnings.push(msg)
    });
    try {
      assert.equal(warnings.filter((w) => /without Raft TLS/.test(w)).length, 1, JSON.stringify(warnings));
      assert.ok(logged.some((l) => l.includes(`-http-addr 127.0.0.1:${httpPort}`)), JSON.stringify(logged));
    } finally {
      await rp.stop(() => {});
    }
  });

  it('[RQO5] the default kill delay leaves room for a slow snapshot', () => {
    const { STOP_KILL_TIMEOUT_MS } = require(SRC);
    assert.equal(STOP_KILL_TIMEOUT_MS, 20000);
  });
});
