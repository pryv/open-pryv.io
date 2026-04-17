/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 35 Phase 5 — integration test.
 *
 * Wires the real CertRenewer + FileMaterializer + AcmeOrchestrator
 * against real rqlite (via DBrqlite) with a mocked acme-client that
 * returns a canned cert. Validates:
 *
 *   1. First tick issues a cert (stored encrypted in rqlite, decrypted
 *      keyPem written to disk with 0600).
 *   2. Second tick is a no-op (cert is not yet due).
 *   3. When the stored cert expiresAt is close, another tick triggers
 *      a renewal; the on-disk files + the PlatformDB row both rotate.
 *   4. On-disk cert is never plaintext in rqlite (snapshot check).
 *
 * The real acme-client network flow is covered by spike/level2-acme.js
 * against Let's Encrypt staging.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const DBrqlite = require('../../../../storages/engines/rqlite/src/DBrqlite');
const { AcmeOrchestrator } = require('../../src/acme/AcmeOrchestrator');
const { CertRenewer, PlatformDBDnsWriter } = require('../../src/acme/CertRenewer');
const { FileMaterializer } = require('../../src/acme/FileMaterializer');

const RQLITE_URL = process.env.RQLITE_URL || 'http://localhost:4001';

function realCertPem (cn, days = 90) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-int-'));
  try {
    const keyPath = path.join(dir, 'k.pem');
    const certPath = path.join(dir, 'c.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-noenc', '-keyout', keyPath, '-out', certPath,
      '-days', String(days), '-subj', `/CN=${cn}`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(certPath, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Mock acme-client returning a canned bundle. Mimics just the surface
 *  CertRenewer touches. */
function makeFakeAcmeLib ({ bundlePem, accountUrl = 'https://acme.example/acct/1' }) {
  return {
    directory: { letsencrypt: { staging: 'https://stg/dir', production: 'https://prod/dir' } },
    crypto: {
      async createPrivateKey () {
        return '-----BEGIN RSA PRIVATE KEY-----\nACCOUNT-KEY-BYTES\n-----END RSA PRIVATE KEY-----';
      },
      async createCsr ({ commonName }) {
        // Nonce in the fake key so different calls → different keyPem,
        // matching real ACME behaviour (fresh keypair per order).
        const nonce = crypto.randomBytes(8).toString('hex');
        return [
          '-----BEGIN PRIVATE KEY-----\nCERT-KEY-' + commonName + '-' + nonce + '\n-----END PRIVATE KEY-----',
          Buffer.from('csr-' + commonName + '-' + nonce)
        ];
      }
    },
    Client: class {
      async createAccount () { return { status: 'valid' }; }
      getAccountUrl () { return accountUrl; }
      async auto (o) {
        await o.challengeCreateFn({ identifier: { value: 'integration.test' } }, { type: 'dns-01' }, 'ka');
        await o.challengeRemoveFn({ identifier: { value: 'integration.test' } }, { type: 'dns-01' }, 'ka');
        return bundlePem;
      }
    }
  };
}

describe('[ACMEINT] ACME integration (rqlite + real cert material)', function () {
  this.timeout(30_000);

  let rqliteUp = false;
  let db;
  let tmp;

  before(async function () {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      console.log('  skipping: openssl not available');
      this.skip();
      return;
    }
    try {
      const res = await fetch(RQLITE_URL + '/status');
      if (!res.ok) throw new Error('rqlite not ready');
      rqliteUp = true;
    } catch {
      console.log('  skipping: rqlite not reachable at ' + RQLITE_URL);
      this.skip();
    }
  });

  beforeEach(async () => {
    if (!rqliteUp) return;
    db = new DBrqlite(RQLITE_URL);
    await db.init();
    // Clear any state from a previous run that touched tls-* keys.
    // deleteAll would nuke OTHER test suites' state too — this is scoped.
    await db.execute("DELETE FROM keyValue WHERE key LIKE 'tls-%'");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-acmeint-'));
  });

  afterEach(async () => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (rqliteUp && db) await db.execute("DELETE FROM keyValue WHERE key LIKE 'tls-%'");
  });

  it('full flow: issue → persist encrypted → materialize → disk; rotates on renew', async () => {
    const atRestKey = crypto.randomBytes(32);
    const firstBundle = realCertPem('integration.test', 90);
    const secondBundle = realCertPem('integration.test', 90);

    let currentBundle = firstBundle;
    const acmeLib = makeFakeAcmeLib({ bundlePem: firstBundle, accountUrl: 'https://acme/acct/42' });
    // Swap the Client.auto bundle between ticks by replacing the Class
    // reference — ugly but keeps the test in one process.
    const originalClient = acmeLib.Client;
    acmeLib.Client = class extends originalClient {
      async auto (o) {
        await o.challengeCreateFn({ identifier: { value: 'integration.test' } }, { type: 'dns-01' }, 'ka');
        await o.challengeRemoveFn({ identifier: { value: 'integration.test' } }, { type: 'dns-01' }, 'ka');
        return currentBundle;
      }
    };

    const certRenewer = new CertRenewer({
      platformDB: db, atRestKey, email: 'ops@ex.com', acmeLib
    });
    const fileMaterializer = new FileMaterializer({
      certRenewer, tlsDir: tmp, hostname: 'integration.test', log: () => {}
    });
    const dnsWriter = new PlatformDBDnsWriter({ platformDB: db, waitMs: 0 });

    const orch = new AcmeOrchestrator({
      hostSpec: { commonName: 'integration.test', altNames: [], challenge: 'dns-01' },
      certRenewer,
      fileMaterializer,
      dnsWriter,
      isRenewer: true,
      renewBeforeDays: 30,
      materializeIntervalMs: 10_000_000,
      renewIntervalMs: 10_000_000,
      log: () => {}
    });

    // --- tick 1: initial issuance ---
    const r1 = await orch.triggerRenewCheck();
    assert.equal(r1.renewed, true, 'first tick should issue a fresh cert');
    await orch.triggerMaterialize();

    // PlatformDB has the cert; keyPem is NOT plaintext.
    const storedRow = await db.getCertificate('integration.test');
    assert.ok(storedRow);
    assert.ok(!storedRow.keyPem.includes('BEGIN PRIVATE KEY'),
      'stored keyPem must be encrypted (no PEM markers)');
    assert.ok(storedRow.certPem.includes('BEGIN CERTIFICATE'));

    // Snapshot-style check: rqlite's raw row for this key doesn't contain
    // the plaintext marker. Guards against accidental plaintext regressions.
    const rawRows = await db.query(
      'SELECT value FROM keyValue WHERE key = ?', ['tls-cert/integration.test']
    );
    assert.equal(rawRows.length, 1);
    assert.ok(!rawRows[0].value.includes('BEGIN PRIVATE KEY'),
      'raw rqlite row must not contain plaintext keyPem');

    // On-disk: cert + key in expected paths, 0600 on the key.
    const hostDir = path.join(tmp, 'integration.test');
    const certPath = path.join(hostDir, 'fullchain.pem');
    const keyPath = path.join(hostDir, 'privkey.pem');
    assert.ok(fs.existsSync(certPath));
    assert.ok(fs.existsSync(keyPath));
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    const keyOnDisk = fs.readFileSync(keyPath, 'utf8');
    assert.ok(keyOnDisk.includes('BEGIN PRIVATE KEY'),
      'on-disk keyPem should be the plaintext PEM (decrypted by materializer)');

    // --- tick 2: no-op (cert is 90 days out, renewBeforeDays=30) ---
    const r2 = await orch.triggerRenewCheck();
    assert.equal(r2.skipped, true);
    assert.equal(r2.reason, 'not-yet-due');

    // --- force a renewal by swapping the bundle + faking expiry ---
    currentBundle = secondBundle;
    // Simulate a cert that's about to expire: rewrite the stored row's
    // expiresAt 1 day in the future.
    const almostExpiredCert = { ...storedRow, expiresAt: Date.now() + 24 * 3600 * 1000 };
    await db.setCertificate('integration.test', almostExpiredCert);

    const r3 = await orch.triggerRenewCheck();
    assert.equal(r3.renewed, true, 'third tick should renew');
    await orch.triggerMaterialize();

    const newRow = await db.getCertificate('integration.test');
    assert.notEqual(newRow.certPem, storedRow.certPem, 'cert should have rotated');
    assert.ok(newRow.expiresAt > Date.now() + 60 * 24 * 3600 * 1000,
      'new cert should have a full ~90-day validity');
    const newKeyOnDisk = fs.readFileSync(keyPath, 'utf8');
    assert.notEqual(newKeyOnDisk, keyOnDisk, 'on-disk key should have rotated');

    // listCertificates surfaces the latest metadata only.
    const list = await db.listCertificates();
    assert.equal(list.length, 1);
    assert.equal(list[0].hostname, 'integration.test');
    assert.ok(!Object.keys(list[0]).includes('certPem'));
  });
});
