/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const forge = require('node-forge');

const { generate, ensure } = require('../../src/acme/selfSignedPlaceholder');

function makeConfig (overrides = {}) {
  const store = {
    'letsEncrypt:enabled': true,
    'http:ssl:keyFile': null,
    'http:ssl:certFile': null,
    'dnsLess:isActive': false,
    'dnsLess:publicUrl': null,
    'dns:active': false,
    'dns:domain': null,
    'core:url': null,
    ...overrides
  };
  return { get (key) { return store[key]; } };
}

describe('[SSPL] selfSignedPlaceholder', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-sspl-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('generate()', () => {
    it('[SS01] produces a valid PEM cert + key with the requested CN + SAN', () => {
      const { keyPem, certPem } = generate({
        commonName: 'core-x.example.com',
        altNames: ['core-x.example.com', 'lsc.example.com']
      });
      assert.match(keyPem, /BEGIN .*PRIVATE KEY/);
      assert.match(certPem, /BEGIN CERTIFICATE/);
      const cert = forge.pki.certificateFromPem(certPem);
      assert.equal(cert.subject.getField('CN').value, 'core-x.example.com');
      const sanExt = cert.getExtension('subjectAltName');
      assert.ok(sanExt, 'cert must have a SAN extension');
      const sanValues = sanExt.altNames.map(a => a.value);
      assert.ok(sanValues.includes('core-x.example.com'));
      assert.ok(sanValues.includes('lsc.example.com'));
    });

    it('[SS02] cert validity is ~24 hours', () => {
      const before = new Date();
      const { certPem } = generate({ commonName: 'short.example.com' });
      const cert = forge.pki.certificateFromPem(certPem);
      const lifeMs = cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime();
      // 24h ± 5 min for clock-skew tolerance
      assert.ok(Math.abs(lifeMs - 24 * 60 * 60 * 1000) < 5 * 60 * 1000,
        `expected ~24h validity, got ${lifeMs}ms`);
      assert.ok(cert.validity.notBefore.getTime() >= before.getTime() - 1000);
    });

    it('[SS03] throws without a commonName', () => {
      assert.throws(() => generate({ commonName: '' }), /commonName/);
    });
  });

  describe('ensure()', () => {
    it('[SS10] no-ops when letsEncrypt is disabled', () => {
      const result = ensure({ config: makeConfig({ 'letsEncrypt:enabled': false }) });
      assert.equal(result.written, false);
      assert.equal(result.reason, 'letsEncrypt-disabled');
    });

    it('[SS11] no-ops when ssl paths are not configured', () => {
      const result = ensure({ config: makeConfig({ 'letsEncrypt:enabled': true }) });
      assert.equal(result.written, false);
      assert.equal(result.reason, 'ssl-paths-not-configured');
    });

    it('[SS12] no-ops when both cert files already exist', () => {
      const keyFile = path.join(tmp, 'privkey.pem');
      const certFile = path.join(tmp, 'fullchain.pem');
      fs.writeFileSync(keyFile, 'pre-existing key');
      fs.writeFileSync(certFile, 'pre-existing cert');
      const config = makeConfig({
        'letsEncrypt:enabled': true,
        'http:ssl:keyFile': keyFile,
        'http:ssl:certFile': certFile,
        'dnsLess:isActive': true,
        'dnsLess:publicUrl': 'https://x.example.com/'
      });
      const result = ensure({ config });
      assert.equal(result.written, false);
      assert.equal(result.reason, 'cert-files-already-exist');
      // Files unchanged
      assert.equal(fs.readFileSync(keyFile, 'utf8'), 'pre-existing key');
      assert.equal(fs.readFileSync(certFile, 'utf8'), 'pre-existing cert');
    });

    it('[SS13] writes a placeholder cert at the configured paths when missing (dnsLess + http-01)', () => {
      const keyFile = path.join(tmp, 'tls', 'x.example.com', 'privkey.pem');
      const certFile = path.join(tmp, 'tls', 'x.example.com', 'fullchain.pem');
      const config = makeConfig({
        'letsEncrypt:enabled': true,
        'http:ssl:keyFile': keyFile,
        'http:ssl:certFile': certFile,
        'dnsLess:isActive': true,
        'dnsLess:publicUrl': 'https://x.example.com/'
      });
      const result = ensure({ config });
      assert.equal(result.written, true);
      assert.equal(result.keyFile, keyFile);
      assert.equal(result.certFile, certFile);
      assert.match(fs.readFileSync(certFile, 'utf8'), /BEGIN CERTIFICATE/);
      assert.match(fs.readFileSync(keyFile, 'utf8'), /BEGIN .*PRIVATE KEY/);
      assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
      // CN matches the dnsLess hostname
      const cert = forge.pki.certificateFromPem(fs.readFileSync(certFile, 'utf8'));
      assert.equal(cert.subject.getField('CN').value, 'x.example.com');
    });

    it('[SS14] writes a wildcard placeholder when topology says dns-01 (embedded DNS multi-core)', () => {
      const keyFile = path.join(tmp, 'tls', 'wildcard.mc.example.com', 'privkey.pem');
      const certFile = path.join(tmp, 'tls', 'wildcard.mc.example.com', 'fullchain.pem');
      const config = makeConfig({
        'letsEncrypt:enabled': true,
        'http:ssl:keyFile': keyFile,
        'http:ssl:certFile': certFile,
        'dns:active': true,
        'dns:domain': 'mc.example.com'
      });
      const result = ensure({ config });
      assert.equal(result.written, true);
      const cert = forge.pki.certificateFromPem(fs.readFileSync(certFile, 'utf8'));
      assert.equal(cert.subject.getField('CN').value, '*.mc.example.com');
      const sanValues = cert.getExtension('subjectAltName').altNames.map(a => a.value);
      assert.ok(sanValues.includes('*.mc.example.com'));
      assert.ok(sanValues.includes('mc.example.com'));
    });
  });
});
