/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 34 Phase 4c — bootstrap consumer driver.
 *
 * Round-trips a real bundle through `consume()` with an injected fake
 * httpClient so we can assert the ack POST payload + the side effects on
 * disk (override-config.yml, TLS files, bundle file deleted on success).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ClusterCA = require('../../src/bootstrap/ClusterCA');
const Bundle = require('../../src/bootstrap/Bundle');
const BundleEncryption = require('../../src/bootstrap/BundleEncryption');
const consumer = require('../../src/bootstrap/consumer');

const PASSPHRASE = 'pass-9876';

function writeBundle (tmp, ackUrl = 'https://core-a.mc.example.com/system/admin/cores/ack') {
  const ca = new ClusterCA({ dir: path.join(tmp, 'issuer-ca') });
  ca.ensure();
  const { certPem, keyPem } = ca.issueNodeCert({
    coreId: 'core-b', ip: '203.0.113.7', hostname: 'core-b.mc.example.com'
  });
  const bundle = Bundle.assemble({
    cluster: {
      domain: 'mc.example.com',
      ackUrl,
      joinToken: '0123456789abcdef0123456789abcdef',
      caCertPem: ca.getCACertPem()
    },
    node: {
      id: 'core-b',
      ip: '203.0.113.7',
      hosting: 'us-east-1',
      url: 'https://core-b.mc.example.com',
      certPem,
      keyPem
    },
    platformSecrets: {
      auth: {
        adminAccessKey: 'admin-key-0123456789abcdef0123',
        filesReadTokenSecret: 'files-secret-0123456789abcdef0'
      }
    },
    rqlite: { raftPort: 4002, httpPort: 4001 }
  });
  const armored = BundleEncryption.encrypt(bundle, PASSPHRASE);
  const bundlePath = path.join(tmp, 'bundle.age');
  fs.writeFileSync(bundlePath, armored);
  return { bundlePath, caCertPem: ca.getCACertPem() };
}

describe('[BOOTSTRAPCONSUMER] consumer.consume', function () {
  this.timeout(20_000);

  let tmp;

  before(function () {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
      console.log('  skipping: openssl not available');
      this.skip();
    }
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-consume-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('happy path: applies bundle, posts ack with bundled CA pinned, deletes bundle', async () => {
    const { bundlePath, caCertPem } = writeBundle(tmp);
    const calls = [];
    const fakeClient = async (url, body, ca) => {
      calls.push({ url, body, ca });
      return { statusCode: 200, body: { ok: true, cluster: { cores: [{ id: 'core-a' }, { id: 'core-b' }] } } };
    };

    const result = await consumer.consume({
      bundlePath,
      passphrase: PASSPHRASE,
      configDir: path.join(tmp, 'config'),
      tlsDir: path.join(tmp, 'tls'),
      httpClient: fakeClient,
      log: () => {}
    });

    assert.equal(result.coreId, 'core-b');
    assert.equal(result.bundleDeleted, true);
    assert.equal(fs.existsSync(bundlePath), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://core-a.mc.example.com/system/admin/cores/ack');
    assert.equal(calls[0].body.coreId, 'core-b');
    assert.equal(calls[0].body.token, '0123456789abcdef0123456789abcdef');
    assert.match(calls[0].body.tlsFingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(calls[0].ca, caCertPem);

    // Override file written and reachable
    assert.ok(fs.existsSync(result.overridePath));
    assert.ok(fs.existsSync(result.tlsPaths.caFile));
  });

  it('throws and does NOT delete bundle when ack returns non-200', async () => {
    const { bundlePath } = writeBundle(tmp);
    const fakeClient = async () => ({ statusCode: 401, body: { error: { id: 'token-invalid' } } });

    await assert.rejects(
      consumer.consume({
        bundlePath,
        passphrase: PASSPHRASE,
        configDir: path.join(tmp, 'config'),
        tlsDir: path.join(tmp, 'tls'),
        httpClient: fakeClient,
        log: () => {}
      }),
      /ack failed: HTTP 401/
    );
    // Bundle stays so the operator can investigate / rotate
    assert.equal(fs.existsSync(bundlePath), true);
  });

  it('reads passphrase from --bootstrap-passphrase-file', async () => {
    const { bundlePath } = writeBundle(tmp);
    const passphraseFile = path.join(tmp, 'pass.txt');
    fs.writeFileSync(passphraseFile, PASSPHRASE + '\n'); // trailing newline must be stripped
    const fakeClient = async () => ({ statusCode: 200, body: { ok: true, cluster: { cores: [] } } });

    const result = await consumer.consume({
      bundlePath,
      passphraseFile,
      configDir: path.join(tmp, 'config'),
      tlsDir: path.join(tmp, 'tls'),
      httpClient: fakeClient,
      log: () => {}
    });
    assert.equal(result.coreId, 'core-b');
  });

  it('rejects when neither passphrase nor passphraseFile is given', async () => {
    const { bundlePath } = writeBundle(tmp);
    await assert.rejects(
      consumer.consume({
        bundlePath,
        configDir: path.join(tmp, 'config'),
        tlsDir: path.join(tmp, 'tls'),
        httpClient: async () => ({ statusCode: 200, body: {} }),
        log: () => {}
      }),
      /passphrase/
    );
  });

  it('rejects when bundle file is missing', async () => {
    await assert.rejects(
      consumer.consume({
        bundlePath: path.join(tmp, 'nope.age'),
        passphrase: PASSPHRASE,
        configDir: path.join(tmp, 'config'),
        tlsDir: path.join(tmp, 'tls'),
        log: () => {}
      }),
      /bundle file not found/
    );
  });

  it('rejects when wrong passphrase is provided (does NOT POST ack, does NOT delete bundle)', async () => {
    const { bundlePath } = writeBundle(tmp);
    let posted = false;
    const fakeClient = async () => { posted = true; return { statusCode: 200, body: {} }; };

    await assert.rejects(
      consumer.consume({
        bundlePath,
        passphrase: 'wrong-pass',
        configDir: path.join(tmp, 'config'),
        tlsDir: path.join(tmp, 'tls'),
        httpClient: fakeClient,
        log: () => {}
      }),
      /authentication failed/
    );
    assert.equal(posted, false);
    assert.equal(fs.existsSync(bundlePath), true);
  });

  it('rejects empty passphrase file', async () => {
    const { bundlePath } = writeBundle(tmp);
    const passphraseFile = path.join(tmp, 'empty.txt');
    fs.writeFileSync(passphraseFile, '');
    await assert.rejects(
      consumer.consume({
        bundlePath,
        passphraseFile,
        configDir: path.join(tmp, 'config'),
        tlsDir: path.join(tmp, 'tls'),
        log: () => {}
      }),
      /passphrase file is empty/
    );
  });
});
