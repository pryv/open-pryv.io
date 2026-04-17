/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * End-to-end test for Plan 34 — bootstrap flow across the three subsystems
 * that talk to each other in production:
 *
 *   1. Issuing core    → cliOps.newCore() mints token, pre-registers in
 *                        PlatformDB, writes bundle to disk.
 *   2. New core        → consumer.consume() decrypts, applies, POSTs ack.
 *   3. Issuing core    → ackHandler verifies token, flips available:true.
 *
 * No master.js, no rqlited — we run a real `http.createServer` carrying
 * the ack route and a shared in-memory PlatformDB so the issuer and the
 * ack endpoint see the same state. That's enough to catch wiring bugs
 * across the three modules; the dedicated unit suites cover each module's
 * internal edge cases.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const TokenStore = require('../../src/bootstrap/TokenStore');
const cliOps = require('../../src/bootstrap/cliOps');
const consumer = require('../../src/bootstrap/consumer');
const ackHandler = require('../../src/bootstrap/ackHandler');

function makeFakeDB () {
  const cores = new Map();
  const dns = new Map();
  return {
    async setCoreInfo (id, info) { cores.set(id, info); },
    async getCoreInfo (id) { return cores.get(id) ?? null; },
    async deleteCoreInfo (id) { cores.delete(id); },
    async getAllCoreInfos () { return [...cores.values()]; },
    async setDnsRecord (sub, records) { dns.set(sub, records); },
    async getDnsRecord (sub) { return dns.get(sub) ?? null; },
    async deleteDnsRecord (sub) { dns.delete(sub); },
    _cores: cores,
    _dns: dns
  };
}

/**
 * Spin up a tiny http server that mounts the ack handler at
 * /system/admin/cores/ack — mirrors the route wired in api-server's
 * routes/system.js but without the full express stack.
 */
async function startAckServer ({ tokenStore, platformDB }) {
  const handle = ackHandler.makeHandler({ tokenStore, platformDB });
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/system/admin/cores/ack') {
      res.statusCode = 404; res.end(); return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await handle({ body, ip: req.socket.remoteAddress });
        res.statusCode = result.statusCode;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { id: 'internal', message: err.message } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('[BOOTSTRAPE2E] bootstrap full flow', function () {
  this.timeout(30_000);

  let tmp;

  before(function () {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
      console.log('  skipping: openssl not available');
      this.skip();
    }
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-e2e-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('happy path: issue → consume → ack flips available, bundle deleted', async () => {
    const platformDB = makeFakeDB();
    const tokensPath = path.join(tmp, 'issuer-tokens.json');
    const tokenStore = new TokenStore({ path: tokensPath });
    const { server, baseUrl } = await startAckServer({ tokenStore, platformDB });

    try {
      // 1. Issue a bundle on core-a
      const outPath = path.join(tmp, 'bundle.age');
      const issued = await cliOps.newCore({
        platformDB,
        caDir: path.join(tmp, 'issuer-ca'),
        tokensPath,
        dnsDomain: 'mc.example.com',
        ackUrlBase: baseUrl,
        secrets: {
          adminAccessKey: 'admin-key-0123456789abcdef0123',
          filesReadTokenSecret: 'files-secret-0123456789abcdef0'
        },
        rqlite: { raftPort: 4002, httpPort: 4001 },
        coreId: 'core-b',
        ip: '203.0.113.7',
        url: 'https://core-b.mc.example.com',
        hosting: 'us-east-1',
        outPath
      });
      // Pre-registration in place, available:false
      assert.equal(platformDB._cores.get('core-b').available, false);
      assert.deepEqual(platformDB._dns.get('lsc'), { a: ['203.0.113.7'] });

      // 2. Consume the bundle on core-b
      const result = await consumer.consume({
        bundlePath: outPath,
        passphrase: issued.passphrase,
        configDir: path.join(tmp, 'consumer-config'),
        tlsDir: path.join(tmp, 'consumer-tls'),
        log: () => {}
      });

      // 3. Ack landed: PlatformDB shows available:true, snapshot returned
      assert.equal(result.coreId, 'core-b');
      assert.equal(platformDB._cores.get('core-b').available, true);
      assert.equal(result.bundleDeleted, true);
      assert.equal(fs.existsSync(outPath), false);
      assert.equal(result.ackResponse.ok, true);
      assert.deepEqual(
        result.ackResponse.cluster.cores.map(c => c.id).sort(),
        ['core-b']
      );
      // Token was burned (replay protection)
      assert.equal(tokenStore.listActive().length, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('replay: a second consume of the same (re-created) bundle fails at ack', async () => {
    // The bundle file is deleted on first consume, so we copy it aside
    // first to simulate an attacker re-presenting the same payload.
    const platformDB = makeFakeDB();
    const tokensPath = path.join(tmp, 'tokens.json');
    const tokenStore = new TokenStore({ path: tokensPath });
    const { server, baseUrl } = await startAckServer({ tokenStore, platformDB });

    try {
      const outPath = path.join(tmp, 'bundle.age');
      const issued = await cliOps.newCore({
        platformDB,
        caDir: path.join(tmp, 'ca'),
        tokensPath,
        dnsDomain: 'mc.example.com',
        ackUrlBase: baseUrl,
        secrets: {
          adminAccessKey: 'admin-key-0123456789abcdef0123',
          filesReadTokenSecret: 'files-secret-0123456789abcdef0'
        },
        rqlite: { raftPort: 4002, httpPort: 4001 },
        coreId: 'core-b',
        ip: '203.0.113.7',
        outPath
      });
      const stash = path.join(tmp, 'bundle-copy.age');
      fs.copyFileSync(outPath, stash);

      // First consume succeeds
      await consumer.consume({
        bundlePath: outPath,
        passphrase: issued.passphrase,
        configDir: path.join(tmp, 'cfg-1'),
        tlsDir: path.join(tmp, 'tls-1'),
        log: () => {}
      });

      // Second consume of the stashed copy — same token, should be rejected
      await assert.rejects(
        consumer.consume({
          bundlePath: stash,
          passphrase: issued.passphrase,
          configDir: path.join(tmp, 'cfg-2'),
          tlsDir: path.join(tmp, 'tls-2'),
          log: () => {}
        }),
        /ack failed: HTTP 401[\s\S]*already-consumed/
      );
      // The replayed bundle was kept (operator can investigate)
      assert.equal(fs.existsSync(stash), true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('wrong passphrase: consumer fails before any ack POST', async () => {
    const platformDB = makeFakeDB();
    const tokensPath = path.join(tmp, 'tokens.json');
    const tokenStore = new TokenStore({ path: tokensPath });
    let ackHits = 0;
    // Wrap the handler to count POSTs that get past JSON parsing
    const baseHandler = ackHandler.makeHandler({ tokenStore, platformDB });
    const server = http.createServer((req, res) => {
      ackHits++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const r = await baseHandler({ body });
        res.statusCode = r.statusCode;
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const outPath = path.join(tmp, 'bundle.age');
      await cliOps.newCore({
        platformDB,
        caDir: path.join(tmp, 'ca'),
        tokensPath,
        dnsDomain: 'mc.example.com',
        ackUrlBase: baseUrl,
        secrets: {
          adminAccessKey: 'admin-key-0123456789abcdef0123',
          filesReadTokenSecret: 'files-secret-0123456789abcdef0'
        },
        rqlite: { raftPort: 4002, httpPort: 4001 },
        coreId: 'core-b',
        ip: '203.0.113.7',
        outPath
      });

      await assert.rejects(
        consumer.consume({
          bundlePath: outPath,
          passphrase: 'wrong-pass',
          configDir: path.join(tmp, 'cfg'),
          tlsDir: path.join(tmp, 'tls'),
          log: () => {}
        }),
        /authentication failed/
      );

      // Ack endpoint was never hit — consumer rejected before the POST
      assert.equal(ackHits, 0);
      // Token still active (operator can retry with correct passphrase)
      assert.equal(tokenStore.listActive().length, 1);
      // Bundle still on disk
      assert.equal(fs.existsSync(outPath), true);
      // PlatformDB still pre-registered with available:false
      assert.equal(platformDB._cores.get('core-b').available, false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('expired token: consume fails at ack with reason=expired', async () => {
    const platformDB = makeFakeDB();
    const tokensPath = path.join(tmp, 'tokens.json');
    const tokenStore = new TokenStore({ path: tokensPath });
    const { server, baseUrl } = await startAckServer({ tokenStore, platformDB });

    try {
      const outPath = path.join(tmp, 'bundle.age');
      const issued = await cliOps.newCore({
        platformDB,
        caDir: path.join(tmp, 'ca'),
        tokensPath,
        dnsDomain: 'mc.example.com',
        ackUrlBase: baseUrl,
        secrets: {
          adminAccessKey: 'admin-key-0123456789abcdef0123',
          filesReadTokenSecret: 'files-secret-0123456789abcdef0'
        },
        rqlite: { raftPort: 4002, httpPort: 4001 },
        coreId: 'core-b',
        ip: '203.0.113.7',
        outPath,
        ttlMs: 1 // expires almost immediately
      });

      // Wait past the token's TTL
      await new Promise(resolve => setTimeout(resolve, 50));

      await assert.rejects(
        consumer.consume({
          bundlePath: outPath,
          passphrase: issued.passphrase,
          configDir: path.join(tmp, 'cfg'),
          tlsDir: path.join(tmp, 'tls'),
          log: () => {}
        }),
        /ack failed: HTTP 401[\s\S]*expired/
      );
      assert.equal(platformDB._cores.get('core-b').available, false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('revoke-token after issuing: consume fails at ack with reason=unknown', async () => {
    const platformDB = makeFakeDB();
    const tokensPath = path.join(tmp, 'tokens.json');
    const tokenStore = new TokenStore({ path: tokensPath });
    const { server, baseUrl } = await startAckServer({ tokenStore, platformDB });

    try {
      const outPath = path.join(tmp, 'bundle.age');
      const issued = await cliOps.newCore({
        platformDB,
        caDir: path.join(tmp, 'ca'),
        tokensPath,
        dnsDomain: 'mc.example.com',
        ackUrlBase: baseUrl,
        secrets: {
          adminAccessKey: 'admin-key-0123456789abcdef0123',
          filesReadTokenSecret: 'files-secret-0123456789abcdef0'
        },
        rqlite: { raftPort: 4002, httpPort: 4001 },
        coreId: 'core-b',
        ip: '203.0.113.7',
        outPath
      });

      // Operator changes their mind and revokes
      await cliOps.revokeToken({
        tokensPath, coreId: 'core-b', platformDB, ip: '203.0.113.7'
      });

      await assert.rejects(
        consumer.consume({
          bundlePath: outPath,
          passphrase: issued.passphrase,
          configDir: path.join(tmp, 'cfg'),
          tlsDir: path.join(tmp, 'tls'),
          log: () => {}
        }),
        /ack failed: HTTP 401[\s\S]*unknown/
      );
      // Pre-registration also gone
      assert.equal(platformDB._cores.get('core-b'), undefined);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
