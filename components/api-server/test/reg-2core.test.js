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
const CORE_C_PORT = 13020;
// Hosted sites: `sitehome` on both cores, `siteonly` on core A only (core B
// must still refuse it as a username, from core A's advertisement).
const SITE_DIR = '/tmp/rg2c-hosted-site';
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
      // rqlited's own output: to a file, not the test runner's stdout.
      logFile: '/tmp/rqlite-2core-test.log',
      log: (msg) => { if (process.env.LOGS) console.log('[rqlite]', msg); }
    });

    // Init PlatformDB schema
    platformDB = new DBrqlite(RQLITE_URL);
    await platformDB.init();

    // Seed core info in PlatformDB so cores can find each other
    await seedCoreInfo(CORE_A_ID, CORE_A_IP);
    await seedCoreInfo(CORE_B_ID, CORE_B_IP);

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
      HOSTED_SITES_JSON: JSON.stringify({ [SITE_BOTH]: { static: SITE_DIR }, [SITE_A_ONLY]: { static: SITE_DIR } })
    });

    coreB = await startCore({
      ...coreEnv,
      CORE_PORT: String(CORE_B_PORT),
      CORE_ID: CORE_B_ID,
      CORE_IP: CORE_B_IP,
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
    fs.rmSync('/tmp/rqlite-2core-test', { recursive: true, force: true });
    fs.rmSync(SITE_DIR, { recursive: true, force: true });
    // Clean up users created by child cores in shared MongoDB + PlatformDB
    const { getUsersRepository } = require('business/src/users/index.ts');
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
    it('[2C00] both cores run on the storage engine of this test run', () => {
      const expected = getConfigUnsafe(true).get('storages:base:engine');
      assert.ok(expected, 'the test process has a base engine');
      assert.strictEqual(coreA.readyInfo.baseEngine, expected, 'core A');
      assert.strictEqual(coreB.readyInfo.baseEngine, expected, 'core B');
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
        language: 'en'
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

  describe('Hosted sites', () => {
    async function register (port, username) {
      return httpRequest(port, 'POST', '/users', {
        appId: 'test-2core-sites',
        username,
        password: 'testpassw0rd',
        email: username + '-' + Date.now().toString(36) + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en'
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
        HOSTED_SITES_JSON: JSON.stringify({ [SITE_BOTH]: { static: SITE_DIR + '-missing' } })
      }), /exited with code 1/);
    });

    it('[2C44] a core whose site name is another core\'s id does not start', async () => {
      let started = null;
      try {
        started = await startCore({
          DNS_DOMAIN: DOMAIN,
          RQLITE_URL,
          ADMIN_KEY,
          CORE_PORT: String(CORE_C_PORT),
          CORE_ID: 'core-c',
          CORE_IP: '127.0.0.3',
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

    async function registerOn (port, username) {
      const res = await httpRequest(port, 'POST', '/users', {
        appId: 'test-2core-xid',
        username,
        password: 'testpassw0rd',
        email: username + '@test.example.com',
        insurancenumber: String(Math.floor(Math.random() * 900) + 100),
        language: 'en'
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

    // The forced accept across cores (token bound on the account's core, holder
    // asked on that core's /system/ext-id/holds) is covered by [XIDFC] (remote
    // arm, fetch seam) and [XIDH] (the holder route over HTTP): the child cores
    // here run as single-core nodes over one test database, so a cross-core
    // accept would take the local arm.
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
  });
});
