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
 * lib-js is provisioned automatically on first run: cloned into
 * `external-ressources/lib-js` + `npm install`ed when missing. A failed
 * provisioning fails the suite — it never skips.
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

// Ports are overridable so the suite can coexist with other local servers
const PROXY_PORT = parseInt(process.env.EXTERNALS_PROXY_PORT || '3000', 10); // HTTPS — what lib-js connects to
const API_PORT = parseInt(process.env.EXTERNALS_API_PORT || '3001', 10); // HTTP — API server (plain, behind proxy)
const HFS_PORT = parseInt(process.env.EXTERNALS_HFS_PORT || '4000', 10); // HTTP — HFS server
const SERVER_URL = 'https://l.backloop.dev:' + PROXY_PORT + '/';

function libJsAvailable () {
  return fs.existsSync(path.join(LIB_JS_DIR, 'node_modules'));
}

// Provision lib-js on the fly so the integration suite always runs.
// Synchronous on purpose: the suite's test files are require()d at module
// load below, so the checkout must exist before this module finishes
// loading. One-time cost per checkout; a failure here fails the suite.
function provisionLibJs () {
  if (!fs.existsSync(path.join(LIB_JS_DIR, '.git'))) {
    console.log('[ELJS] lib-js not found — cloning into external-ressources/ …');
    fs.mkdirSync(path.dirname(LIB_JS_DIR), { recursive: true });
    execSync('git clone --depth 1 https://github.com/pryv/lib-js.git lib-js', {
      cwd: path.dirname(LIB_JS_DIR), stdio: 'inherit'
    });
  }
  console.log('[ELJS] installing lib-js dependencies …');
  execSync('npm install --no-audit --no-fund', { cwd: LIB_JS_DIR, stdio: 'inherit' });
}

if (!libJsAvailable()) {
  provisionLibJs();
}

{
  // --- Setup env before any lib-js require ---
  process.env.TEST_PRYVLIB_DNSLESS_URL = SERVER_URL;

  const childProcesses = [];

  // Start API + HFS + proxy before all tests
  before(async function () {
    this.timeout(60000);
    let overlay = fs.readFileSync(OVERRIDE_SRC, 'utf8');
    overlay = overlay
      .replace('port: 3001', 'port: ' + API_PORT + '\n  hfsPort: ' + HFS_PORT)
      .replaceAll('l.backloop.dev:3000', 'l.backloop.dev:' + PROXY_PORT);
    fs.writeFileSync(OVERRIDE_DST, overlay);

    // Kill leftover servers of OUR OWN from a previous run (including tcp_pubsub
    // broker); fail fast if a port is held by a foreign process instead.
    for (const port of [PROXY_PORT, API_PORT, HFS_PORT, 4222]) {
      killOwnLeftoverOnPort(port);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Child output goes to log files — boot failures are undiagnosable otherwise
    const logFd = (name) => fs.openSync('/tmp/externals-' + name + '.log', 'w');

    // 1. API server (HTTP, no SSL — proxy handles HTTPS)
    childProcesses.push(spawn(process.execPath, [API_SERVER_BIN], {
      cwd: SERVICE_CORE_DIR,
      env: { ...process.env, NODE_ENV: 'development', PRYV_BOILER_SUFFIX: '-libjs-api' },
      stdio: ['ignore', logFd('api'), logFd('api-err')]
    }));

    // 2. HFS server (HTTP)
    childProcesses.push(spawn(process.execPath, [HFS_SERVER_BIN], {
      cwd: SERVICE_CORE_DIR,
      env: { ...process.env, NODE_ENV: 'development', PRYV_BOILER_SUFFIX: '-libjs-hfs' },
      stdio: ['ignore', logFd('hfs'), logFd('hfs-err')]
    }));

    // 3. HTTPS proxy (backloop.dev, routes series→HFS, rest→API)
    childProcesses.push(spawn(process.execPath, [PROXY_BIN, '' + PROXY_PORT, '' + API_PORT, '' + HFS_PORT], {
      cwd: SERVICE_CORE_DIR,
      stdio: ['ignore', logFd('proxy'), logFd('proxy-err')]
    }));

    // Wait for API server to be ready (plain HTTP, no SSL)
    await waitForServer('http://127.0.0.1:' + API_PORT + '/', 20000);
    // Wait for HFS server too (any HTTP response means it is listening)
    await waitForServer('http://127.0.0.1:' + HFS_PORT + '/', 30000, true);
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

function waitForServer (url, timeoutMs, anyResponse) {
  const mod = url.startsWith('https') ? require('node:https') : require('node:http');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt () {
      if (Date.now() > deadline) return reject(new Error('Server not ready after ' + timeoutMs + 'ms: ' + url));
      const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
        res.on('data', () => {});
        res.on('end', () => (anyResponse || res.statusCode === 200) ? resolve() : setTimeout(attempt, 500));
      });
      req.on('error', () => setTimeout(attempt, 500));
      req.end();
    })();
  });
}

/**
 * Kill a leftover child of a previous run still listening on the port
 * (identified by its command line referencing this repository checkout).
 * Throws if the port is held by a foreign process — killing it blindly
 * (the previous `fuser -k`, Linux-only) could take down unrelated dev
 * servers; pick other ports via EXTERNALS_*_PORT instead.
 */
function killOwnLeftoverOnPort (port) {
  let out = '';
  try {
    out = execSync('lsof -ti :' + port, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) { return; } // no listener on that port
  for (const pidStr of out.trim().split('\n').filter(Boolean)) {
    const pid = parseInt(pidStr, 10);
    let command = '';
    try {
      command = execSync('ps -o command= -p ' + pid, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch (e) { continue; } // already gone
    if (command.includes(SERVICE_CORE_DIR)) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    } else {
      throw new Error('Port ' + port + ' is in use by a foreign process (pid ' + pid + ': ' + command + '). ' +
        'Free the port or set EXTERNALS_PROXY_PORT / EXTERNALS_API_PORT / EXTERNALS_HFS_PORT.');
    }
  }
}
