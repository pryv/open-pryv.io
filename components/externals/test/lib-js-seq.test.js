/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Integration test: runs lib-js test suite against local API + HFS servers.
 *
 * Architecture (mirrors production nginx setup):
 *   HTTPS proxy (:3000, backloop.dev) -> API server (HTTP :3001)
 *                                     -> HFS server (HTTP :4000) for /events/x/series
 *
 * Test files are required directly - mocha flags (--grep, --reporter, -b) work normally.
 *
 * Prerequisites:
 *   cd external-ressources/lib-js && npm install
 *
 * Skipped automatically if lib-js is not cloned or not installed.
 */

const path = require('node:path');
const fs = require('node:fs');
const { execSync, spawn } = require('node:child_process');

const LIB_JS_DIR = path.resolve(__dirname, '../../../external-ressources/lib-js');
const SERVICE_CORE_DIR = path.resolve(__dirname, '../../../');
const API_SERVER_BIN = path.resolve(__dirname, '../../api-server/bin/server');
const HFS_SERVER_BIN = path.resolve(__dirname, '../../hfs-server/bin/server');
const PROXY_BIN = path.resolve(__dirname, 'proxy.js');
const OVERRIDE_SRC = path.resolve(__dirname, '../../../config/libjs-test-config.yml');
const OVERRIDE_DST = path.resolve(__dirname, '../../../config/override-config.yml');

const PROXY_PORT = 3000; // HTTPS — what lib-js connects to
const API_PORT = 3001; // HTTP — API server (plain, behind proxy)
const HFS_PORT = 4000; // HTTP — HFS server
const SERVER_URL = 'https://l.backloop.dev:' + PROXY_PORT + '/';

function libJsAvailable () {
  return fs.existsSync(path.join(LIB_JS_DIR, 'node_modules'));
}

if (!libJsAvailable()) {
  describe('[ELJS] lib-js integration', function () {
    it('SKIPPED — lib-js not installed (run: cd external-ressources/lib-js && npm install)', function () {
      this.skip();
    });
  });
} else {
  // --- Setup env before any lib-js require ---
  process.env.TEST_PRYVLIB_DNSLESS_URL = SERVER_URL;

  const childProcesses = [];

  // Start API + HFS + proxy before all tests
  before(async function () {
    this.timeout(30000);
    fs.copyFileSync(OVERRIDE_SRC, OVERRIDE_DST);

    // Kill any leftover servers on our ports (including tcp_pubsub broker)
    for (const port of [PROXY_PORT, API_PORT, HFS_PORT, 4222]) {
      try { execSync('fuser -k ' + port + '/tcp 2>/dev/null || true', { stdio: 'ignore' }); } catch (e) { /* */ }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 1. API server (HTTP, no SSL — proxy handles HTTPS)
    childProcesses.push(spawn(process.execPath, [API_SERVER_BIN], {
      cwd: SERVICE_CORE_DIR,
      env: { ...process.env, NODE_ENV: 'development', PRYV_BOILER_SUFFIX: '-libjs-api' },
      stdio: 'ignore'
    }));

    // 2. HFS server (HTTP)
    childProcesses.push(spawn(process.execPath, [HFS_SERVER_BIN], {
      cwd: SERVICE_CORE_DIR,
      env: { ...process.env, NODE_ENV: 'development', PRYV_BOILER_SUFFIX: '-libjs-hfs' },
      stdio: 'ignore'
    }));

    // 3. HTTPS proxy (backloop.dev, routes series→HFS, rest→API)
    childProcesses.push(spawn(process.execPath, [PROXY_BIN, '' + PROXY_PORT, '' + API_PORT, '' + HFS_PORT], {
      cwd: SERVICE_CORE_DIR,
      stdio: 'ignore'
    }));

    // Wait for API server to be ready (plain HTTP, no SSL)
    await waitForServer('http://127.0.0.1:' + API_PORT + '/', 20000);
    // Wait for proxy to be ready (it sits in front of everything)
    await waitForServer(SERVER_URL + 'reg/service/info', 30000);
  });

  // Stop all child processes after tests
  after(function (done) {
    try { fs.unlinkSync(OVERRIDE_DST); } catch (e) { /* */ }
    let remaining = childProcesses.length;
    if (remaining === 0) return done();
    let settled = false;
    for (const proc of childProcesses) {
      proc.on('exit', () => { if (--remaining === 0 && !settled) { settled = true; done(); } });
      proc.kill('SIGTERM');
    }
    setTimeout(() => {
      for (const proc of childProcesses) {
        try { proc.kill('SIGKILL'); } catch (e) { /* */ }
      }
      if (!settled) { settled = true; done(); }
    }, 3000).unref();
  });

  // Change CWD to lib-js root so relative paths (e.g. ./test/Y.png) resolve correctly
  process.chdir(path.join(LIB_JS_DIR, 'components/pryv'));

  // --- Load lib-js globals (expect, pryv, testData) ---
  require(path.join(LIB_JS_DIR, 'test/load-helpers'));

  // --- Load pryv component tests ---
  loadTestFiles('pryv');

  // --- Load pryv-socket.io add-on + tests ---
  require(path.join(LIB_JS_DIR, 'components/pryv-socket.io/src'))(global.pryv);
  loadTestFiles('pryv-socket.io');

  // --- Load pryv-monitor add-on + tests ---
  require(path.join(LIB_JS_DIR, 'components/pryv-monitor/src'))(global.pryv);

  // Set up monitor globals (unique stream per run)
  const { createId: cuid } = require('@paralleldrive/cuid2');
  const monTestStreamId = global.testStreamId = 'mon-' + cuid().slice(0, 8);
  global.prepareAndCreateBaseStreams = async () => {
    await global.testData.prepare();
    global.apiEndpoint = global.testData.apiEndpointWithToken;
    global.conn = new global.pryv.Connection(global.apiEndpoint);
    const res = await global.conn.api([{
      method: 'streams.create',
      params: { id: monTestStreamId, name: monTestStreamId }
    }]);
    if (!res[0].stream && (!res[0].error || res[0].error.id !== 'item-already-exists')) {
      throw new Error('Failed creating monitor stream: ' + JSON.stringify(res[0].error));
    }
  };
  loadTestFiles('pryv-monitor');
}

function loadTestFiles (component) {
  const testDir = path.join(LIB_JS_DIR, 'components', component, 'test');
  if (!fs.existsSync(testDir)) return;
  fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .forEach(f => require(path.join(testDir, f)));
}

function waitForServer (url, timeoutMs) {
  const mod = url.startsWith('https') ? require('node:https') : require('node:http');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt () {
      if (Date.now() > deadline) return reject(new Error('Server not ready after ' + timeoutMs + 'ms'));
      const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
        res.on('data', () => {});
        res.on('end', () => res.statusCode === 200 ? resolve() : setTimeout(attempt, 500));
      });
      req.on('error', () => setTimeout(attempt, 500));
      req.end();
    })();
  });
}
