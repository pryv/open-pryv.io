/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for ClusterCA.
 *
 * Uses the system `openssl` binary for certificate work (same approach as
 * the production code). Skips the whole suite when openssl is missing.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ClusterCA = require('../../src/bootstrap/ClusterCA.ts').default;

describe('[CLUSTERCA] ClusterCA', function () {
  this.timeout(20_000);

  let tmpDir;

  before(function () {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      console.log('  skipping: openssl not available');
      this.skip();
    }
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-clusterca-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ensure()', () => {
    it('creates ca.key and ca.crt on first call', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const res = ca.ensure();
      assert.equal(res.created, true);
      assert(fs.existsSync(path.join(tmpDir, 'ca.key')));
      assert(fs.existsSync(path.join(tmpDir, 'ca.crt')));
    });

    it('is idempotent — second call reports created:false and leaves files untouched', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      ca.ensure();
      const mtime1 = fs.statSync(path.join(tmpDir, 'ca.crt')).mtimeMs;
      const res = ca.ensure();
      assert.equal(res.created, false);
      const mtime2 = fs.statSync(path.join(tmpDir, 'ca.crt')).mtimeMs;
      assert.equal(mtime1, mtime2);
    });

    it('sets 0600 permissions on the CA private key', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      ca.ensure();
      const mode = fs.statSync(path.join(tmpDir, 'ca.key')).mode & 0o777;
      assert.equal(mode, 0o600);
    });
  });

  describe('getCACertPem()', () => {
    it('returns a PEM-encoded CA cert', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      ca.ensure();
      const pem = ca.getCACertPem();
      assert(pem.startsWith('-----BEGIN CERTIFICATE-----'));
      // Sanity-check: parseable as X.509
      const x509 = new crypto.X509Certificate(pem);
      assert.equal(x509.subject, 'CN=pryv-cluster-ca');
      assert.equal(x509.issuer, 'CN=pryv-cluster-ca', 'CA cert is self-signed');
    });

    it('throws before ensure() has been called', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      assert.throws(() => ca.getCACertPem(), /not found.*call ensure/);
    });
  });

  describe('issueNodeCert()', () => {
    it('returns a PEM cert + key pair', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const { certPem, keyPem } = ca.issueNodeCert({ coreId: 'core-b' });
      assert(certPem.startsWith('-----BEGIN CERTIFICATE-----'));
      assert(keyPem.includes('PRIVATE KEY'));
    });

    it('signs node cert with the cluster CA', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const { certPem } = ca.issueNodeCert({ coreId: 'core-b' });
      const x509 = new crypto.X509Certificate(certPem);
      const caX509 = new crypto.X509Certificate(ca.getCACertPem());
      assert.equal(x509.subject, 'CN=core-b');
      assert.equal(x509.issuer, 'CN=pryv-cluster-ca');
      assert.equal(x509.checkIssued(caX509), true, 'cert is issued by the CA');
      assert.equal(x509.verify(caX509.publicKey), true, 'cert signature verifies against CA pubkey');
    });

    it('includes the coreId as a DNS SAN', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const { certPem } = ca.issueNodeCert({ coreId: 'core-b' });
      const x509 = new crypto.X509Certificate(certPem);
      assert(/DNS:core-b/.test(x509.subjectAltName), `SAN=${x509.subjectAltName}`);
    });

    it('includes an IP SAN when ip is given', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const { certPem } = ca.issueNodeCert({ coreId: 'core-b', ip: '10.0.0.5' });
      const x509 = new crypto.X509Certificate(certPem);
      assert(/IP Address:10\.0\.0\.5/.test(x509.subjectAltName), `SAN=${x509.subjectAltName}`);
    });

    it('includes a hostname SAN when different from coreId', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const { certPem } = ca.issueNodeCert({ coreId: 'core-b', hostname: 'core-b.mc.example.com' });
      const x509 = new crypto.X509Certificate(certPem);
      assert(/DNS:core-b\.mc\.example\.com/.test(x509.subjectAltName), `SAN=${x509.subjectAltName}`);
    });

    it('auto-calls ensure() when the CA does not yet exist', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      assert(!fs.existsSync(path.join(tmpDir, 'ca.crt')));
      ca.issueNodeCert({ coreId: 'core-b' });
      assert(fs.existsSync(path.join(tmpDir, 'ca.crt')));
    });

    it('produces distinct key pairs for distinct cores', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const certA = ca.issueNodeCert({ coreId: 'core-a' });
      const certB = ca.issueNodeCert({ coreId: 'core-b' });
      assert.notEqual(certA.keyPem, certB.keyPem);
      assert.notEqual(certA.certPem, certB.certPem);
    });

    it('does not leave temporary files in the CA directory', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      ca.issueNodeCert({ coreId: 'core-b' });
      // After issuance the CA dir must contain only ca.key + ca.crt; ca.srl
      // is OpenSSL's serial file and may or may not be present depending on
      // the OpenSSL version (1.x always emits it; 3.x sometimes does not).
      // The intent here is to verify no .csr / .key.tmp / .ext leaks.
      const allowed = new Set(['ca.crt', 'ca.key', 'ca.srl']);
      const unexpected = fs.readdirSync(tmpDir).filter(e => !allowed.has(e));
      assert.deepEqual(unexpected, [], `unexpected files in CA dir: ${unexpected.join(', ')}`);
    });

    it('throws when coreId is missing', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      assert.throws(() => ca.issueNodeCert({}), /coreId/);
    });
  });

  describe('[CLCX] extensions', () => {
    const text = (pem) => execFileSync('openssl', ['x509', '-noout', '-text'], { input: pem }).toString();

    it('[CLCX1] the CA is a CA limited to end-entity certs (pathlen 0) that signs certs and CRLs only', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      ca.ensure();
      const t = text(ca.getCACertPem());
      assert.match(t, /Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
      assert.match(t, /Key Usage: critical\s+Certificate Sign, CRL Sign/);
      assert.equal(new crypto.X509Certificate(ca.getCACertPem()).ca, true);
    });

    it('[CLCX2] a node cert is an end entity for TLS server and client use, signed digitally only', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const { certPem } = ca.issueNodeCert({ coreId: 'core-b', ip: '10.0.0.5', hostname: 'core-b.mc.example.com' });
      const t = text(certPem);
      assert.match(t, /Basic Constraints: critical\s+CA:FALSE/);
      assert.match(t, /Key Usage: critical\s+Digital Signature\s/);
      assert.match(t, /Extended Key Usage:\s+TLS Web Server Authentication, TLS Web Client Authentication/);
      assert.match(t, /Authority Key Identifier/);
      const x509 = new crypto.X509Certificate(certPem);
      assert.equal(x509.ca, false);
      assert.match(x509.subjectAltName, /DNS:core-b, DNS:core-b\.mc\.example\.com, IP Address:10\.0\.0\.5/);
    });

    it('[CLCX4] refuses a coreId, hostname or ip that is not a plain name or address', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      assert.throws(() => ca.issueNodeCert({ coreId: 'core-b\nbasicConstraints = CA:TRUE' }), /invalid coreId/);
      assert.throws(() => ca.issueNodeCert({ coreId: 'core-b, DNS:evil.example' }), /invalid coreId/);
      assert.throws(() => ca.issueNodeCert({ coreId: 'core-b', hostname: 'x/CN=evil' }), /invalid hostname/);
      assert.throws(() => ca.issueNodeCert({ coreId: 'core-b', ip: '10.0.0.5, DNS:evil' }), /invalid ip/);
      assert.ok(ca.issueNodeCert({ coreId: 'core-b', hostname: 'core-b.mc.example.com', ip: '2001:db8::1' }).certPem);
    });

    it('[CLCX3] a node cert cannot sign another cert that a TLS peer would accept', () => {
      const ca = new ClusterCA({ dir: tmpDir });
      const node = ca.issueNodeCert({ coreId: 'core-b' });
      const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-clcx-'));
      try {
        // A cert "issued" by the node cert, then verified against the cluster CA.
        fs.writeFileSync(path.join(nodeDir, 'node.crt'), node.certPem);
        fs.writeFileSync(path.join(nodeDir, 'node.key'), node.keyPem);
        execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(nodeDir, 'leaf.key')]);
        execFileSync('openssl', ['req', '-new', '-key', path.join(nodeDir, 'leaf.key'), '-subj', '/CN=rogue', '-out', path.join(nodeDir, 'leaf.csr')]);
        execFileSync('openssl', ['x509', '-req', '-in', path.join(nodeDir, 'leaf.csr'), '-CA', path.join(nodeDir, 'node.crt'),
          '-CAkey', path.join(nodeDir, 'node.key'), '-CAcreateserial', '-CAserial', path.join(nodeDir, 'node.srl'),
          '-days', '1', '-out', path.join(nodeDir, 'leaf.crt')]);
        fs.writeFileSync(path.join(nodeDir, 'ca.crt'), ca.getCACertPem());
        assert.throws(() => execFileSync('openssl', ['verify', '-CAfile', path.join(nodeDir, 'ca.crt'),
          '-untrusted', path.join(nodeDir, 'node.crt'), path.join(nodeDir, 'leaf.crt')], { stdio: 'pipe' }),
        'a chain through a node cert must not verify');
        // The node cert itself does.
        execFileSync('openssl', ['verify', '-CAfile', path.join(nodeDir, 'ca.crt'), path.join(nodeDir, 'node.crt')], { stdio: 'pipe' });
      } finally {
        fs.rmSync(nodeDir, { recursive: true, force: true });
      }
    });
  });

  describe('validity periods', () => {
    it('respects caValidityDays + nodeValidityDays overrides', () => {
      const ca = new ClusterCA({ dir: tmpDir, caValidityDays: 7, nodeValidityDays: 3 });
      const caPem = ca.ensure() && ca.getCACertPem();
      const nodePem = ca.issueNodeCert({ coreId: 'core-b' }).certPem;
      const caX509 = new crypto.X509Certificate(caPem);
      const nodeX509 = new crypto.X509Certificate(nodePem);
      const caLifetimeDays = (Date.parse(caX509.validToDate) - Date.parse(caX509.validFromDate)) / 86_400_000;
      const nodeLifetimeDays = (Date.parse(nodeX509.validToDate) - Date.parse(nodeX509.validFromDate)) / 86_400_000;
      // openssl rounds to the nearest day; allow ±1 day slack
      assert(Math.abs(caLifetimeDays - 7) <= 1, `CA lifetime ${caLifetimeDays}`);
      assert(Math.abs(nodeLifetimeDays - 3) <= 1, `Node lifetime ${nodeLifetimeDays}`);
    });
  });
});
