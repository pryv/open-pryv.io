/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { splitCertChain, parseValidity, hostnameToDirName } = require('../../src/acme/certUtils');

describe('[CERTUTILS] certUtils', () => {
  describe('splitCertChain()', () => {
    const leaf = '-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----';
    const issuer = '-----BEGIN CERTIFICATE-----\nISSUER\n-----END CERTIFICATE-----';

    it('splits a two-cert bundle into leaf and chain', () => {
      const bundle = leaf + '\n' + issuer + '\n';
      const { leafPem, chainPem } = splitCertChain(bundle);
      assert.ok(leafPem.includes('LEAF'));
      assert.ok(!leafPem.includes('ISSUER'));
      assert.ok(chainPem.includes('ISSUER'));
      assert.ok(leafPem.endsWith('\n'));
    });

    it('returns empty chain when bundle has only the leaf', () => {
      const { leafPem, chainPem } = splitCertChain(leaf + '\n');
      assert.ok(leafPem.includes('LEAF'));
      assert.equal(chainPem, '');
    });

    it('preserves a three-cert chain (leaf + intermediate + root)', () => {
      const bundle = [leaf, issuer, issuer].join('\n') + '\n';
      const { chainPem } = splitCertChain(bundle);
      const chainCount = (chainPem.match(/BEGIN CERTIFICATE/g) || []).length;
      assert.equal(chainCount, 2);
    });

    it('throws on non-PEM input', () => {
      assert.throws(() => splitCertChain('not a cert'), /not a PEM certificate/);
      assert.throws(() => splitCertChain(null), /not a PEM certificate/);
    });
  });

  describe('parseValidity()', () => {
    let tmp;
    before(function () {
      try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
        console.log('  skipping: openssl not available');
        this.skip();
      }
    });
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-certutils-')); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it('extracts validFrom/validTo as Unix ms and CN', () => {
      const keyPath = path.join(tmp, 'k.pem');
      const certPath = path.join(tmp, 'c.pem');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-noenc', '-keyout', keyPath, '-out', certPath,
        '-days', '30', '-subj', '/CN=test.example.com'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      const pem = fs.readFileSync(certPath, 'utf8');
      const now = Date.now();
      const { issuedAt, expiresAt, subject } = parseValidity(pem);
      assert.ok(issuedAt <= now && issuedAt > now - 24 * 3600 * 1000, `issuedAt=${issuedAt} vs now=${now}`);
      const thirtyDaysFromNow = now + 30 * 24 * 3600 * 1000;
      assert.ok(Math.abs(expiresAt - thirtyDaysFromNow) < 24 * 3600 * 1000,
        `expected ~${thirtyDaysFromNow}, got ${expiresAt}`);
      assert.match(subject, /CN=test\.example\.com/);
    });
  });

  describe('hostnameToDirName()', () => {
    it('wildcard → wildcard.<apex>', () => {
      assert.equal(hostnameToDirName('*.mc.example.com'), 'wildcard.mc.example.com');
    });
    it('plain hostname unchanged', () => {
      assert.equal(hostnameToDirName('core-b.example.com'), 'core-b.example.com');
    });
    it('rejects empty input', () => {
      assert.throws(() => hostnameToDirName(''), /required/);
      assert.throws(() => hostnameToDirName(null), /required/);
    });
  });
});
