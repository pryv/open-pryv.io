/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Two-core integration tests.
 *
 * Boots two real service-core instances (child processes) with a shared
 * rqlite PlatformDB and a DNS server. Verifies end-to-end multi-core flows:
 * registration, PlatformDB replication, DNS resolution, cross-core redirect.
 *
 * Sequential — manages child processes and rqlite lifecycle.
 *
 * Requires: rqlited binary at bin-ext/rqlited
 */

const assert = require('node:assert');
const { fork } = require('node:child_process');
const path = require('node:path');
const dns = require('node:dns');
const rqliteProcess = require('../../../storages/engines/rqlite/src/rqliteProcess.ts');
const { createDnsServer } = require('dns-server/src/index.ts');
const { DBrqlite } = require('../../../storages/engines/rqlite/src/DBrqlite.ts');
const { childStorageEngineEnv } = require('test-helpers');
const { getConfigUnsafe } = require('@pryv/boiler');

const SERVICE_CORE_ROOT = path.resolve(__dirname, '../../../');
const CORE_PROCESS = path.resolve(__dirname, 'helpers/core-process.js');
const RQLITE_BIN = path.resolve(SERVICE_CORE_ROOT, 'bin-ext/rqlited');

// Several checkouts of this repository may run their suites at once on one
// machine, each on its own PostgreSQL port (5432, 5433, ...). This suite's
// ports and temp paths follow the same offset, in steps of 100, so two such
// runs never meet. The PostgreSQL port is the reference because no test
// overrides it (parallel workers move rqlite, not PostgreSQL). The canonical
// setup (5432) keeps offset 0 and the historical names.
function workspaceOffsetFrom (config) {
  const pgPort = Number(config.get('storages:engines:postgresql:port'));
  const index = pgPort - 5432;
  return Number.isInteger(index) && index > 0 && index < 50 ? index : 0;
}
const WORKSPACE_OFFSET = workspaceOffsetFrom(getConfigUnsafe(true));
const PORT_SHIFT = WORKSPACE_OFFSET * 100;
const TMP_SUFFIX = WORKSPACE_OFFSET === 0 ? '' : '-' + (WORKSPACE_OFFSET + 1);

const DOMAIN = 'test-2core.pryv.li';
const ADMIN_KEY = 'test-2core-admin-key';
const RQLITE_PORT = 14001 + PORT_SHIFT;
const RQLITE_RAFT_PORT = 14002 + PORT_SHIFT;
const RQLITE_URL = `http://localhost:${RQLITE_PORT}`;
const RQLITE_DATA_DIR = '/tmp/rqlite-2core-test' + TMP_SUFFIX;
const RQLITE_LOG_FILE = '/tmp/rqlite-2core-test' + TMP_SUFFIX + '.log';
const CORE_A_PORT = 13000 + PORT_SHIFT;
const CORE_B_PORT = 13010 + PORT_SHIFT;
const CORE_A_ID = 'core-a';
const CORE_B_ID = 'core-b';
const CORE_A_IP = '127.0.0.1';
const CORE_B_IP = '127.0.0.2';
const CORE_C_PORT = 13020 + PORT_SHIFT;
// Each core's hosting: a registration posted with `hosting` is placed on that
// core (an un-pinned one goes to the core with the fewest users, a tie being
// decided by the platform row order).
const CORE_A_HOSTING = 'hosting-a';
const CORE_B_HOSTING = 'hosting-b';
const CORE_A_URL = `http://127.0.0.1:${CORE_A_PORT}/`;
const CORE_B_URL = `http://127.0.0.1:${CORE_B_PORT}/`;
// Each core's own user data (`CORE_DATA_NAME` of core-process.js): database
// `pryv-node-test-<name>`, directory `var-pryv/users-<name>`. The platform
// store (the rqlite below) is shared, as on a real cluster.
const CORE_A_DATA = '2core-a';
const CORE_B_DATA = '2core-b';
const CORE_C_DATA = '2core-c';
const CORE_DATA_NAMES = [CORE_A_DATA, CORE_B_DATA, CORE_C_DATA];
// Hosted sites: `sitehome` on both cores, `siteonly` on core A only (core B
// must still refuse it as a username, from core A's advertisement).
const SITE_DIR = '/tmp/rg2c-hosted-site' + TMP_SUFFIX;
const SITE_BOTH = 'sitehome';
const SITE_A_ONLY = 'siteonly';

// Helper: HTTP request (no external deps)
async function httpRequest (port, method, path, body, headers = {}) {
  const url = `http://127.0.0.1:${port}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

// Helper: GET with an explicit Host header (fetch does not let a caller set Host)
function getWithHost (port, reqPath, host) {
  return new Promise((resolve, reject) => {
    const r = require('node:http').request({ host: '127.0.0.1', port, path: reqPath, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

// Helper: fork a core child process
function startCore (env) {
  return new Promise((resolve, reject) => {
    const child = fork(CORE_PROCESS, [], {
      cwd: SERVICE_CORE_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        // Same storage engines as this test process (a `--sqlite` run
        // must run the cores on SQLite too).
        ...childStorageEngineEnv(),
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Core ${env.CORE_ID} did not start within 30s`));
    }, 30000);
    child.on('message', (msg) => {
      if (msg.type === 'ready') {
        clearTimeout(timeout);
        child.readyInfo = msg;
        resolve(child);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Core ${env.CORE_ID} exited with code ${code}`));
      }
    });
    // Pipe child output for debugging
    child.stdout.on('data', (d) => {
      if (process.env.LOGS) process.stdout.write(`[${env.CORE_ID}] ${d}`);
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(`[${env.CORE_ID}:err] ${d.toString()}`);
    });
  });
}

function usesPostgres () {
  const config = getConfigUnsafe(true);
  return ['base', 'series', 'file', 'audit'].some((kind) => config.get('storages:' + kind + ':engine') === 'postgresql');
}

// Drop (and with `create`, recreate empty) every core's own user data. An
// empty database is all a core needs: it creates its schema on first connect.
async function resetCoresData (create) {
  const fs = require('node:fs');
  for (const name of CORE_DATA_NAMES) {
    fs.rmSync(path.resolve(SERVICE_CORE_ROOT, 'var-pryv/users-' + name), { recursive: true, force: true });
  }
  if (!usesPostgres()) return;
  const { Client } = require('pg');
  const pg = getConfigUnsafe(true).get('storages:engines:postgresql');
  const client = new Client({ host: pg.host, port: pg.port, user: pg.user, password: pg.password || undefined, database: 'postgres' });
  await client.connect();
  try {
    for (const name of CORE_DATA_NAMES) {
      // Not in a transaction: CREATE DATABASE refuses to run inside one.
      await client.query(`DROP DATABASE IF EXISTS "pryv-node-test-${name}" WITH (FORCE)`);
      if (create) await client.query(`CREATE DATABASE "pryv-node-test-${name}"`);
    }
  } finally {
    await client.end();
  }
}

// `child.killed` only says a signal was sent; the exit code or signal says the
// process is gone.
function hasExited (child) {
  return child.exitCode != null || child.signalCode != null;
}

function stopCore (child) {
  return new Promise((resolve) => {
    if (!child || hasExited(child)) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!hasExited(child)) child.kill('SIGKILL');
    }, 5000).unref();
  });
}

describe('[RG2C] Two-core integration tests', function () {
  this.timeout(120000);

  let coreA, coreB;
  let dnsServer, dnsPort, resolver;
  let platformDB;
  let savedIntegrityCheck;

  // --- Setup: rqlite + DNS + two cores ---

  before(async function () {
    // Disable integrity checks — child cores use rqlite PlatformDB
    // which the parent's SQLite-based check cannot see.
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    // Check rqlite binary exists
    const fs = require('node:fs');
    if (!fs.existsSync(RQLITE_BIN)) {
      console.log('rqlited binary not found, skipping 2-core tests');
      this.skip();
    }

    // Each core's own, empty, user data (first: a PostgreSQL failure then
    // leaves nothing running)
    await resetCoresData(true);

    // Start rqlite (single node)
    await rqliteProcess.start({
      coreId: 'test-node',
      binPath: RQLITE_BIN,
      dataDir: RQLITE_DATA_DIR,
      httpPort: RQLITE_PORT,
      raftPort: RQLITE_RAFT_PORT,
      dnsDomain: null,
      coreIp: null,
      // rqlited's own output: to a file, not the test runner's stdout.
      logFile: RQLITE_LOG_FILE,
      log: (msg) => { if (process.env.LOGS) console.log('[rqlite]', msg); }
    });

    // Init PlatformDB schema
    platformDB = new DBrqlite(RQLITE_URL);
    await platformDB.init();

    // Seed core info in PlatformDB so cores can find each other: each core
    // reads the other cores' URLs when it boots, before the other one has
    // registered itself, so the rows carry the URLs from the start.
    await seedCoreInfo(CORE_A_ID, CORE_A_IP, CORE_A_PORT, CORE_A_HOSTING);
    await seedCoreInfo(CORE_B_ID, CORE_B_IP, CORE_B_PORT, CORE_B_HOSTING);

    // Start DNS server (in-process, ephemeral port)
    // platformDB (DBrqlite) exposes getUserCore, getCoreInfo, getAllCoreInfos
    // directly — at the RAW engine level (no hashing). The real Platform
    // wrapper hashes the username for the user-core lookup when
    // platform.piiMode=hashed (the default since 2.0.0-rc.3), and
    // registration wrote the row under HMAC(username). So this mock must
    // apply the same hash before the raw engine lookup, otherwise it queries
    // the cleartext key and misses the hashed row ([2C20] ENOTFOUND). Mirror
    // Platform.hashFor('username', …) using the cluster pepper from config.
    // The cluster pepper is the one scripts/components-run exports as
    // platform__piiHmacKey — the same value the spawned child cores used when
    // they wrote the user-core rows. Absent it (cleartext opt-out), hashing
    // is identity.
    const { PiiHasher } = require('platform/src/PiiHasher.ts');
    const piiHmacKey = process.env.platform__piiHmacKey;
    const piiHasher = piiHmacKey ? new PiiHasher(piiHmacKey) : null;
    const hashUsername = (username) => piiHasher ? piiHasher.hashFor('username', username) : username;
    const mockPlatform = {
      async getUserCore (username) {
        return platformDB.getUserCore(hashUsername(username));
      },
      async getCoreInfo (coreId) {
        return platformDB.getCoreInfo(coreId);
      },
      async getAllCoreInfos () {
        return platformDB.getAllCoreInfos();
      }
    };
    const dnsConfig = {
      get (key) {
        const store = {
          'dns:domain': DOMAIN,
          'dns:active': true,
          'dns:defaultTTL': 5,
          'dns:staticEntries': {},
          'dns:records:root': { a: [CORE_A_IP] }
        };
        return store[key];
      }
    };
    const dnsLogger = {
      info () {},
      warn (msg) { if (process.env.LOGS) console.log('[dns:warn]', msg); },
      error (msg) { console.error('[dns:error]', msg); }
    };

    dnsServer = createDnsServer({ config: dnsConfig, platform: mockPlatform, logger: dnsLogger });
    await dnsServer.start({ port: 0, ip: '127.0.0.1', ip6: null });
    dnsPort = dnsServer._getAddresses().udp.port;

    resolver = new dns.promises.Resolver();
    resolver.setServers([`127.0.0.1:${dnsPort}`]);

    // The hosted site's folder (deployed on every core that serves it)
    fs.rmSync(SITE_DIR, { recursive: true, force: true });
    fs.mkdirSync(SITE_DIR, { recursive: true });
    fs.writeFileSync(path.join(SITE_DIR, 'index.html'), '<p>rg2c hosted site</p>');

    // Start Core A and Core B
    const coreEnv = {
      DNS_DOMAIN: DOMAIN,
      RQLITE_URL,
      ADMIN_KEY
    };

    coreA = await startCore({
      ...coreEnv,
      CORE_PORT: String(CORE_A_PORT),
      CORE_ID: CORE_A_ID,
      CORE_IP: CORE_A_IP,
      CORE_HOSTING: CORE_A_HOSTING,
      CORE_DATA_NAME: CORE_A_DATA,
      HOSTED_SITES_JSON: JSON.stringify({ [SITE_BOTH]: { static: SITE_DIR }, [SITE_A_ONLY]: { static: SITE_DIR } })
    });

    coreB = await startCore({
      ...coreEnv,
      CORE_PORT: String(CORE_B_PORT),
      CORE_ID: CORE_B_ID,
      CORE_IP: CORE_B_IP,
      CORE_HOSTING: CORE_B_HOSTING,
      CORE_DATA_NAME: CORE_B_DATA,
      HOSTED_SITES_JSON: JSON.stringify({ [SITE_BOTH]: { static: SITE_DIR } })
    });

    // The DNS server read the core-info rows before the cores registered
    await dnsServer.refreshFromPlatform();
  });

  after(async function () {
    await stopCore(coreA);
    await stopCore(coreB);
    if (dnsServer) await dnsServer.stop();
    await rqliteProcess.stop((msg) => {
      if (process.env.LOGS) console.log('[rqlite]', msg);
    });
    // Clean up rqlite data
    const fs = require('node:fs');
    fs.rmSync(RQLITE_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(SITE_DIR, { recursive: true, force: true });
    // The cores' own user data (their pools are closed: the cores stopped)
    await resetCoresData(false);
    // Restore integrity check setting
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  // --- Helper: seed core info in PlatformDB ---

  async function seedCoreInfo (coreId, ip, port, hosting) {
    await platformDB.setCoreInfo(coreId, { id: coreId, url: `http://127.0.0.1:${port}`, ip, ipv6: null, cname: null, hosting, available: true });
  }

  // --- Tests ---

  describe('Core startup verification', () => {
    it('[2C00] both cores run on the storage engine of this test run', () => {
      const expected = getConfigUnsafe(true).get('storages:base:engine');
      assert.ok(expected, 'the test process has a base engine');
      assert.strictEqual(coreA.readyInfo.baseEngine, expected, 'core A');
      assert.strictEqual(coreB.readyInfo.baseEngine, expected, 'core B');
      // Multi-core nodes, each advertising its own URL (a single-core node
      // would take the local path for every cross-core call)
      // and each on its own user data, on this checkout's ports (shifted by
      // 100 per PostgreSQL port above 5432, so parallel checkouts never meet)
      const shift = workspaceOffsetFrom(getConfigUnsafe(true)) * 100;
      for (const [core, base] of [[coreA, 13000], [coreB, 13010]]) {
        assert.strictEqual(core.readyInfo.port, base + shift, core.readyInfo.coreId);
        assert.strictEqual(core.readyInfo.rqliteUrl, `http://localhost:${14001 + shift}`, core.readyInfo.coreId);
      }
      for (const [core, port, data] of [[coreA, CORE_A_PORT, CORE_A_DATA], [coreB, CORE_B_PORT, CORE_B_DATA]]) {
        assert.strictEqual(core.readyInfo.isSingleCore, false, core.readyInfo.coreId);
        assert.strictEqual(core.readyInfo.coreUrl, `http://127.0.0.1:${port}`, core.readyInfo.coreId);
        assert.strictEqual(core.readyInfo.pgDatabase, 'pryv-node-test-' + data, core.readyInfo.coreId);
        assert.strictEqual(core.readyInfo.sqlitePath, path.resolve(SERVICE_CORE_ROOT, 'var-pryv/users-' + data), core.readyInfo.coreId);
      }
    });

    it('[2C01] both cores must respond to HTTP requests', async () => {
      const resA = await httpRequest(CORE_A_PORT, 'GET', '/reg/service/info');
      assert.strictEqual(resA.status, 200, 'Core A must respond 200');

      const resB = await httpRequest(CORE_B_PORT, 'GET', '/reg/service/info');
      assert.strictEqual(resB.status, 200, 'Core B must respond 200');
    });

    it('[2C02] both cores must share the same PlatformDB', async () => {
      // Both cores see the seeded core-info entries
      const resA = await httpRequest(CORE_A_PORT, 'GET', '/system/admin/cores', null, {
        Authorization: ADMIN_KEY
      });
      const resB = await httpRequest(CORE_B_PORT, 'GET', '/system/admin/cores', null, {
        Authorization: ADMIN_KEY
      });
      assert.strictEqual(resA.status, 200, 'Core A admin/cores must respond 200');
      assert.strictEqual(resB.status, 200, 'Core B admin/cores must respond 200');

      const coresA = (resA.body.cores || []).map(c => c.id).sort();
      const coresB = (resB.body.cores || []).map(c => c.id).sort();
      assert.deepStrictEqual(coresA, coresB,
        'Both cores must see the same set of cores in PlatformDB');
    });

    it('[2C03] each core resolves both cores to the URLs they listen on', async () => {
      for (const port of [CORE_A_PORT, CORE_B_PORT]) {
        const res = await httpRequest(port, 'GET', '/system/admin/cores', null, { Authorization: ADMIN_KEY });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const urlOf = (id) => (res.body.cores || []).find((c) => c.id === id)?.url;
        assert.strictEqual(urlOf(CORE_A_ID), CORE_A_URL, 'core A seen from port ' + port);
        assert.strictEqual(urlOf(CORE_B_ID), CORE_B_URL, 'core B seen from port ' + port);
      }
    });
  });

  describe('Registration + PlatformDB replication', () => {
    const testUser = 'tc' + Date.now().toString(36);
    const testEmail = testUser + '@test.example.com';
    let registration;

    // In a hook, not in [2C10] itself: the tests below need the user even when
    // a --grep selects them without [2C10].
    before(async () => {
      registration = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username: testUser,
        password: 'testpassw0rd',
        email: testEmail,
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_A_HOSTING
      });
    });

    it('[2C10] must register a user on Core A', async () => {
      // Accept 201 (created) or 200
      assert.ok(registration.status === 201 || registration.status === 200,
        `Expected 200/201 but got ${registration.status}: ${JSON.stringify(registration.body)}`);
    });

    it('[2C11] Core B must see the user via /reg/cores lookup', async () => {
      const res = await httpRequest(CORE_B_PORT, 'GET', `/reg/cores?username=${testUser}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.core, `Core B should return core URL for ${testUser}`);
    });

    it('[2C12] admin/users on Core A must list the user', async () => {
      const res = await httpRequest(CORE_A_PORT, 'GET', '/system/admin/users', null, {
        Authorization: ADMIN_KEY
      });
      assert.strictEqual(res.status, 200);
      const users = res.body.users || res.body;
      const found = Array.isArray(users) && users.some(u => u.username === testUser);
      assert.ok(found, `User ${testUser} should appear in admin/users on Core A`);
    });

    it('[2C13] an account posted to Core A for Core B\'s hosting lives in Core B\'s data only; Core A answers 421 for it', async () => {
      const username = 'tcb' + Date.now().toString(36);
      const res = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_B_HOSTING
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const token = new URL(res.body.apiEndpoint).username;
      // Each core lists the accounts of its own user data
      const listed = async (port) => {
        const users = await httpRequest(port, 'GET', '/system/admin/users', null, { Authorization: ADMIN_KEY });
        assert.strictEqual(users.status, 200, JSON.stringify(users.body));
        return (users.body.users || users.body).some((u) => u.username === username);
      };
      assert.strictEqual(await listed(CORE_A_PORT), false, 'not in Core A\'s data');
      assert.strictEqual(await listed(CORE_B_PORT), true, 'in Core B\'s data');
      // Core A sends the client to Core B; Core B serves it
      const onA = await httpRequest(CORE_A_PORT, 'GET', '/' + username + '/access-info', null, { Authorization: token });
      assert.strictEqual(onA.status, 421, JSON.stringify(onA.body));
      assert.strictEqual(onA.body.error.id, 'wrong-core');
      assert.strictEqual(onA.body.error.coreUrl, CORE_B_URL);
      const onB = await httpRequest(CORE_B_PORT, 'GET', '/' + username + '/access-info', null, { Authorization: token });
      assert.strictEqual(onB.status, 200, JSON.stringify(onB.body));
    });
  });

  describe('DNS resolution', () => {
    const dnsUser = 'dnsuser' + Date.now().toString(36);

    before(async () => {
      // Register user on Core B so PlatformDB maps user → core-b
      await httpRequest(CORE_B_PORT, 'POST', '/users', {
        appId: 'test-dns',
        username: dnsUser,
        password: 'testpassw0rd',
        email: dnsUser + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_B_HOSTING
      });
    });

    it('[2C20] DNS must resolve username to correct core IP', async () => {
      const addresses = await resolver.resolve4(`${dnsUser}.${DOMAIN}`);
      assert.strictEqual(addresses.length, 1);
      assert.strictEqual(addresses[0], CORE_B_IP,
        `DNS should resolve ${dnsUser} to Core B IP (${CORE_B_IP})`);
    });

    it('[2C21] DNS must resolve lsc.{domain} to all core IPs', async () => {
      const addresses = await resolver.resolve4(`lsc.${DOMAIN}`);
      assert.strictEqual(addresses.length, 2);
      assert.deepStrictEqual(addresses.sort(), [CORE_A_IP, CORE_B_IP].sort());
    });
  });

  describe('Hosted sites', () => {
    // Pinned to the core it is posted to, so that core refuses it itself
    async function register (port, username) {
      return httpRequest(port, 'POST', '/users', {
        appId: 'test-2core-sites',
        username,
        password: 'testpassw0rd',
        email: username + '-' + Date.now().toString(36) + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: port === CORE_A_PORT ? CORE_A_HOSTING : CORE_B_HOSTING
      });
    }

    it('[2C40] DNS answers a site with every core that advertises it', async () => {
      const both = await resolver.resolve4(`${SITE_BOTH}.${DOMAIN}`);
      assert.deepStrictEqual(both.sort(), [CORE_A_IP, CORE_B_IP].sort());
      const onlyA = await resolver.resolve4(`${SITE_A_ONLY}.${DOMAIN}`);
      assert.deepStrictEqual(onlyA, [CORE_A_IP]);
    });

    it('[2C41] each core serves the folder on the site Host; the API still answers', async () => {
      for (const port of [CORE_A_PORT, CORE_B_PORT]) {
        const site = await getWithHost(port, '/', `${SITE_BOTH}.${DOMAIN}`);
        assert.strictEqual(site.status, 200, `core on ${port}`);
        assert.strictEqual(site.body, '<p>rg2c hosted site</p>');
        const api = await httpRequest(port, 'GET', '/reg/service/info');
        assert.strictEqual(api.status, 200, `API on ${port}`);
      }
    });

    it('[2C42] both cores refuse a site name as a username, including one only the other core serves', async () => {
      for (const [port, name] of [[CORE_A_PORT, SITE_BOTH], [CORE_B_PORT, SITE_BOTH], [CORE_B_PORT, SITE_A_ONLY]]) {
        const res = await register(port, name);
        assert.strictEqual(res.status, 409, `${name} on ${port}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error.id, 'item-already-exists');
      }
    });

    it('[2C43] a core whose site folder is missing does not start', async () => {
      await assert.rejects(() => startCore({
        DNS_DOMAIN: DOMAIN,
        RQLITE_URL,
        ADMIN_KEY,
        CORE_PORT: String(CORE_C_PORT),
        CORE_ID: 'core-c',
        CORE_IP: '127.0.0.3',
        CORE_DATA_NAME: CORE_C_DATA,
        HOSTED_SITES_JSON: JSON.stringify({ [SITE_BOTH]: { static: SITE_DIR + '-missing' } })
      }), /exited with code 1/);
    });

    it('[2C44] a core whose site name is another core\'s id does not start', async () => {
      let started = null;
      try {
        try {
          started = await startCore({
            DNS_DOMAIN: DOMAIN,
            RQLITE_URL,
            ADMIN_KEY,
            CORE_PORT: String(CORE_C_PORT),
            CORE_ID: 'core-c',
            CORE_IP: '127.0.0.3',
            CORE_DATA_NAME: CORE_C_DATA,
            HOSTED_SITES_JSON: JSON.stringify({ [CORE_B_ID]: { static: SITE_DIR } })
          });
        } catch (err) {
          assert.match(err.message, /exited with code 1/);
        }
        if (started != null) {
          await stopCore(started);
          assert.fail('core-c must refuse a site named after core-b');
        }
        // core-b's own name still resolves to core-b, even if core-c's row
        // (written before its boot check refused) advertises that name
        await dnsServer.refreshFromPlatform();
        assert.deepStrictEqual(await resolver.resolve4(`${CORE_B_ID}.${DOMAIN}`), [CORE_B_IP]);
      } finally {
        // core-c's row stays behind, with a URL nobody listens on and no
        // users: the least-loaded core, where every later registration that
        // names no hosting would be forwarded. Take it out of the selection.
        const row = await platformDB.getCoreInfo('core-c');
        if (row != null) await platformDB.setCoreInfo('core-c', { ...row, available: false });
      }
    });
  });

  describe('Admin endpoints across cores', () => {
    it('[2C30] /system/admin/cores must list both cores', async () => {
      const res = await httpRequest(CORE_A_PORT, 'GET', '/system/admin/cores', null, {
        Authorization: ADMIN_KEY
      });
      assert.strictEqual(res.status, 200);
      const cores = res.body.cores || res.body;
      assert.ok(Array.isArray(cores), 'Expected array of cores');
      const ids = cores.map(c => c.id).sort();
      assert.ok(ids.includes(CORE_A_ID), 'Core A should be listed');
      assert.ok(ids.includes(CORE_B_ID), 'Core B should be listed');
    });

    it('[2C31] /reg/hostings must reflect available cores', async () => {
      const res = await httpRequest(CORE_A_PORT, 'GET', '/reg/hostings');
      assert.strictEqual(res.status, 200);
      // In multi-core, hostings should have available cores
      assert.ok(res.body.regions || res.body.hostings || typeof res.body === 'object',
        'Expected hostings response');
    });
  });

  describe('External ids across cores', () => {
    const ns = 'ehr-2c-' + Date.now().toString(36);

    it('[2C50] a namespace created through Core A is visible through Core B, without its salt', async () => {
      const created = await httpRequest(CORE_A_PORT, 'PUT', '/system/admin/ext-id-ns/' + ns, { label: 'Two-core EHR' }, { Authorization: ADMIN_KEY });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const seen = await httpRequest(CORE_B_PORT, 'GET', '/system/admin/ext-id-ns/' + ns, null, { Authorization: ADMIN_KEY });
      assert.strictEqual(seen.status, 200, JSON.stringify(seen.body));
      assert.strictEqual(seen.body.namespace.label, 'Two-core EHR');
      assert.ok(!JSON.stringify(seen.body).includes('salt'));
    });

    it('[2C51] an id held by Core B resolves to Core B from either core; an unclaimed one is 404', async () => {
      // Seed the claim as Core B would write it (same derivation, same pepper).
      const crypto = require('node:crypto');
      const { PiiHasher } = require('platform/src/PiiHasher.ts');
      const { tokensFor } = require('platform/src/externalIdIndex.ts');
      const pepper = process.env.platform__piiHmacKey;
      const handle = { hashFor: (field, value) => pepper ? new PiiHasher(pepper).hashFor(field, value) : value };
      const nsRow = JSON.parse(await platformDB.getPlatformKv('ext-id-ns/' + ns));
      const value = crypto.randomBytes(32).toString('base64url');
      const t = tokensFor(handle, nsRow, value);
      assert.strictEqual(await platformDB.claimCoreRow('ext-id/', t.nsToken + '/' + t.valueToken, CORE_B_ID), true);

      for (const port of [CORE_A_PORT, CORE_B_PORT]) {
        // Core B's URL as THIS core resolves it (each core resolves its own
        // URL from its config, the others from the platform rows).
        const cores = await httpRequest(port, 'GET', '/system/admin/cores', null, { Authorization: ADMIN_KEY });
        const coreBUrl = (cores.body.cores || cores.body).find((c) => c.id === CORE_B_ID).url;
        const res = await httpRequest(port, 'POST', '/reg/ext-id/cores', { namespace: ns, blindedValue: value });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.server, coreBUrl, 'routed to core B from port ' + port);
      }
      const unclaimed = await httpRequest(CORE_A_PORT, 'POST', '/reg/ext-id/cores', { namespace: ns, blindedValue: crypto.randomBytes(32).toString('base64url') });
      assert.strictEqual(unclaimed.status, 404);
    });

    // A per-user call on a core: Host `<username>.<domain>`, personal token.
    function userCall (port, user, method, reqPath, body) {
      return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const r = require('node:http').request({
          host: '127.0.0.1',
          port,
          method,
          path: reqPath,
          headers: { host: user.username + '.' + DOMAIN, authorization: user.token, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) }
        }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => {
            let json;
            try { json = JSON.parse(text); } catch { json = text; }
            resolve({ status: res.statusCode, body: json });
          });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
      });
    }

    // The account is created on the core it is posted to (pinned by hosting)
    async function registerOn (port, username) {
      const res = await httpRequest(port, 'POST', '/users', {
        appId: 'test-2core-xid',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: port === CORE_A_PORT ? CORE_A_HOSTING : CORE_B_HOSTING
      });
      assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
      return { username, token: new URL(res.body.apiEndpoint).username };
    }

    it('[2C52] a claim on Core B of an id held on Core A is refused (409 value-taken) and leaves nothing on B', async () => {
      const crypto = require('node:crypto');
      const onA = await registerOn(CORE_A_PORT, 'xida' + Date.now().toString(36));
      const onB = await registerOn(CORE_B_PORT, 'xidb' + Date.now().toString(36));
      const value = crypto.randomBytes(32).toString('base64url');
      const claimA = await userCall(CORE_A_PORT, onA, 'POST', '/account/external-ids', { namespace: ns, blindedValue: value });
      assert.strictEqual(claimA.status, 201, JSON.stringify(claimA.body));
      const claimB = await userCall(CORE_B_PORT, onB, 'POST', '/account/external-ids', { namespace: ns, blindedValue: value });
      assert.strictEqual(claimB.status, 409, JSON.stringify(claimB.body));
      assert.deepStrictEqual(claimB.body.error.data, { namespace: ns, reason: 'value-taken' });
      const listB = await userCall(CORE_B_PORT, onB, 'GET', '/account/external-ids');
      assert.deepStrictEqual(listB.body.externalIds, []);
      const listA = await userCall(CORE_A_PORT, onA, 'GET', '/account/external-ids');
      assert.deepStrictEqual(listA.body.externalIds.map((x) => x.namespace), [ns]);
    });

    it('[2C53] a registration landing on Core A and forwarded to Core B links the id there; a refusal keeps its data', async () => {
      const crypto = require('node:crypto');
      // Every other core unavailable for the time of the test: Core A must forward to Core B.
      const others = (await platformDB.getAllCoreInfos()).filter((c) => c.id !== CORE_B_ID);
      for (const c of others) await platformDB.setCoreInfo(c.id, { ...c, available: false });
      try {
        const value = crypto.randomBytes(32).toString('base64url');
        const username = 'xidfw' + Date.now().toString(36);
        const res = await httpRequest(CORE_A_PORT, 'POST', '/users', {
          appId: 'test-2core-xid',
          username,
          password: 'testpassw0rd',
          email: username + '@test.example.com',
          insurancenumber: String(Math.floor(Math.random() * 900) + 100),
          language: 'en',
          externalId: { namespace: ns, blindedValue: value }
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.externalIdLinked, true);
        const coresOnB = await httpRequest(CORE_B_PORT, 'GET', '/system/admin/cores', null, { Authorization: ADMIN_KEY });
        const coreBUrl = (coresOnB.body.cores || coresOnB.body).find((c) => c.id === CORE_B_ID).url;
        const found = await httpRequest(CORE_B_PORT, 'POST', '/reg/ext-id/cores', { namespace: ns, blindedValue: value });
        assert.strictEqual(found.body.server, coreBUrl, 'the account and its id live on Core B');

        const refused = await httpRequest(CORE_A_PORT, 'POST', '/users', {
          appId: 'test-2core-xid',
          username: username + 'r',
          password: 'testpassw0rd',
          email: username + 'r@test.example.com',
          insurancenumber: String(Math.floor(Math.random() * 900) + 100),
          language: 'en',
          // Forced, with the id just linked: the target core refuses it.
          externalId: { namespace: ns, blindedValue: value, mode: 'forced' }
        });
        assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
        assert.deepStrictEqual(refused.body.error.data, { namespace: ns, reason: 'value-taken' }, 'the target core\'s error data reaches the client');
      } finally {
        for (const c of others) await platformDB.setCoreInfo(c.id, c);
      }
    });

    it('[2C54] an auth request created on Core B carries the external id to the auth page', async () => {
      const crypto = require('node:crypto');
      const value = crypto.randomBytes(32).toString('base64url');
      const created = await httpRequest(CORE_B_PORT, 'POST', '/reg/access', {
        requestingAppId: 'test-2core-xid', requestedPermissions: [{ streamId: 'diary', level: 'read' }], externalId: { namespace: ns, blindedValue: value }
      });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      assert.deepStrictEqual(created.body.externalId, { namespace: ns, mode: 'hint' });
      const poll = await httpRequest(CORE_B_PORT, 'GET', '/reg/access/' + created.body.key);
      assert.deepStrictEqual(poll.body.externalId, { namespace: ns, label: 'Two-core EHR', blindedValue: value, mode: 'hint' });
    });

    it('[2C55] a registration on Core A of an id Core B holds creates the account unlinked, with no row on A', async () => {
      const crypto = require('node:crypto');
      const { PiiHasher } = require('platform/src/PiiHasher.ts');
      const { tokensFor } = require('platform/src/externalIdIndex.ts');
      const pepper = process.env.platform__piiHmacKey;
      const handle = { hashFor: (field, v) => pepper ? new PiiHasher(pepper).hashFor(field, v) : v };
      const value = crypto.randomBytes(32).toString('base64url');
      const t = tokensFor(handle, JSON.parse(await platformDB.getPlatformKv('ext-id-ns/' + ns)), value);
      assert.strictEqual(await platformDB.claimCoreRow('ext-id/', t.nsToken + '/' + t.valueToken, CORE_B_ID), true);
      // Every other core unavailable for the time of the test: Core A keeps the registration.
      const others = (await platformDB.getAllCoreInfos()).filter((c) => c.id !== CORE_A_ID);
      for (const c of others) await platformDB.setCoreInfo(c.id, { ...c, available: false });
      try {
        const username = 'xidun' + Date.now().toString(36);
        const res = await httpRequest(CORE_A_PORT, 'POST', '/users', {
          appId: 'test-2core-xid',
          username,
          password: 'testpassw0rd',
          email: username + '@test.example.com',
          insurancenumber: String(Math.floor(Math.random() * 900) + 100),
          language: 'en',
          externalId: { namespace: ns, blindedValue: value }
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.externalIdLinked, false);
        const list = await userCall(CORE_A_PORT, { username, token: new URL(res.body.apiEndpoint).username }, 'GET', '/account/external-ids');
        assert.deepStrictEqual(list.body.externalIds, []);
        assert.strictEqual(await platformDB.getCoreRow('ext-id/', t.nsToken + '/' + t.valueToken), CORE_B_ID, 'still held by Core B');
      } finally {
        for (const c of others) await platformDB.setCoreInfo(c.id, c);
      }
    });

    // A forced auth request on Core A, for an id held by an account of Core B:
    // only Core B's data can bind the posted token to the account and say who
    // holds the id, so Core A must ask Core B over HTTP (access-info with the
    // token, then /system/ext-id/holds with the admin key).
    describe('forced accept across cores', () => {
      const PERMISSIONS = [{ streamId: 'diary', level: 'read' }];
      let holder, other, value;

      async function accountOnB (prefix) {
        const user = await registerOn(CORE_B_PORT, prefix + Date.now().toString(36));
        const minted = await userCall(CORE_B_PORT, user, 'POST', '/accesses', { name: 'rg2c-app-' + user.username, type: 'app', permissions: PERMISSIONS });
        assert.strictEqual(minted.status, 201, JSON.stringify(minted.body));
        return { ...user, appToken: minted.body.access.token, apiEndpoint: `http://${user.token}@${user.username}.${DOMAIN}/` };
      }

      async function forcedRequest (port) {
        const created = await httpRequest(port, 'POST', '/reg/access', {
          requestingAppId: 'test-2core-xid', requestedPermissions: PERMISSIONS, externalId: { namespace: ns, blindedValue: value, mode: 'forced' }
        });
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
        return created.body.key;
      }

      function accept (port, key, who, token) {
        return httpRequest(port, 'POST', '/reg/access/' + key, { status: 'ACCEPTED', username: who.username, token, apiEndpoint: who.apiEndpoint });
      }

      async function statusOf (port, key) {
        return (await httpRequest(port, 'GET', '/reg/access/' + key)).body.status;
      }

      before(async () => {
        const crypto = require('node:crypto');
        holder = await accountOnB('xidh');
        other = await accountOnB('xido');
        value = crypto.randomBytes(32).toString('base64url');
        const claimed = await userCall(CORE_B_PORT, holder, 'POST', '/account/external-ids', { namespace: ns, blindedValue: value });
        assert.strictEqual(claimed.status, 201, JSON.stringify(claimed.body));
      });

      it('[2C56] the holder\'s accept on Core A is checked on Core B and delivered', async () => {
        const key = await forcedRequest(CORE_A_PORT);
        const res = await accept(CORE_A_PORT, key, holder, holder.appToken);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.status, 'ACCEPTED');
        assert.strictEqual(res.body.token, holder.appToken);
        assert.strictEqual(await statusOf(CORE_A_PORT, key), 'ACCEPTED');
        // The same accept on Core B, the holder's core, takes the local check
        const keyOnB = await forcedRequest(CORE_B_PORT);
        const onB = await accept(CORE_B_PORT, keyOnB, holder, holder.appToken);
        assert.strictEqual(onB.status, 200, JSON.stringify(onB.body));
        assert.strictEqual(onB.body.token, holder.appToken);
      });

      it('[2C57] on Core A, a non-holder of Core B is refused and a forced registration of the held id creates nothing', async () => {
        const key = await forcedRequest(CORE_A_PORT);
        // Another account of Core B, accepting as itself: not the holder
        const notHolder = await accept(CORE_A_PORT, key, other, other.appToken);
        assert.strictEqual(notHolder.status, 400, JSON.stringify(notHolder.body));
        assert.strictEqual(notHolder.body.error.id, 'external-id-mismatch');
        assert.deepStrictEqual(notHolder.body.error.data, { namespace: ns, reason: 'not-holder' });
        // Naming the holder with a token of its own: Core B does not bind it
        const wrongToken = await accept(CORE_A_PORT, key, holder, other.appToken);
        assert.strictEqual(wrongToken.status, 400, JSON.stringify(wrongToken.body));
        assert.deepStrictEqual(wrongToken.body.error.data, { namespace: ns, reason: 'token-invalid' });
        assert.strictEqual(await statusOf(CORE_A_PORT, key), 'NEED_SIGNIN', 'the request is unchanged');

        const username = 'xidfr' + Date.now().toString(36);
        const registered = await httpRequest(CORE_A_PORT, 'POST', '/users', {
          appId: 'test-2core-xid',
          username,
          password: 'testpassw0rd',
          email: username + '@test.example.com',
          insurancenumber: String(Math.floor(Math.random() * 900) + 100),
          language: 'en',
          hosting: CORE_A_HOSTING,
          externalId: { namespace: ns, blindedValue: value, mode: 'forced' }
        });
        assert.strictEqual(registered.status, 409, JSON.stringify(registered.body));
        assert.strictEqual(registered.body.error.id, 'external-id-already-claimed');
        assert.deepStrictEqual(registered.body.error.data, { namespace: ns, reason: 'value-taken' });
        const users = await httpRequest(CORE_A_PORT, 'GET', '/system/admin/users', null, { Authorization: ADMIN_KEY });
        assert.ok(!(users.body.users || users.body).some((u) => u.username === username), 'no account on Core A');
        const lookup = await httpRequest(CORE_A_PORT, 'GET', `/reg/cores?username=${username}`);
        assert.notStrictEqual(lookup.status, 200, 'no account on the platform: ' + JSON.stringify(lookup.body));
      });
    });
  });

  // Last: it stops Core B.
  describe('Core B down', () => {
    it('[2C58] a registration Core A forwards to an unreachable Core B answers 503, not a 500', async () => {
      await stopCore(coreB);
      const username = 'tcdown' + Date.now().toString(36);
      const res = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_B_HOSTING
      });
      assert.strictEqual(res.status, 503, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'cross-core-registration-failed');
      assert.ok(!JSON.stringify(res.body).includes(String(CORE_B_PORT)), 'the answer does not name the other core');
      const lookup = await httpRequest(CORE_A_PORT, 'GET', `/reg/cores?username=${username}`);
      assert.notStrictEqual(lookup.status, 200, 'no account on the platform: ' + JSON.stringify(lookup.body));
    });
  });
});
