/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the bootstrap consumer driver.
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

const ClusterCA = require('../../src/bootstrap/ClusterCA.ts').default;
const Bundle = require('../../src/bootstrap/Bundle.ts');
const BundleEncryption = require('../../src/bootstrap/BundleEncryption.ts');
const consumer = require('../../src/bootstrap/consumer.ts');

// The clock-skew probe is covered by [CKBJ]/[CKPB]; keep it off the network here.
const consume = (opts) => consumer.consume({ clockSkewSeconds: 0, ...opts });

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

    const result = await consume({
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

  it('trustSystemCa drops the cluster-CA pin on the ack POST', async () => {
    const { bundlePath } = writeBundle(tmp);
    const calls = [];
    const fakeClient = async (url, body, ca) => {
      calls.push({ url, body, ca });
      return { statusCode: 200, body: { ok: true, cluster: { cores: [] } } };
    };

    const result = await consume({
      bundlePath,
      passphrase: PASSPHRASE,
      configDir: path.join(tmp, 'config'),
      tlsDir: path.join(tmp, 'tls'),
      httpClient: fakeClient,
      trustSystemCa: true,
      log: () => {}
    });

    assert.equal(result.coreId, 'core-b');
    assert.equal(calls.length, 1);
    // No cluster CA pinned — defaultHttpClient falls back to the system store.
    assert.ok(!calls[0].ca, 'expected falsy ca when trustSystemCa is set');
  });

  it('throws and does NOT delete bundle when ack returns non-200', async () => {
    const { bundlePath } = writeBundle(tmp);
    const fakeClient = async () => ({ statusCode: 401, body: { error: { id: 'token-invalid' } } });

    await assert.rejects(
      consume({
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

    const result = await consume({
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
      consume({
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
      consume({
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
      consume({
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
      consume({
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

describe('[CKBJ] consumer.consume clock-skew check', function () {
  this.timeout(20_000);
  let tmp;

  before(function () {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
      this.skip();
    }
  });
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-consume-skew-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function setup (probeResult, extra = {}) {
    const { bundlePath, caCertPem } = writeBundle(tmp);
    const acks = [];
    const probes = [];
    const logs = [];
    const opts = {
      bundlePath,
      passphrase: PASSPHRASE,
      configDir: path.join(tmp, 'config'),
      tlsDir: path.join(tmp, 'tls'),
      httpClient: async (url, body, ca) => {
        acks.push({ url, body, ca });
        return { statusCode: 200, body: { cluster: { cores: [] } } };
      },
      clockProbe: async (origin, ca) => {
        probes.push({ origin, ca });
        if (probeResult === 'none') return null;
        const localMs = Date.now();
        return { serverTimeMs: localMs + probeResult, rttMs: 12, localMs };
      },
      log: (m) => logs.push(m),
      ...extra
    };
    return { opts, acks, probes, logs, bundlePath, caCertPem };
  }

  it('[CKB1] refuses the join before the ack when the issuer clock is 120s ahead', async () => {
    const { opts, acks, logs, bundlePath } = setup(120_000);
    await assert.rejects(consumer.consume(opts), /clock skew of -120\.0s .* exceeds 30s; the join token was not used/);
    assert.equal(acks.length, 0, 'no ack sent');
    assert.equal(fs.existsSync(bundlePath), true, 'bundle kept for the re-run');
    assert.ok(logs.some((l) => l.includes('Fix this host\'s clock')));
  });

  it('[CKB2] refuses a local clock that is ahead too', async () => {
    const { opts, acks } = setup(-120_000);
    await assert.rejects(consumer.consume(opts), /clock skew of \+120\.0s/);
    assert.equal(acks.length, 0);
  });

  it('[CKB3] acks when the skew is within the threshold', async () => {
    const { opts, acks, logs } = setup(10_000);
    const result = await consumer.consume(opts);
    assert.equal(result.bundleDeleted, true);
    assert.equal(acks.length, 1);
    assert.ok(logs.some((l) => l.startsWith('clock check vs https://core-a.mc.example.com: skew=-10.0s')));
  });

  it('[CKB4] a custom threshold applies', async () => {
    const { opts, acks } = setup(10_000, { clockSkewSeconds: 5 });
    await assert.rejects(consumer.consume(opts), /exceeds 5s/);
    assert.equal(acks.length, 0);
  });

  it('[CKB5] clockSkewSeconds 0 disables the probe', async () => {
    const { opts, acks, probes } = setup(3_600_000, { clockSkewSeconds: 0 });
    await consumer.consume(opts);
    assert.equal(probes.length, 0);
    assert.equal(acks.length, 1);
  });

  it('[CKB6] continues with a warning when the answer carries no server time', async () => {
    const { opts, acks, logs } = setup('none');
    await consumer.consume(opts);
    assert.equal(acks.length, 1);
    assert.ok(logs.some((l) => l.startsWith('clock-skew check skipped: no server time')));
  });

  it('[CKB8] a probe transport error names the probe and sends no ack', async () => {
    const { opts, acks, bundlePath } = setup(0, {
      clockProbe: async () => { throw new Error('connect ECONNREFUSED'); }
    });
    await assert.rejects(consumer.consume(opts),
      /clock probe GET https:\/\/core-a\.mc\.example\.com\/ failed: connect ECONNREFUSED/);
    assert.equal(acks.length, 0);
    assert.equal(fs.existsSync(bundlePath), true);
  });

  it('[CKB7] probes the ack origin with the same CA trust as the ack', async () => {
    const pinned = setup(0);
    await consumer.consume(pinned.opts);
    assert.deepEqual(pinned.probes, [{ origin: 'https://core-a.mc.example.com/', ca: pinned.caCertPem }]);

    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-consume-skew-'));
    const system = setup(0, { trustSystemCa: true });
    await consumer.consume(system.opts);
    assert.deepEqual(system.probes, [{ origin: 'https://core-a.mc.example.com/', ca: '' }]);
  });
});

describe('[CKPB] consumer.defaultClockProbe', function () {
  const http = require('node:http');
  let server, origin, handler;

  before((done) => {
    server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}/`;
      done();
    });
  });
  after((done) => { server.close(done); });

  it('[CKP1] reads meta.serverTime (seconds) and asks for JSON', async () => {
    let accept;
    handler = (req, res) => {
      accept = req.headers.accept;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ meta: { serverTime: 1700000000.5 } }));
    };
    const r = await consumer.defaultClockProbe(origin, '');
    assert.equal(accept, 'application/json');
    assert.equal(r.serverTimeMs, 1700000000500);
    assert.ok(r.rttMs >= 0);
    assert.ok(Math.abs(r.localMs - Date.now()) < 60_000);
  });

  it('[CKP2] falls back to the Date header', async () => {
    handler = (req, res) => {
      res.setHeader('content-type', 'text/html');
      res.setHeader('date', 'Tue, 14 Nov 2023 22:13:20 GMT');
      res.end('<html></html>');
    };
    const r = await consumer.defaultClockProbe(origin, '');
    assert.equal(r.serverTimeMs, Date.parse('Tue, 14 Nov 2023 22:13:20 GMT'));
  });

  it('[CKP3] resolves null when there is no server time at all', async () => {
    handler = (req, res) => {
      res.sendDate = false;
      res.end('{}');
    };
    assert.equal(await consumer.defaultClockProbe(origin, ''), null);
  });

  it('[CKP4] rejects on a transport error', async () => {
    await assert.rejects(consumer.defaultClockProbe('http://127.0.0.1:1/', ''));
  });
});
