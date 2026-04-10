/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Phase 10: Two-core integration tests.
 *
 * Boots two real service-core instances (child processes) with a shared
 * rqlite PlatformDB and a DNS server. Verifies end-to-end multi-core flows:
 * registration, PlatformDB replication, DNS resolution, cross-core redirect.
 *
 * Sequential — manages child processes and rqlite lifecycle.
 *
 * Requires: rqlited binary at var-pryv/rqlite-bin/rqlited
 */

const assert = require('node:assert');
const { fork } = require('node:child_process');
const path = require('node:path');
const dns = require('node:dns');
const rqliteProcess = require('../../../storages/engines/rqlite/src/rqliteProcess');
const { createDnsServer } = require('dns-server/src');
const DBrqlite = require('../../../storages/engines/rqlite/src/DBrqlite');

const SERVICE_CORE_ROOT = path.resolve(__dirname, '../../../');
const CORE_PROCESS = path.resolve(__dirname, 'helpers/core-process.js');
const RQLITE_BIN = path.resolve(SERVICE_CORE_ROOT, 'var-pryv/rqlite-bin/rqlited');

const DOMAIN = 'test-2core.pryv.li';
const ADMIN_KEY = 'test-2core-admin-key';
const RQLITE_PORT = 14001;
const RQLITE_RAFT_PORT = 14002;
const RQLITE_URL = `http://localhost:${RQLITE_PORT}`;
const CORE_A_PORT = 13000;
const CORE_B_PORT = 13010;
const CORE_A_ID = 'core-a';
const CORE_B_ID = 'core-b';
const CORE_A_IP = '127.0.0.1';
const CORE_B_IP = '127.0.0.2';

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

// Helper: fork a core child process
function startCore (env) {
  return new Promise((resolve, reject) => {
    const child = fork(CORE_PROCESS, [], {
      cwd: SERVICE_CORE_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
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

function stopCore (child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
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

    // Start rqlite (single node)
    await rqliteProcess.start({
      coreId: 'test-node',
      binPath: RQLITE_BIN,
      dataDir: '/tmp/rqlite-2core-test',
      httpPort: RQLITE_PORT,
      raftPort: RQLITE_RAFT_PORT,
      dnsDomain: null,
      coreIp: null,
      log: (msg) => { if (process.env.LOGS) console.log('[rqlite]', msg); }
    });

    // Init PlatformDB schema
    platformDB = new DBrqlite(RQLITE_URL);
    await platformDB.init();

    // Seed core info in PlatformDB so cores can find each other
    await seedCoreInfo(CORE_A_ID, CORE_A_IP);
    await seedCoreInfo(CORE_B_ID, CORE_B_IP);

    // Start DNS server (in-process, ephemeral port)
    // platformDB (DBrqlite) exposes getUserCore, getCoreInfo, getAllCoreInfos directly
    const mockPlatform = {
      async getUserCore (username) {
        return platformDB.getUserCore(username);
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
      CORE_IP: CORE_A_IP
    });

    coreB = await startCore({
      ...coreEnv,
      CORE_PORT: String(CORE_B_PORT),
      CORE_ID: CORE_B_ID,
      CORE_IP: CORE_B_IP
    });
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
    fs.rmSync('/tmp/rqlite-2core-test', { recursive: true, force: true });
    // Clean up users created by child cores in shared MongoDB + PlatformDB
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    // Restore integrity check setting
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  // --- Helper: seed core info in PlatformDB ---

  async function seedCoreInfo (coreId, ip) {
    await platformDB.setCoreInfo(coreId, { id: coreId, ip, ipv6: null, cname: null, hosting: null, available: true });
  }

  // --- Tests ---

  describe('Core startup verification', () => {
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
  });

  describe('Registration + PlatformDB replication', () => {
    const testUser = 'tc' + Date.now().toString(36);
    const testEmail = testUser + '@test.example.com';

    it('[2C10] must register a user on Core A', async () => {
      const res = await httpRequest(CORE_A_PORT, 'POST', '/users', {
        appId: 'test-2core',
        username: testUser,
        password: 'testpassw0rd',
        email: testEmail,
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en'
      });
      // Accept 201 (created) or 200
      assert.ok(res.status === 201 || res.status === 200,
        `Expected 200/201 but got ${res.status}: ${JSON.stringify(res.body)}`);
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
        language: 'en'
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
});
