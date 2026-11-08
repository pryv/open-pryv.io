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
 * Requires: rqlited binary at bin-ext/rqlited (the suite fails without it,
 * unless SKIP_2CORE=1 is set to skip it explicitly).
 */

const assert = require('node:assert');
const { fork } = require('node:child_process');
const path = require('node:path');
const dns = require('node:dns');
const rqliteProcess = require('../../../storages/engines/rqlite/src/rqliteProcess.ts');
const { createDnsServer } = require('dns-server/src/index.ts');
const { DBrqlite } = require('../../../storages/engines/rqlite/src/DBrqlite.ts');
const { childStorageEngineEnv } = require('test-helpers');
const { requireRqlited } = require('test-helpers/src/requireRqlited.ts');
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
// Registry OAuth clients on Core A
const OAUTH_CONSENT_URL = 'https://consent.2core.test/authorize';
const OAUTH_REDIRECT = 'https://app.2core.test/redirect';
const OAUTH_AUD = 'https://resource.2core.test/';
// Client metadata documents: the document host the cores reach through the
// suite's stub server (its port follows the workspace offset).
const METADATA_HOST = 'client.example';
const METADATA_STUB_PORT = 13030 + PORT_SHIFT;
const METADATA_CONFIG = {
  mode: 'allowList',
  allowedHosts: [METADATA_HOST],
  client: { scope: 'read/notes', allowedAudiences: [OAUTH_AUD], subjectType: 'public' }
};

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

// Helper: any request with an explicit Host header; a JSON body when given
function requestWithHost (port, method, reqPath, host, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const allHeaders = { host, ...headers, ...(payload != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) };
    const r = require('node:http').request({ host: '127.0.0.1', port, method, path: reqPath, headers: allHeaders }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { json = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    r.on('error', reject);
    r.end(payload);
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
  let coreAEnv, coreBEnv;
  let dnsServer, dnsPort, resolver;
  let platformDB;
  let savedIntegrityCheck;
  let adapterUpstream;
  const adapterSeen = [];

  // --- Setup: rqlite + DNS + two cores ---

  before(async function () {
    // Disable integrity checks — child cores use rqlite PlatformDB
    // which the parent's SQLite-based check cannot see.
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    // No rqlited: fail (a silent skip reads green), unless SKIP_2CORE=1
    const fs = require('node:fs');
    requireRqlited(RQLITE_BIN, this, '[RG2C] two-core tests');

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

    // The sidecar of an adapter route, shared by both cores: records what it receives
    adapterUpstream = require('node:http').createServer((req, res) => {
      adapterSeen.push({ method: req.method, url: req.url, headers: req.headers });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"upstream":true}');
      });
    });
    await new Promise((resolve) => adapterUpstream.listen(0, '127.0.0.1', resolve));

    // Start Core A and Core B
    const coreEnv = {
      DNS_DOMAIN: DOMAIN,
      RQLITE_URL,
      ADMIN_KEY,
      // A queued CMC notice is due in half a second, the loop ticks often
      CMC_RETRY_INTERVAL_MS: '300',
      CMC_DELIVERY_BACKOFF_BASE_MS: '500',
      CMC_PEERS_VIA_PLATFORM: '1',
      // OAuth registry clients (toy grammar), for the OAuth tests below
      OAUTH_TOY_EXTENSION: '1',
      // Client metadata documents, for the tests below
      CLIENT_METADATA_HOST: METADATA_HOST,
      CLIENT_METADATA_STUB: `http://127.0.0.1:${METADATA_STUB_PORT}`,
      CLIENT_METADATA_CONFIG_JSON: JSON.stringify(METADATA_CONFIG),
      // An adapter route, for the per-user address tests below
      ADAPTER_ROUTES_JSON: JSON.stringify({ calendar: { upstream: `http://127.0.0.1:${adapterUpstream.address().port}` } })
    };

    coreAEnv = {
      ...coreEnv,
      CORE_PORT: String(CORE_A_PORT),
      CORE_ID: CORE_A_ID,
      CORE_IP: CORE_A_IP,
      CORE_HOSTING: CORE_A_HOSTING,
      CORE_DATA_NAME: CORE_A_DATA,
      HOSTED_SITES_JSON: JSON.stringify({ [SITE_BOTH]: { static: SITE_DIR }, [SITE_A_ONLY]: { static: SITE_DIR } }),
      // The consent page of the aliases across cores below
      OAUTH_CONSENT_URL,
      // The per-user issuer, on Core A only ([OPIS8])
      OAUTH_PER_USER_ISSUER: '1'
    };
    coreA = await startCore(coreAEnv);

    coreBEnv = {
      ...coreEnv,
      CORE_PORT: String(CORE_B_PORT),
      CORE_ID: CORE_B_ID,
      CORE_IP: CORE_B_IP,
      CORE_HOSTING: CORE_B_HOSTING,
      CORE_DATA_NAME: CORE_B_DATA,
      HOSTED_SITES_JSON: JSON.stringify({ [SITE_BOTH]: { static: SITE_DIR } })
    };
    coreB = await startCore(coreBEnv);

    // The DNS server read the core-info rows before the cores registered
    await dnsServer.refreshFromPlatform();
  });

  after(async function () {
    await stopCore(coreA);
    await stopCore(coreB);
    if (dnsServer) await dnsServer.stop();
    if (adapterUpstream != null) {
      adapterUpstream.closeAllConnections();
      await new Promise((resolve) => adapterUpstream.close(resolve));
    }
    await rqliteProcess.stop((msg) => {
      if (process.env.LOGS) console.log('[rqlite]', msg);
    });
    // Clean up rqlite data
    const fs = require('node:fs');
    fs.rmSync(RQLITE_DATA_DIR, { recursive: true, force: true });
    // rqlited's log too, unless the run asked for logs (kept to read then)
    if (!process.env.LOGS) fs.rmSync(RQLITE_LOG_FILE, { force: true });
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

    it('[OPUR1] a core\'s static entry and issuer label are refused as usernames by another core, at registration and rename', async () => {
      let coreC = null;
      try {
        coreC = await startCore({
          DNS_DOMAIN: DOMAIN,
          RQLITE_URL,
          ADMIN_KEY,
          CORE_PORT: String(CORE_C_PORT),
          CORE_ID: 'core-c',
          CORE_IP: '127.0.0.3',
          CORE_DATA_NAME: CORE_C_DATA,
          STATIC_ENTRIES_JSON: JSON.stringify({ 'svc-c': { a: ['127.0.0.9'] } }),
          OAUTH_ISSUER: `https://auth-c.${DOMAIN}`
        });
        const row = await platformDB.getCoreInfo('core-c');
        assert.deepStrictEqual(row.dnsNames, ['auth-c', 'svc-c']);
        for (const name of ['svc-c', 'auth-c']) {
          const res = await register(CORE_B_PORT, name);
          assert.strictEqual(res.status, 409, `${name} on core B: ${JSON.stringify(res.body)}`);
          assert.strictEqual(res.body.error.id, 'item-already-exists');
        }
        const holder = 'opur' + Date.now().toString(36);
        const reg = await register(CORE_B_PORT, holder);
        assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
        const token = new URL(reg.body.apiEndpoint).username;
        for (const name of ['svc-c', 'auth-c']) {
          const res = await httpRequest(CORE_B_PORT, 'POST', '/' + holder + '/account/change-username', { newUsername: name }, { Authorization: token });
          assert.strictEqual(res.status, 400, `${name}: ${JSON.stringify(res.body)}`);
          assert.match(JSON.stringify(res.body), /reserved/);
        }
        // Core B's username rewriter (the same predicate as the per-user OAuth binding) now
        // reads both names as platform hosts: the path is not hoisted into a username.
        const answer = async (host) => {
          const res = await getWithHost(CORE_B_PORT, '/service/info', host);
          let body;
          try { body = JSON.parse(res.body); } catch { body = res.body; }
          if (body != null && typeof body === 'object') delete body.meta;
          return [res.status, body];
        };
        const root = await answer('127.0.0.1');
        const asUser = await answer(`opurnobody${Date.now().toString(36)}.${DOMAIN}`);
        assert.notDeepStrictEqual(asUser, root, 'the control host is read as a username');
        for (const name of ['svc-c', 'auth-c']) assert.deepStrictEqual(await answer(`${name}.${DOMAIN}`), root, name);
      } finally {
        await stopCore(coreC);
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

  describe('Aliases across cores', () => {
    const owner = 'tcal' + Date.now().toString(36);
    let ownerToken, clientId, session, alias, staticAlias;

    // An OAuth session of a pairwise registry client on Core A: its grant's
    // alias, minted on Core A, is what the app addresses the account by.
    before(async () => {
      const reg = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username: owner,
        password: 'testpassw0rd',
        email: owner + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_A_HOSTING
      });
      assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
      ownerToken = new URL(reg.body.apiEndpoint).username;
      const st = await httpRequest(CORE_A_PORT, 'POST', '/' + owner + '/streams', { id: 'health', name: 'health' }, { Authorization: ownerToken });
      assert.strictEqual(st.status, 201, JSON.stringify(st.body));

      clientId = 'Mc.' + Date.now().toString(36);
      const oauth2 = require('oauth2');
      await oauth2.persistClient(platformDB, {
        clientId,
        kind: 'registry',
        redirectUris: [OAUTH_REDIRECT],
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethod: 'none',
        allowedAudiences: [OAUTH_AUD],
        subjectType: 'pairwise',
        scope: ['read/health', 'ctx/user']
      });
      const crypto = require('node:crypto');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: OAUTH_REDIRECT,
        response_type: 'code',
        state: 'csrf-2c',
        scope: 'read/health ctx/user',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        aud: OAUTH_AUD
      });
      const auth = await fetch(`http://127.0.0.1:${CORE_A_PORT}/oauth2/authorize?${query}`, { redirect: 'manual' });
      assert.strictEqual(auth.status, 302, await auth.text());
      const loc = auth.headers.get('location');
      assert.ok(loc.startsWith(OAUTH_CONSENT_URL + '?state='), loc);
      const state = new URL(loc).searchParams.get('state');
      const offer = await httpRequest(CORE_A_PORT, 'POST', '/oauth2/authorize/offer', { state });
      assert.strictEqual(offer.status, 200, JSON.stringify(offer.body));
      const accept = await httpRequest(CORE_A_PORT, 'POST', '/oauth2/authorize/accept', {
        state, username: owner, userToken: ownerToken, grantedPermissions: offer.body.offer.permissions
      });
      assert.strictEqual(accept.status, 200, JSON.stringify(accept.body));
      const code = new URL(accept.body.redirectTo).searchParams.get('code');
      const tok = await fetch(`http://127.0.0.1:${CORE_A_PORT}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: OAUTH_REDIRECT }).toString()
      });
      const token = await tok.json();
      assert.strictEqual(tok.status, 200, JSON.stringify(token));
      session = token.access_token;
      alias = token.user;
      assert.match(alias, /^r-[a-z0-9]{8}$/);
      // And an alias a plain access asked for (randomAlias), minted the same way.
      const plain = await httpRequest(CORE_A_PORT, 'POST', '/' + owner + '/accesses',
        { name: 'tcal-shared', randomAlias: true, permissions: [{ streamId: 'health', level: 'read' }] }, { Authorization: ownerToken });
      assert.strictEqual(plain.status, 201, JSON.stringify(plain.body));
      staticAlias = plain.body.access.alias;
    });

    after(async () => {
      try { await require('oauth2/src/storage.ts').deleteClient(platformDB, clientId); } catch (_) { /* best-effort */ }
    });

    it('[2C75] an OAuth session is served at its alias on its home core, and refused at the username there', async () => {
      const onA = await httpRequest(CORE_A_PORT, 'GET', '/' + alias + '/access-info', null, { Authorization: session });
      assert.strictEqual(onA.status, 200, JSON.stringify(onA.body));
      assert.strictEqual(onA.body.user.username, alias);
      assert.ok(!JSON.stringify(onA.body).includes(owner), JSON.stringify(onA.body));
      const atName = await httpRequest(CORE_A_PORT, 'GET', '/' + owner + '/access-info', null, { Authorization: session });
      assert.strictEqual(atName.status, 403, JSON.stringify(atName.body));
      assert.strictEqual(atName.body.error.id, 'invalid-access-token');
    });

    it('[2C76] the other core answers 421 with the home core for an alias, path and host style; the body names only the alias', async () => {
      for (const a of [alias, staticAlias]) {
        const onB = await httpRequest(CORE_B_PORT, 'GET', '/' + a + '/access-info', null, { Authorization: session });
        assert.strictEqual(onB.status, 421, JSON.stringify(onB.body));
        assert.strictEqual(onB.body.error.id, 'wrong-core');
        assert.strictEqual(onB.body.error.coreUrl, CORE_A_URL);
        assert.ok(!JSON.stringify(onB.body).includes(owner), JSON.stringify(onB.body));
        const byHost = await getWithHost(CORE_B_PORT, '/access-info', `${a}.${DOMAIN}`);
        assert.strictEqual(byHost.status, 421, byHost.body);
        assert.ok(!byHost.body.includes(owner), byHost.body);
      }
    });

    it('[2C77] DNS and /reg answer an alias with its home core', async () => {
      for (const a of [alias, staticAlias]) {
        const addresses = await resolver.resolve4(`${a}.${DOMAIN}`);
        assert.deepStrictEqual(addresses, [CORE_A_IP]);
        const reg = await httpRequest(CORE_B_PORT, 'POST', '/reg/' + a + '/server');
        assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
        assert.strictEqual(reg.body.server, CORE_A_URL);
        assert.strictEqual(reg.body.alias, `${a}.${DOMAIN}`);
      }
    });
  });

  describe('Adapter routes across cores', () => {
    const username = 'adrw' + Date.now().toString(36);
    let token;

    before(async () => {
      const reg = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_B_HOSTING
      });
      assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
      token = new URL(reg.body.apiEndpoint).username;
    });

    it('[ADRW2] a per-user address of the other core\'s account answers 421 with that core; its own core forwards it named; a former username keeps its address', async () => {
      const host = `${username}.${DOMAIN}`;
      const count = adapterSeen.length;
      const onA = await requestWithHost(CORE_A_PORT, 'POST', '/adapter/calendar/x', host, { a: 1 }, { authorization: 'Bearer t' });
      assert.strictEqual(onA.status, 421, JSON.stringify(onA.body));
      assert.strictEqual(onA.body.error.id, 'wrong-core');
      assert.strictEqual(onA.body.error.coreUrl, CORE_B_URL);
      assert.strictEqual(onA.headers.location, undefined);
      assert.strictEqual(onA.headers['retry-after'], '300');
      assert.match(onA.body.error.message, /retry the same address/);
      // Under another domain the name addresses no account: a platform address.
      const foreign = await requestWithHost(CORE_A_PORT, 'GET', '/adapter/calendar/x', `${username}.attacker.tld`);
      assert.strictEqual(foreign.status, 200, JSON.stringify(foreign.body));
      assert.strictEqual(adapterSeen.at(-1).headers['x-adapter-name'], undefined);
      assert.strictEqual(adapterSeen.length, count + 1, 'core A did not forward the 421 one');
      const onB = await requestWithHost(CORE_B_PORT, 'GET', '/adapter/calendar/x', host);
      assert.strictEqual(onB.status, 200, JSON.stringify(onB.body));
      assert.strictEqual(adapterSeen.at(-1).headers['x-adapter-name'], username);
      assert.strictEqual(adapterSeen.at(-1).headers['x-adapter-base'], `http://${host}/adapter/calendar/`);
      // A platform address on either core: forwarded, no account named.
      for (const port of [CORE_A_PORT, CORE_B_PORT]) {
        const res = await requestWithHost(port, 'GET', '/adapter/calendar/x', `reg.${DOMAIN}`);
        assert.strictEqual(res.status, 200, String(port));
        assert.strictEqual(adapterSeen.at(-1).headers['x-adapter-name'], undefined);
      }
      // Renamed: the former name stays the account's address, forwarded as addressed.
      const renamed = username + 'n';
      const change = await httpRequest(CORE_B_PORT, 'POST', '/' + username + '/account/change-username', { newUsername: renamed }, { Authorization: token });
      assert.strictEqual(change.status, 200, JSON.stringify(change.body));
      const former = await requestWithHost(CORE_B_PORT, 'GET', '/adapter/calendar/x', host);
      assert.strictEqual(former.status, 200, JSON.stringify(former.body));
      assert.strictEqual(adapterSeen.at(-1).headers['x-adapter-name'], username);
      assert.strictEqual(adapterSeen.at(-1).headers['x-adapter-base'], `http://${host}/adapter/calendar/`);
      const formerOnA = await requestWithHost(CORE_A_PORT, 'GET', '/adapter/calendar/x', host);
      assert.strictEqual(formerOnA.status, 421, JSON.stringify(formerOnA.body));
      assert.strictEqual(formerOnA.body.error.coreUrl, CORE_B_URL);
      const current = await requestWithHost(CORE_B_PORT, 'GET', '/adapter/calendar/x', `${renamed}.${DOMAIN}`);
      assert.strictEqual(current.status, 200);
      assert.strictEqual(adapterSeen.at(-1).headers['x-adapter-name'], renamed);
    });
  });

  describe('External ids across cores', () => {
    const ns = 'ehr-2c-' + Date.now().toString(36);

    // Every test of this block uses the namespace: created here, not by [2C50],
    // so a selection of the block's tests runs without it.
    before(async () => {
      const created = await httpRequest(CORE_A_PORT, 'PUT', '/system/admin/ext-id-ns/' + ns, { label: 'Two-core EHR' }, { Authorization: ADMIN_KEY });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    });

    it('[2C50] a namespace created through Core A is visible through Core B, without its salt', async () => {
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
  describe('Consent relationships across cores', () => {
    const APP = 'rg2c-app';
    const APP_ROOT = ':_cmc:apps:' + APP;

    async function register (port, hosting, prefix) {
      const username = prefix + Date.now().toString(36);
      const res = await httpRequest(port, 'POST', '/users', {
        appId: 'test-2core',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting
      });
      assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
      return { username, token: new URL(res.body.apiEndpoint).username };
    }
    function call (port, actor, method, resource, body) {
      return httpRequest(port, method, '/' + actor.username + '/' + resource, body, { Authorization: actor.token });
    }
    async function poll (fn, timeoutMs = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const v = await fn();
        if (v) return v;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    }
    // The access, null when there is none, undefined when the core did not answer the list.
    async function grantTo (port, owner, peerUsername) {
      const res = await call(port, owner, 'GET', 'accesses');
      if (res.status !== 200) return undefined;
      return (res.body?.accesses || []).find((a) => a?.clientData?.cmc?.counterparty?.username === peerUsername) ?? null;
    }

    it('[2C60] an account deleted while the counterparty\'s core is down: the revoke notice survives a restart and reaches the counterparty once its core is back', async () => {
      const alice = await register(CORE_A_PORT, CORE_A_HOSTING, 'cmca');
      const bob = await register(CORE_B_PORT, CORE_B_HOSTING, 'cmcb');
      const study = APP_ROOT + ':study-2c60';
      for (const [port, actor, streams] of [
        [CORE_A_PORT, alice, [{ id: APP_ROOT, parentId: ':_cmc:apps', name: APP }, { id: study, parentId: APP_ROOT, name: 'study' }]],
        [CORE_B_PORT, bob, [{ id: APP_ROOT, parentId: ':_cmc:apps', name: APP }, { id: 'diary', name: 'Diary' }]]
      ]) {
        for (const s of streams) {
          const res = await call(port, actor, 'POST', 'streams', s);
          assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        }
      }
      const offer = await call(CORE_A_PORT, alice, 'POST', 'events', {
        streamIds: [study],
        type: 'consent/request-cmc',
        content: {
          to: null,
          capabilityRequested: true,
          request: { title: { en: 'study' }, description: { en: 'two-core relationship' }, consent: { en: 'I consent.' }, permissions: [{ streamId: 'diary', level: 'read' }] },
          requesterMeta: { username: alice.username, appId: APP }
        }
      });
      assert.strictEqual(offer.status, 201, JSON.stringify(offer.body));
      const accept = await call(CORE_B_PORT, bob, 'POST', 'events', {
        streamIds: [APP_ROOT],
        type: 'consent/accept-cmc',
        content: { capabilityUrl: offer.body.event.content.capabilityUrl, accessName: 'rg2c-grant-' + Date.now() }
      });
      assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
      // The relationship is formed once the back-channel reached the accepter.
      const backChannel = await poll(async () => {
        const res = await call(CORE_B_PORT, bob, 'GET', 'events?streams[]=:_cmc:inbox&types[]=consent/back-channel-cmc');
        return (res.body?.events || []).find((e) => e.content?.from?.username === alice.username);
      });
      assert.ok(backChannel != null, 'premise: the relationship formed across the cores');
      const grant = await grantTo(CORE_B_PORT, bob, alice.username);
      assert.ok(grant != null, 'premise: the accepter holds the data grant given to the requester');

      await stopCore(coreB);
      const t0 = Date.now();
      const del = await httpRequest(CORE_A_PORT, 'DELETE', '/users/' + alice.username, null, { Authorization: ADMIN_KEY });
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));
      assert.ok(Date.now() - t0 < 15000, 'the deletion is not held by the unreachable core');
      // Core A restarts with the notice queued; then core B comes back.
      await stopCore(coreA);
      coreA = await startCore(coreAEnv);
      coreB = await startCore(coreBEnv);
      const gone = await poll(async () => (await grantTo(CORE_B_PORT, bob, alice.username)) === null);
      assert.ok(gone, 'the counterparty tore the relationship down');
    });
  });

  describe('OAuth sessions across cores', () => {
    const oauth2 = require('oauth2');
    const oauthStorage = require('oauth2/src/storage.ts');
    const { mintSecret } = require('oauth2/src/clientSecret.ts');
    const crypto = require('node:crypto');
    const REDIRECT = 'https://app.multicore.test/redirect';
    const appId = 'Mc.' + Date.now().toString(36);
    const rsId = 'McRs.' + Date.now().toString(36);
    let rsSecret, user, session;

    const trim = (url) => String(url).replace(/\/$/, '');

    // A form-less JSON call with HTTP Basic client authentication.
    function asResourceServer (port, path, body) {
      return httpRequest(port, 'POST', path, body, {
        Authorization: 'Basic ' + Buffer.from(rsId + ':' + rsSecret.plaintext).toString('base64')
      });
    }

    function registryRow (extra) {
      return {
        kind: 'registry',
        redirectUris: [REDIRECT],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'none',
        anyAudience: true,
        subjectType: 'public',
        scope: ['read/notes'],
        ...extra
      };
    }

    before(async () => {
      // A user on Core B (the home core of the session below)
      const username = 'tco' + Date.now().toString(36);
      const reg = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_B_HOSTING
      });
      assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
      user = { username, token: new URL(reg.body.apiEndpoint).username };
      const stream = await httpRequest(CORE_B_PORT, 'POST', '/' + username + '/streams', { id: 'notes', name: 'notes' }, { Authorization: user.token });
      assert.strictEqual(stream.status, 201, JSON.stringify(stream.body));
      // The operator CLI writes client rows to the shared platform store
      rsSecret = await mintSecret();
      await oauth2.persistClient(platformDB, registryRow({ clientId: appId }));
      await oauth2.persistClient(platformDB, registryRow({
        clientId: rsId, tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canIntrospect: true
      }));
      session = await newChain();
    });

    // Consent and code exchange on the home core: one refresh chain.
    async function newChain ({ resource, clientId = appId } = {}) {
      const username = user.username;
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        state: 'mc',
        scope: 'offline_access read/notes',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(resource != null ? { resource } : {})
      });
      const auth = await fetch(`http://127.0.0.1:${CORE_B_PORT}/oauth2/authorize?${q}`, { redirect: 'manual' });
      assert.strictEqual(auth.status, 302, await auth.text());
      const state = new URL(auth.headers.get('location')).searchParams.get('state');
      const offer = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/authorize/offer', { state });
      assert.strictEqual(offer.status, 200, JSON.stringify(offer.body));
      const accept = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/authorize/accept', {
        state, username, userToken: user.token, grantedPermissions: offer.body.offer.permissions
      });
      assert.strictEqual(accept.status, 200, JSON.stringify(accept.body));
      const code = new URL(accept.body.redirectTo).searchParams.get('code');
      const token = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/token', {
        grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT
      });
      assert.strictEqual(token.status, 200, JSON.stringify(token.body));
      return token.body;
    }

    after(async () => {
      for (const id of [appId, rsId]) {
        try { await oauthStorage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
      }
    });

    it('[2C70] introspection on the other core answers 421 with the home core\'s URL; the home core answers active', async () => {
      const onA = await asResourceServer(CORE_A_PORT, '/oauth2/introspect', { token: session.access_token });
      assert.strictEqual(onA.status, 421, JSON.stringify(onA.body));
      assert.strictEqual(onA.body.error, 'wrong_core');
      assert.strictEqual(trim(onA.body.coreUrl), trim(CORE_B_URL));
      const onB = await asResourceServer(CORE_B_PORT, '/oauth2/introspect', { token: session.access_token });
      assert.strictEqual(onB.status, 200, JSON.stringify(onB.body));
      assert.strictEqual(onB.body.active, true);
      assert.deepStrictEqual(onB.body.permissions, [{ streamId: 'notes', level: 'read' }]);
      // Revocation is home-core work too
      const revokeOnA = await httpRequest(CORE_A_PORT, 'POST', '/oauth2/revoke', { token: session.refresh_token, client_id: appId });
      assert.strictEqual(revokeOnA.status, 421, JSON.stringify(revokeOnA.body));
      assert.strictEqual(trim(revokeOnA.body.coreUrl), trim(CORE_B_URL));
    });

    it('[2C71] a client suspended by a write to the shared store (from the test process, as the operator CLI does) is refused at /token on the home core at once', async () => {
      const row = await oauthStorage.getClient(platformDB, appId);
      await oauthStorage.setClient(platformDB, { ...row, status: 'suspended', updatedAt: Date.now() });
      try {
        const res = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/token', { grant_type: 'refresh_token', refresh_token: session.refresh_token, client_id: appId });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.error, 'unauthorized_client');
      } finally {
        await oauthStorage.setClient(platformDB, { ...row, status: 'active', updatedAt: Date.now() });
      }
      // Not consumed by the refusal: the same refresh token works after the resume
      const res = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/token', { grant_type: 'refresh_token', refresh_token: session.refresh_token, client_id: appId });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      session = res.body;
    });

    it('[2C72] a client revoked through the shared store: its session is refused on the home core within the revoke check period', async () => {
      const second = 'Mc2.' + Date.now().toString(36);
      // A session of another client, so the grant of [2C73] stays
      await oauth2.persistClient(platformDB, registryRow({ clientId: second }));
      const access = await httpRequest(CORE_B_PORT, 'POST', '/' + user.username + '/accesses', {
        type: 'app', name: 'oauth:' + second, permissions: [{ streamId: 'notes', level: 'read' }]
      }, { Authorization: user.token });
      assert.strictEqual(access.status, 201, JSON.stringify(access.body));
      const token = access.body.access.token;
      const read = () => httpRequest(CORE_B_PORT, 'GET', '/' + user.username + '/access-info', null, { Authorization: token });
      assert.strictEqual((await read()).status, 200);
      await oauthStorage.deleteClient(platformDB, second);
      const deadline = Date.now() + 5000;
      let status = 200;
      while (Date.now() < deadline) {
        status = (await read()).status;
        if (status !== 200) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(status === 401 || status === 403, 'still accepted after the revoke check period: ' + status);
    });

    it('[2C74] revoking a refresh token on its home core after the 421 ends that chain only: its session is inactive from both cores, the grant and the other chain stay', async () => {
      const other = await newChain();
      const onA = await httpRequest(CORE_A_PORT, 'POST', '/oauth2/revoke', { token: other.refresh_token, client_id: appId, token_type_hint: 'refresh_token' });
      assert.strictEqual(onA.status, 421, JSON.stringify(onA.body));
      assert.strictEqual(trim(onA.body.coreUrl), trim(CORE_B_URL));
      const onB = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/revoke', { token: other.refresh_token, client_id: appId, token_type_hint: 'refresh_token' });
      assert.strictEqual(onB.status, 200, JSON.stringify(onB.body));
      for (const port of [CORE_A_PORT, CORE_B_PORT]) {
        const gone = await asResourceServer(port, '/oauth2/introspect', { token: other.access_token });
        assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
        assert.deepStrictEqual(gone.body, { active: false }, 'core port ' + port);
      }
      const replay = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/token', { grant_type: 'refresh_token', refresh_token: other.refresh_token, client_id: appId });
      assert.strictEqual(replay.status, 400, JSON.stringify(replay.body));
      assert.strictEqual(replay.body.error, 'invalid_grant');
      // The first chain and the consent grant are untouched.
      const live = await asResourceServer(CORE_B_PORT, '/oauth2/introspect', { token: session.access_token });
      assert.strictEqual(live.body.active, true, JSON.stringify(live.body));
      const list = await httpRequest(CORE_B_PORT, 'GET', '/' + user.username + '/accesses', null, { Authorization: user.token });
      assert.ok(list.body.accesses.some((a) => a.name === 'oauth-grant:' + appId), 'the grant stays');
    });

    it('[2C78] a token exchange on the other core answers 421 with the home core\'s URL; on the home core the derived token reads the account', async () => {
      const exchangerId = 'RsX.' + Date.now().toString(36);
      const audience = 'https://rs.multicore.test/rs';
      await oauth2.persistClient(platformDB, registryRow({
        clientId: exchangerId,
        tokenEndpointAuthMethod: 'client_secret_basic',
        clientSecretHash: rsSecret.hash,
        anyAudience: undefined,
        allowedAudiences: [audience],
        canExchange: true
      }));
      try {
        const subject = await newChain({ resource: audience });
        // The request a resource server sends, nothing more.
        const asExchanger = (port) => httpRequest(port, 'POST', '/oauth2/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: subject.access_token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
        }, { Authorization: 'Basic ' + Buffer.from(exchangerId + ':' + rsSecret.plaintext).toString('base64') });
        const onA = await asExchanger(CORE_A_PORT);
        assert.strictEqual(onA.status, 421, JSON.stringify(onA.body));
        assert.strictEqual(onA.body.error, 'wrong_core');
        assert.strictEqual(trim(onA.body.coreUrl), trim(CORE_B_URL));
        const onB = await asExchanger(CORE_B_PORT);
        assert.strictEqual(onB.status, 200, JSON.stringify(onB.body));
        assert.strictEqual(onB.body.token_type, 'Bearer');
        assert.strictEqual(onB.body.issued_token_type, 'urn:ietf:params:oauth:token-type:access_token');
        const read = await httpRequest(CORE_B_PORT, 'GET', '/' + user.username + '/events?streams=' + encodeURIComponent('["notes"]'), null,
          { Authorization: onB.body.access_token });
        assert.strictEqual(read.status, 200, JSON.stringify(read.body));
      } finally {
        try { await oauthStorage.deleteClient(platformDB, exchangerId); } catch (_) { /* best-effort */ }
      }
    });

    it('[OPUX4] a per-user subject token presented on the other core: the audience matches, then 421; a resource server not listing it, or a mismatching subject_token_resource, learns no core URL', async () => {
      const template = 'https://{username}.multicore.test/rs';
      const mine = 'https://' + user.username + '.multicore.test/rs';
      const clientId = 'PerUser.' + Date.now().toString(36);
      const exchangerId = 'RsPu.' + Date.now().toString(36);
      const otherId = 'RsOther.' + Date.now().toString(36);
      const confidential = { tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, anyAudience: undefined, canExchange: true };
      await oauth2.persistClient(platformDB, registryRow({ clientId, anyAudience: undefined, allowedAudiences: [template] }));
      await oauth2.persistClient(platformDB, registryRow({ clientId: exchangerId, ...confidential, allowedAudiences: [template] }));
      await oauth2.persistClient(platformDB, registryRow({ clientId: otherId, ...confidential, allowedAudiences: ['https://rs.multicore.test/other'] }));
      try {
        const subject = await newChain({ resource: mine, clientId });
        const exchangeAs = (port, id, extra = {}) => httpRequest(port, 'POST', '/oauth2/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: subject.access_token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          ...extra
        }, { Authorization: 'Basic ' + Buffer.from(id + ':' + rsSecret.plaintext).toString('base64') });
        const onA = await exchangeAs(CORE_A_PORT, exchangerId);
        assert.strictEqual(onA.status, 421, JSON.stringify(onA.body));
        assert.strictEqual(trim(onA.body.coreUrl), trim(CORE_B_URL));
        const foreign = await exchangeAs(CORE_A_PORT, otherId);
        assert.deepStrictEqual([foreign.status, foreign.body.error, foreign.body.coreUrl], [400, 'invalid_target', undefined]);
        // [OPUX9] the presented resource is checked before the core is named.
        const elsewhere = await exchangeAs(CORE_A_PORT, exchangerId, { subject_token_resource: 'https://someone-else.multicore.test/rs' });
        assert.deepStrictEqual([elsewhere.status, elsewhere.body.error, elsewhere.body.coreUrl], [400, 'invalid_target', undefined]);
        assert.ok(!JSON.stringify(elsewhere.body).includes(String(CORE_B_PORT)), 'no core URL');
        const matching = await exchangeAs(CORE_A_PORT, exchangerId, { subject_token_resource: mine });
        assert.strictEqual(matching.status, 421, JSON.stringify(matching.body));
        // On the home core: the label is the subject's username, exchanged.
        const onB = await exchangeAs(CORE_B_PORT, exchangerId, { subject_token_resource: mine });
        assert.strictEqual(onB.status, 200, JSON.stringify(onB.body));
      } finally {
        for (const id of [clientId, exchangerId, otherId]) {
          try { await oauthStorage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
        }
      }
    });

    it('[2C79] a consent for an account of the other core: /offer and /accept answer 421 wrong_core with its home core; an unknown name keeps the uniform answer', async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const q = new URLSearchParams({
        client_id: appId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        state: 'wc',
        scope: 'read/notes',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256'
      });
      // The authorization is issued by Core A; the account lives on Core B.
      const auth = await fetch(`http://127.0.0.1:${CORE_A_PORT}/oauth2/authorize?${q}`, { redirect: 'manual' });
      assert.strictEqual(auth.status, 302, await auth.text());
      const state = new URL(auth.headers.get('location')).searchParams.get('state');
      const signedOut = await httpRequest(CORE_A_PORT, 'POST', '/oauth2/authorize/offer', { state });
      assert.strictEqual(signedOut.status, 200, JSON.stringify(signedOut.body));
      const grantedPermissions = signedOut.body.offer.permissions;
      const offerAs = (username, userToken) => httpRequest(CORE_A_PORT, 'POST', '/oauth2/authorize/offer', { state, username, userToken });
      const acceptAs = (username, userToken) => httpRequest(CORE_A_PORT, 'POST', '/oauth2/authorize/accept', { state, username, userToken, grantedPermissions });
      for (const res of [await offerAs(user.username, user.token), await acceptAs(user.username, user.token)]) {
        assert.strictEqual(res.status, 421, JSON.stringify(res.body));
        assert.strictEqual(res.body.error, 'wrong_core');
        assert.strictEqual(trim(res.body.coreUrl), trim(CORE_B_URL));
        assert.ok(!JSON.stringify(res.body).includes(user.username), 'the answer does not name the account');
      }
      // A name no core serves: the uniform answers, as before.
      const nobody = 'tcnone' + Date.now().toString(36);
      const offerNobody = await offerAs(nobody, 'not-a-token');
      assert.strictEqual(offerNobody.status, 200, JSON.stringify(offerNobody.body));
      assert.strictEqual(offerNobody.body.authenticated, false);
      const acceptNobody = await acceptAs(nobody, 'not-a-token');
      assert.strictEqual(acceptNobody.status, 401, JSON.stringify(acceptNobody.body));
      // On the home core, a wrong token of the account keeps the uniform 401.
      const onB = await fetch(`http://127.0.0.1:${CORE_B_PORT}/oauth2/authorize?${q}`, { redirect: 'manual' });
      assert.strictEqual(onB.status, 302, await onB.text());
      const stateB = new URL(onB.headers.get('location')).searchParams.get('state');
      const badOnB = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/authorize/accept', { state: stateB, username: user.username, userToken: 'not-a-token', grantedPermissions });
      assert.strictEqual(badOnB.status, 401, JSON.stringify(badOnB.body));
      assert.deepStrictEqual(badOnB.body, acceptNobody.body);
    });

    it('[OTKW1] /token on the account\'s host at the other core answers 421 wrong_core with Retry-After before reading the refresh token; the home core then refreshes it', async () => {
      const chain = await newChain();
      const host = `${user.username}.${DOMAIN}`;
      const refresh = { grant_type: 'refresh_token', refresh_token: chain.refresh_token, client_id: appId };
      const onA = await requestWithHost(CORE_A_PORT, 'POST', '/oauth2/token', host, refresh);
      assert.strictEqual(onA.status, 421, JSON.stringify(onA.body));
      assert.strictEqual(onA.body.error, 'wrong_core');
      assert.strictEqual(trim(onA.body.coreUrl), trim(CORE_B_URL));
      assert.strictEqual(onA.headers['retry-after'], '300');
      assert.strictEqual(onA.headers['cache-control'], 'no-store');
      assert.ok(!JSON.stringify(onA.body).includes(user.username), 'the answer does not name the account');
      // On the core's own host: the token endpoint answers as before.
      const onAService = await requestWithHost(CORE_A_PORT, 'POST', '/oauth2/token', `${CORE_A_ID}.${DOMAIN}`, refresh);
      assert.strictEqual(onAService.status, 400, JSON.stringify(onAService.body));
      assert.strictEqual(onAService.body.error, 'invalid_grant');
      // The refresh token is intact: the home core rotates it, on its account's host too.
      const onB = await requestWithHost(CORE_B_PORT, 'POST', '/oauth2/token', host, refresh);
      assert.strictEqual(onB.status, 200, JSON.stringify(onB.body));
      assert.ok(onB.body.refresh_token != null && onB.body.refresh_token !== chain.refresh_token);
    });

    it('[OTKW2] /authorize on the account\'s host at the other core answers a static page, no redirect; the core\'s own host is unchanged', async () => {
      const q = new URLSearchParams({
        client_id: appId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        state: 'tk',
        scope: 'read/notes',
        code_challenge: crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url'),
        code_challenge_method: 'S256'
      });
      for (const method of ['GET', 'POST']) {
        const moved = await requestWithHost(CORE_A_PORT, method, '/oauth2/authorize?' + q, `${user.username}.${DOMAIN}`);
        assert.strictEqual(moved.status, 421, method);
        assert.strictEqual(moved.headers.location, undefined, method);
        assert.match(moved.headers['content-type'], /^text\/html/);
        assert.strictEqual(moved.headers['retry-after'], '300');
        assert.match(String(moved.body), /This address has just moved/);
        assert.doesNotMatch(String(moved.body), /<form|<a |href=/i);
      }
      const onCoreHost = await requestWithHost(CORE_A_PORT, 'GET', '/oauth2/authorize?' + q, `${CORE_A_ID}.${DOMAIN}`);
      assert.strictEqual(onCoreHost.status, 302);
    });

    it('[OTKW3] /offer and /accept on the account\'s host keep their own answer; an unmapped name\'s host, another domain and the adapter host are not concerned', async () => {
      const offer = await requestWithHost(CORE_A_PORT, 'POST', '/oauth2/authorize/offer', `${user.username}.${DOMAIN}`, { state: 'not-a-state' });
      assert.notStrictEqual(offer.status, 421, JSON.stringify(offer.body));
      const refresh = { grant_type: 'refresh_token', refresh_token: 'x', client_id: appId };
      for (const host of [`tknobody${Date.now().toString(36)}.${DOMAIN}`, `${user.username}.attacker.tld`, `adapter.${DOMAIN}`]) {
        const res = await requestWithHost(CORE_A_PORT, 'POST', '/oauth2/token', host, refresh);
        assert.strictEqual(res.status, 400, host + ' ' + JSON.stringify(res.body));
        assert.strictEqual(res.body.error, 'invalid_grant', host);
      }
    });

    it('[OPIS8] with the per-user issuer on (Core A): an account of Core A has its own issuer there; an account of Core B is not given one by Core A, whose token endpoint answers 421 on its host', async () => {
      const own = 'tcpi' + Date.now().toString(36);
      const reg = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username: own,
        password: 'testpassw0rd',
        email: own + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_A_HOSTING
      });
      assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
      const discovery = (port, host) => requestWithHost(port, 'GET', '/.well-known/oauth-authorization-server', host);
      const mine = await discovery(CORE_A_PORT, `${own}.${DOMAIN}`);
      assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
      assert.strictEqual(mine.body.issuer, `https://${own}.${DOMAIN}`);
      assert.match(String(mine.headers.vary), /\bHost\b/i);
      const configuredA = (await discovery(CORE_A_PORT, `${CORE_A_ID}.${DOMAIN}`)).body.issuer;
      const elsewhere = await discovery(CORE_A_PORT, `${user.username}.${DOMAIN}`);
      assert.strictEqual(elsewhere.status, 200, JSON.stringify(elsewhere.body));
      assert.strictEqual(elsewhere.body.issuer, configuredA, 'not a per-user issuer for an account of another core');
      const token = await requestWithHost(CORE_A_PORT, 'POST', '/oauth2/token', `${user.username}.${DOMAIN}`,
        { grant_type: 'refresh_token', refresh_token: 'x', client_id: appId });
      assert.strictEqual(token.status, 421, JSON.stringify(token.body));
      assert.strictEqual(token.body.error, 'wrong_core');
      // Core B runs with the switch off: its own account's host keeps its configured issuer.
      const onB = await discovery(CORE_B_PORT, `${user.username}.${DOMAIN}`);
      assert.strictEqual(onB.body.issuer, (await discovery(CORE_B_PORT, `${CORE_B_ID}.${DOMAIN}`)).body.issuer);
    });

    it('[2C73] deleting the grant on the home core turns introspection inactive at once', async () => {
      const list = await httpRequest(CORE_B_PORT, 'GET', '/' + user.username + '/accesses', null, { Authorization: user.token });
      const grant = list.body.accesses.find((a) => a.name === 'oauth-grant:' + appId);
      assert.ok(grant != null, JSON.stringify(list.body.accesses.map((a) => a.name)));
      const del = await httpRequest(CORE_B_PORT, 'DELETE', '/' + user.username + '/accesses/' + encodeURIComponent(grant.id), null, { Authorization: user.token });
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));
      const res = await asResourceServer(CORE_B_PORT, '/oauth2/introspect', { token: session.access_token });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { active: false });
    });
  });

  describe('Client metadata documents across cores', () => {
    const crypto = require('node:crypto');
    const { metadataClientKey } = require('oauth2/src/clientMetadataId.ts');
    const DOC_PATH = '/apps/2core-' + Date.now().toString(36) + '.json';
    const DOC_URL = 'https://' + METADATA_HOST + DOC_PATH;
    const REDIRECT = 'https://' + METADATA_HOST + '/cb';
    let stub;
    let fetches = 0;

    before(async () => {
      stub = require('node:http').createServer((req, res) => {
        if (req.url !== '/' + METADATA_HOST + DOC_PATH) { res.statusCode = 404; return res.end(); }
        fetches++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ client_id: DOC_URL, client_name: 'Two-core agent', redirect_uris: [REDIRECT] }));
      });
      await new Promise((resolve) => stub.listen(METADATA_STUB_PORT, '127.0.0.1', resolve));
    });

    after(async () => {
      try { await require('oauth2/src/storage.ts').deleteClient(platformDB, metadataClientKey(DOC_URL)); } catch (_) { /* best-effort */ }
      if (stub != null) await new Promise((resolve) => stub.close(resolve));
    });

    function authorizeOn (port, challenge) {
      const q = new URLSearchParams({
        client_id: DOC_URL,
        redirect_uri: REDIRECT,
        response_type: 'code',
        state: 'cm',
        scope: 'read/notes',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: OAUTH_AUD
      });
      return fetch(`http://127.0.0.1:${port}/oauth2/authorize?${q}`, { redirect: 'manual' });
    }

    it('[OCMDE10] the row written by one core serves the other: no fetch there, and the flow completes on the home core', async () => {
      for (const port of [CORE_A_PORT, CORE_B_PORT]) {
        const disc = await httpRequest(port, 'GET', '/.well-known/oauth-authorization-server');
        assert.strictEqual(disc.body.client_id_metadata_document_supported, true, String(port));
      }
      // A user on Core B
      const username = 'cmd' + Date.now().toString(36);
      const reg = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en',
        hosting: CORE_B_HOSTING
      });
      assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
      const userToken = new URL(reg.body.apiEndpoint).username;
      const stream = await httpRequest(CORE_B_PORT, 'POST', '/' + username + '/streams', { id: 'notes', name: 'notes' }, { Authorization: userToken });
      assert.strictEqual(stream.status, 201, JSON.stringify(stream.body));

      // Core A fetches the document and writes the row (cluster-wide).
      const onA = await authorizeOn(CORE_A_PORT, crypto.randomBytes(32).toString('base64url').slice(0, 43));
      assert.strictEqual(onA.status, 302, await onA.text());
      assert.strictEqual(fetches, 1);
      assert.notStrictEqual(await platformDB.getPlatformKv('oauth-client/' + metadataClientKey(DOC_URL)), null);

      // Core B (the user's home core) serves the whole flow from that row.
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const onB = await authorizeOn(CORE_B_PORT, challenge);
      assert.strictEqual(onB.status, 302, await onB.text());
      const state = new URL(onB.headers.get('location')).searchParams.get('state');
      const offer = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/authorize/offer', { state });
      assert.strictEqual(offer.status, 200, JSON.stringify(offer.body));
      assert.strictEqual(offer.body.client.metadataHost, METADATA_HOST);
      const accept = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/authorize/accept', {
        state, username, userToken, grantedPermissions: offer.body.offer.permissions
      });
      assert.strictEqual(accept.status, 200, JSON.stringify(accept.body));
      const code = new URL(accept.body.redirectTo).searchParams.get('code');
      const token = await httpRequest(CORE_B_PORT, 'POST', '/oauth2/token', {
        grant_type: 'authorization_code', code, code_verifier: verifier, client_id: DOC_URL, redirect_uri: REDIRECT, resource: OAUTH_AUD
      });
      assert.strictEqual(token.status, 200, JSON.stringify(token.body));
      assert.strictEqual(fetches, 1, 'Core B never fetched the document');
    });
  });

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
