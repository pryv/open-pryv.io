/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 54 Phase C — `cliOps.initCaHolder()` unit tests.
 *
 * Covers:
 *   - first run mints CA + node cert, writes TLS files, merges
 *     rqlite.tls.* into override-config.yml.
 *   - re-run is idempotent (no errors, file mtimes preserved when nothing
 *     changes).
 *   - --no-write-config branch: TLS files written but override-config left
 *     untouched.
 *   - the issued node cert + an applyBundle-style joiner cert from the same
 *     ClusterCA complete an in-process Node tls handshake with
 *     `requestCert: true` + `rejectUnauthorized: true` on both sides — the
 *     mTLS invariant the rqlited cluster relies on.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

const cliOps = require('../../src/bootstrap/cliOps');
const ClusterCA = require('../../src/bootstrap/ClusterCA');

describe('[INITCAHOLDER] cliOps.initCaHolder', function () {
  this.timeout(20_000);

  let tmp;

  before(function () {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
      console.log('  skipping: openssl not available');
      this.skip();
    }
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-initca-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('first run: mints CA, writes TLS files, merges rqlite.tls into override-config', async () => {
    const caDir = path.join(tmp, 'ca');
    const tlsDir = path.join(tmp, 'tls');
    const overridePath = path.join(tmp, 'config', 'override-config.yml');

    const result = await cliOps.initCaHolder({
      caDir,
      tlsDir,
      coreId: 'core-a',
      ip: '198.51.100.7',
      hostname: 'core-a.mc.example.com',
      overridePath
    });

    assert.equal(result.caCreated, true);
    assert.equal(result.tlsCreated, true);
    assert.equal(result.configUpdated, true);

    assert.equal(result.tlsPaths.caFile, path.join(tlsDir, 'ca.crt'));
    assert.equal(result.tlsPaths.certFile, path.join(tlsDir, 'node.crt'));
    assert.equal(result.tlsPaths.keyFile, path.join(tlsDir, 'node.key'));

    assert.ok(fs.readFileSync(result.tlsPaths.caFile, 'utf8').includes('BEGIN CERTIFICATE'));
    assert.ok(fs.readFileSync(result.tlsPaths.certFile, 'utf8').includes('BEGIN CERTIFICATE'));
    assert.ok(fs.readFileSync(result.tlsPaths.keyFile, 'utf8').includes('PRIVATE KEY'));
    assert.equal(fs.statSync(result.tlsPaths.keyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.tlsPaths.caFile).mode & 0o777, 0o644);

    const parsed = yaml.load(fs.readFileSync(overridePath, 'utf8'));
    assert.deepEqual(parsed.storages.engines.rqlite.tls, {
      caFile: result.tlsPaths.caFile,
      certFile: result.tlsPaths.certFile,
      keyFile: result.tlsPaths.keyFile,
      verifyClient: true
    });
    assert.equal(fs.statSync(overridePath).mode & 0o777, 0o600);
  });

  it('idempotent on re-run: no errors, no rewrite when state already matches', async () => {
    const caDir = path.join(tmp, 'ca');
    const tlsDir = path.join(tmp, 'tls');
    const overridePath = path.join(tmp, 'config', 'override-config.yml');

    const r1 = await cliOps.initCaHolder({
      caDir, tlsDir, coreId: 'core-a', overridePath
    });
    const certPemBefore = fs.readFileSync(r1.tlsPaths.certFile, 'utf8');
    const overrideBefore = fs.readFileSync(overridePath, 'utf8');

    const r2 = await cliOps.initCaHolder({
      caDir, tlsDir, coreId: 'core-a', overridePath
    });
    assert.equal(r2.caCreated, false);
    assert.equal(r2.tlsCreated, false);
    assert.equal(r2.configUpdated, false);

    // Files were not regenerated (same node cert, same override file content).
    assert.equal(fs.readFileSync(r1.tlsPaths.certFile, 'utf8'), certPemBefore);
    assert.equal(fs.readFileSync(overridePath, 'utf8'), overrideBefore);
  });

  it('preserves unrelated keys when merging rqlite.tls into existing override-config', async () => {
    const caDir = path.join(tmp, 'ca');
    const tlsDir = path.join(tmp, 'tls');
    const configDir = path.join(tmp, 'config');
    const overridePath = path.join(configDir, 'override-config.yml');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(overridePath, yaml.dump({
      core: { id: 'core-a', url: 'https://core-a.example.com/' },
      auth: { adminAccessKey: 'preset-admin-key' }
    }));

    await cliOps.initCaHolder({
      caDir, tlsDir, coreId: 'core-a', overridePath
    });

    const parsed = yaml.load(fs.readFileSync(overridePath, 'utf8'));
    assert.equal(parsed.core.id, 'core-a');
    assert.equal(parsed.auth.adminAccessKey, 'preset-admin-key');
    assert.equal(parsed.storages.engines.rqlite.tls.verifyClient, true);
  });

  it('--no-write-config: writes TLS files but leaves override-config untouched', async () => {
    const caDir = path.join(tmp, 'ca');
    const tlsDir = path.join(tmp, 'tls');
    const overridePath = path.join(tmp, 'config', 'override-config.yml');

    const result = await cliOps.initCaHolder({
      caDir,
      tlsDir,
      coreId: 'core-a',
      writeConfig: false
    });

    assert.equal(result.tlsCreated, true);
    assert.equal(result.configUpdated, false);
    assert.ok(fs.existsSync(result.tlsPaths.certFile));
    assert.equal(fs.existsSync(overridePath), false);
  });

  it('throws when writeConfig is true but overridePath is missing', async () => {
    await assert.rejects(
      cliOps.initCaHolder({
        caDir: path.join(tmp, 'ca'),
        tlsDir: path.join(tmp, 'tls'),
        coreId: 'core-a'
      }),
      /overridePath is required/
    );
  });

  it('mTLS handshake: CA-holder cert + joiner cert succeed with mutual verifyClient', async () => {
    // Holder-side material via initCaHolder.
    const caDir = path.join(tmp, 'ca');
    const holderTlsDir = path.join(tmp, 'tls-a');
    const overridePath = path.join(tmp, 'cfg', 'override-config.yml');
    const holder = await cliOps.initCaHolder({
      caDir,
      tlsDir: holderTlsDir,
      coreId: 'core-a',
      ip: '127.0.0.1',
      overridePath
    });

    // Joiner-side material directly off the same ClusterCA — same code path
    // applyBundle would take after decrypt.
    const ca = new ClusterCA({ dir: caDir });
    ca.ensure();
    const joiner = ca.issueNodeCert({ coreId: 'core-b', ip: '127.0.0.1' });

    const caPem = fs.readFileSync(holder.tlsPaths.caFile, 'utf8');
    const certPemA = fs.readFileSync(holder.tlsPaths.certFile, 'utf8');
    const keyPemA = fs.readFileSync(holder.tlsPaths.keyFile, 'utf8');

    const server = tls.createServer({
      key: keyPemA,
      cert: certPemA,
      ca: caPem,
      requestCert: true,
      rejectUnauthorized: true
    }, (socket) => {
      // Echo the peer's CN-derived authorized status so the client can read it.
      const authorized = socket.authorized;
      socket.end(authorized ? 'OK' : 'NOPE');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const handshakeResult = await new Promise((resolve, reject) => {
      const client = tls.connect({
        host: '127.0.0.1',
        port,
        ca: caPem,
        cert: joiner.certPem,
        key: joiner.keyPem,
        rejectUnauthorized: true,
        // SAN of the holder cert is `DNS:core-a` — checkServerIdentity is
        // hostname-based, so override it for this loopback test.
        checkServerIdentity: () => undefined
      });
      let buf = '';
      client.on('data', (chunk) => { buf += chunk.toString(); });
      client.on('end', () => resolve(buf));
      client.on('error', reject);
    });
    assert.equal(handshakeResult, 'OK');

    await new Promise(resolve => server.close(resolve));
  });
});
