/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 35 Phase 3b — CertRenewer and PlatformDBDnsWriter.
 *
 * Uses a fake PlatformDB + a fake acme-client surface so the orchestration
 * logic can be asserted without network / file-system side effects. The
 * real end-to-end ACME flow is covered by spike/level2-acme.js against
 * Let's Encrypt staging.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const AtRestEncryption = require('../../src/acme/AtRestEncryption');
const { CertRenewer, PlatformDBDnsWriter, acmeChallengeName } = require('../../src/acme/CertRenewer');

function makeFakePlatformDB () {
  const kv = new Map(); // key → value (mirrors rqlite's keyValue table in-memory)
  const dns = new Map();
  const calls = [];
  return {
    async setAcmeAccount (acct) { calls.push(['setAcmeAccount', acct]); kv.set('acme-account', acct); },
    async getAcmeAccount () { calls.push(['getAcmeAccount']); return kv.get('acme-account') ?? null; },
    async setCertificate (host, cert) { calls.push(['setCertificate', host]); kv.set('cert/' + host, cert); },
    async getCertificate (host) { calls.push(['getCertificate', host]); return kv.get('cert/' + host) ?? null; },
    async setDnsRecord (name, records) { calls.push(['setDnsRecord', name, records]); dns.set(name, records); },
    async getDnsRecord (name) { calls.push(['getDnsRecord', name]); return dns.get(name) ?? null; },
    async deleteDnsRecord (name) { calls.push(['deleteDnsRecord', name]); dns.delete(name); },
    _kv: kv,
    _dns: dns,
    _calls: calls
  };
}

function realCertPem (cn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-cr-'));
  try {
    const keyPath = path.join(dir, 'k.pem');
    const certPath = path.join(dir, 'c.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-noenc', '-keyout', keyPath, '-out', certPath,
      '-days', '90', '-subj', `/CN=${cn}`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(certPath, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Fake acme-client surface. The fake records what happened and also
 *  invokes the challenge callbacks so we can assert the DNS writer was
 *  exercised with the right inputs. */
function makeFakeAcmeLib ({ bundlePem, accountUrl = 'https://acme/acct/1', identifierForChallenge = 'ex.com' } = {}) {
  const events = [];
  const lib = {
    directory: { letsencrypt: { staging: 'https://stg/dir', production: 'https://prod/dir' } },
    crypto: {
      async createPrivateKey () {
        events.push(['createPrivateKey']);
        return '-----BEGIN RSA PRIVATE KEY-----\nACCOUNT-KEY\n-----END RSA PRIVATE KEY-----';
      },
      async createCsr ({ commonName, altNames }) {
        events.push(['createCsr', commonName, altNames || null]);
        return [
          '-----BEGIN PRIVATE KEY-----\nCERT-KEY-FOR-' + commonName + '\n-----END PRIVATE KEY-----',
          Buffer.from('csr-' + commonName)
        ];
      }
    },
    Client: class {
      constructor (opts) { events.push(['Client.ctor', opts.accountUrl ?? null]); }
      async createAccount (o) { events.push(['createAccount', o]); return { status: 'valid' }; }
      getAccountUrl () { return accountUrl; }
      async auto (o) {
        events.push(['auto.start']);
        await o.challengeCreateFn({ identifier: { value: identifierForChallenge } }, { type: 'dns-01' }, 'ka-value');
        await o.challengeRemoveFn({ identifier: { value: identifierForChallenge } }, { type: 'dns-01' }, 'ka-value');
        events.push(['auto.end']);
        return bundlePem;
      }
    }
  };
  return { lib, events };
}

describe('[CERTRENEWER] CertRenewer', function () {
  this.timeout(10_000);

  before(function () {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
      console.log('  skipping: openssl not available');
      this.skip();
    }
  });

  const atRestKey = crypto.randomBytes(32);

  describe('constructor validation', () => {
    it('rejects missing platformDB', () => {
      assert.throws(
        () => new CertRenewer({ atRestKey, email: 'a@b.c' }),
        /platformDB is required/
      );
    });
    it('rejects non-32-byte atRestKey', () => {
      const db = makeFakePlatformDB();
      assert.throws(
        () => new CertRenewer({ platformDB: db, atRestKey: Buffer.alloc(16), email: 'a@b.c' }),
        /32-byte Buffer/
      );
    });
    it('rejects missing email', () => {
      const db = makeFakePlatformDB();
      assert.throws(
        () => new CertRenewer({ platformDB: db, atRestKey }),
        /email is required/
      );
    });
  });

  describe('ensureAccount()', () => {
    it('creates and persists a fresh account (encrypted at rest) on first call', async () => {
      const db = makeFakePlatformDB();
      const { lib, events } = makeFakeAcmeLib({
        bundlePem: realCertPem('irrelevant'),
        accountUrl: 'https://acme/acct/99'
      });
      const renewer = new CertRenewer({
        platformDB: db, atRestKey, email: 'ops@example.com', acmeLib: lib
      });

      const account = await renewer.ensureAccount();
      assert.match(account.accountKey, /BEGIN RSA PRIVATE KEY/);
      assert.equal(account.accountUrl, 'https://acme/acct/99');
      assert.equal(account.email, 'ops@example.com');

      // Stored in PlatformDB with accountKey ENCRYPTED
      const stored = db._kv.get('acme-account');
      assert.ok(stored);
      assert.equal(stored.accountUrl, 'https://acme/acct/99');
      assert.notEqual(stored.accountKey, account.accountKey, 'stored key must not equal plaintext');
      const decrypted = AtRestEncryption.decrypt(stored.accountKey, atRestKey).toString('utf8');
      assert.equal(decrypted, account.accountKey);

      // Verify acme-client was actually called
      assert.ok(events.find(e => e[0] === 'createAccount'));
    });

    it('is idempotent: reuses the persisted account on subsequent calls', async () => {
      const db = makeFakePlatformDB();
      const { lib, events } = makeFakeAcmeLib({ bundlePem: realCertPem('x.test') });
      const renewer = new CertRenewer({
        platformDB: db, atRestKey, email: 'ops@example.com', acmeLib: lib
      });

      const a1 = await renewer.ensureAccount();
      const eventsAfterFirst = events.length;
      const a2 = await renewer.ensureAccount();
      assert.equal(a1.accountUrl, a2.accountUrl);
      // Second call should NOT have added createPrivateKey / createAccount events
      const sinceSecond = events.slice(eventsAfterFirst);
      assert.equal(sinceSecond.find(e => e[0] === 'createAccount'), undefined);
    });
  });

  describe('renew()', () => {
    it('issues, encrypts the keyPem, persists cert + returns metadata', async () => {
      const db = makeFakePlatformDB();
      const certPem = realCertPem('*.example.test');
      const { lib } = makeFakeAcmeLib({ bundlePem: certPem, identifierForChallenge: 'example.test' });
      const renewer = new CertRenewer({
        platformDB: db, atRestKey, email: 'o@x.com', acmeLib: lib
      });
      const writer = {
        created: [],
        removed: [],
        async create (name, v) { this.created.push([name, v]); },
        async remove (name, v) { this.removed.push([name, v]); }
      };

      const result = await renewer.renew({
        hostname: '*.example.test',
        altNames: ['example.test'],
        dnsWriter: writer
      });

      assert.equal(result.hostname, '*.example.test');
      assert.ok(Number.isInteger(result.issuedAt));
      assert.ok(Number.isInteger(result.expiresAt));

      // DNS writer got the right challenge name (wildcard stripped)
      assert.deepEqual(writer.created, [['_acme-challenge.example.test', 'ka-value']]);
      assert.deepEqual(writer.removed, [['_acme-challenge.example.test', 'ka-value']]);

      // Stored cert has PEMs and the keyPem is encrypted
      const storedCert = db._kv.get('cert/*.example.test');
      assert.ok(storedCert);
      assert.ok(storedCert.certPem.includes('BEGIN CERTIFICATE'));
      assert.notEqual(storedCert.keyPem, '');
      assert.ok(!storedCert.keyPem.includes('BEGIN PRIVATE KEY'),
        'stored keyPem must not leak plaintext');
      // Decrypts back to the plaintext
      const plainKey = AtRestEncryption.decrypt(storedCert.keyPem, atRestKey).toString('utf8');
      assert.match(plainKey, /BEGIN PRIVATE KEY/);
    });

    it('strips wildcard prefix for the challenge record name', async () => {
      const db = makeFakePlatformDB();
      const { lib } = makeFakeAcmeLib({
        bundlePem: realCertPem('*.example.test'),
        identifierForChallenge: 'example.test'
      });
      const renewer = new CertRenewer({
        platformDB: db, atRestKey, email: 'o@x.com', acmeLib: lib
      });
      const writer = { created: [], async create (name) { this.created.push(name); }, async remove () {} };
      await renewer.renew({
        hostname: '*.example.test', dnsWriter: writer
      });
      assert.deepEqual(writer.created, ['_acme-challenge.example.test']);
    });

    it('rejects missing hostname / dnsWriter', async () => {
      const db = makeFakePlatformDB();
      const { lib } = makeFakeAcmeLib({ bundlePem: realCertPem('x') });
      const renewer = new CertRenewer({
        platformDB: db, atRestKey, email: 'a@b.c', acmeLib: lib
      });
      await assert.rejects(renewer.renew({ dnsWriter: { create () {}, remove () {} } }), /hostname is required/);
      await assert.rejects(renewer.renew({ hostname: 'x' }), /dnsWriter/);
    });
  });

  describe('getCertificate()', () => {
    it('returns null when no cert is stored', async () => {
      const db = makeFakePlatformDB();
      const renewer = new CertRenewer({
        platformDB: db, atRestKey, email: 'a@b.c'
      });
      const result = await renewer.getCertificate('missing.example.com');
      assert.equal(result, null);
    });

    it('returns a decrypted cert when one is stored', async () => {
      const db = makeFakePlatformDB();
      const certPem = realCertPem('host.test');
      const { lib } = makeFakeAcmeLib({
        bundlePem: certPem, identifierForChallenge: 'host.test'
      });
      const renewer = new CertRenewer({
        platformDB: db, atRestKey, email: 'a@b.c', acmeLib: lib
      });
      await renewer.renew({
        hostname: 'host.test',
        dnsWriter: { async create () {}, async remove () {} }
      });
      const out = await renewer.getCertificate('host.test');
      assert.ok(out);
      assert.match(out.keyPem, /BEGIN PRIVATE KEY/, 'keyPem should be decrypted');
      assert.match(out.certPem, /BEGIN CERTIFICATE/);
    });
  });
});

describe('[CERTRENEWER] PlatformDBDnsWriter', () => {
  it('setDnsRecord appends to existing TXT values; deleteDnsRecord when last removed', async () => {
    const db = makeFakePlatformDB();
    const writer = new PlatformDBDnsWriter({ platformDB: db, waitMs: 0 });
    await writer.create('_acme-challenge.ex.com', 'v1');
    await writer.create('_acme-challenge.ex.com', 'v2');
    assert.deepEqual(db._dns.get('_acme-challenge.ex.com'), { txt: ['v1', 'v2'] });
    // Removing v1 keeps v2 around
    await writer.remove('_acme-challenge.ex.com', 'v1');
    assert.deepEqual(db._dns.get('_acme-challenge.ex.com'), { txt: ['v2'] });
    // Removing the last value deletes the record
    await writer.remove('_acme-challenge.ex.com', 'v2');
    assert.equal(db._dns.get('_acme-challenge.ex.com'), undefined);
  });

  it('remove is a no-op when the record does not exist', async () => {
    const db = makeFakePlatformDB();
    const writer = new PlatformDBDnsWriter({ platformDB: db, waitMs: 0 });
    await writer.remove('_acme-challenge.never.seen', 'v');
    // didn\'t throw; no entries
    assert.equal(db._dns.size, 0);
  });

  it('waitMs delays create but not remove', async () => {
    const db = makeFakePlatformDB();
    const writer = new PlatformDBDnsWriter({ platformDB: db, waitMs: 50 });
    const t0 = Date.now();
    await writer.create('_acme.ex.com', 'v');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 40, `create should wait; elapsed=${elapsed}`);
    const t1 = Date.now();
    await writer.remove('_acme.ex.com', 'v');
    const elapsedRm = Date.now() - t1;
    assert.ok(elapsedRm < 20, `remove should not wait; elapsed=${elapsedRm}`);
  });
});

describe('[CERTRENEWER] acmeChallengeName()', () => {
  it('strips leading wildcard', () => {
    assert.equal(acmeChallengeName('*.mc.example.com'), '_acme-challenge.mc.example.com');
  });
  it('leaves bare host alone', () => {
    assert.equal(acmeChallengeName('host.example.com'), '_acme-challenge.host.example.com');
  });
});
