/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * rqlited must not outlive the process that spawned it. A master that leaves
 * through `process.exit()` (a failed boot check, a config validation error)
 * without calling `stop()` used to leave rqlited running on the data dir, so
 * the next master found a second writer on the same files.
 *
 * A driver process starts rqliteProcess against a fake `rqlited` (a node HTTP
 * server answering /readyz that records its pid), then calls
 * `process.exit(1)` right away. The fake must be gone shortly after.
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

describe('[RQEX] rqlited does not outlive its parent', function () {
  this.timeout(20000);

  let dir, fakeBin, driver, pidFile, fakePid;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqex-'));
    pidFile = path.join(dir, 'fake.pid');
    fakeBin = path.join(dir, 'fake-rqlited');
    fs.writeFileSync(fakeBin, [
      '#!/usr/bin/env node',
      "const http = require('node:http');",
      "const fs = require('node:fs');",
      "const i = process.argv.indexOf('-http-addr');",
      "const [host, port] = process.argv[i + 1].split(':');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'http.createServer((req, res) => { res.writeHead(200); res.end(); }).listen(Number(port), host);',
      "process.on('SIGTERM', () => process.exit(0));",
      ''
    ].join('\n'));
    fs.chmodSync(fakeBin, 0o755);
  });

  after(() => {
    if (fakePid && isAlive(fakePid)) process.kill(fakePid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('[RQE1] process.exit() in the parent terminates the rqlited child', async () => {
    const httpPort = await freePort();
    driver = path.join(dir, 'driver.cjs');
    fs.writeFileSync(driver, [
      `const rp = require(${JSON.stringify(SRC)});`,
      'rp.start({',
      "  coreId: 'rqex',",
      `  binPath: ${JSON.stringify(fakeBin)},`,
      `  dataDir: ${JSON.stringify(path.join(dir, 'data'))},`,
      `  httpPort: ${httpPort},`,
      `  raftPort: ${httpPort + 1},`,
      '  readyTimeoutMs: 10000,',
      '  log: () => {}',
      '}).then(() => process.exit(1), (err) => { console.error(err); process.exit(2); });',
      ''
    ].join('\n'));

    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [driver], { stdio: ['ignore', 'ignore', 'inherit'] });
      p.on('exit', resolve);
    });
    assert.equal(code, 1, 'the driver reached its process.exit(1) after rqlited was ready');

    fakePid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(fakePid > 0);
    const deadline = Date.now() + 5000;
    while (isAlive(fakePid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(isAlive(fakePid), false, 'rqlited (fake) must be terminated when its parent exits');
  });
});
