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

const { FileMaterializer, runRotateScript } = require('../../src/acme/FileMaterializer');

/** Stubby CertRenewer returning a scripted sequence of getCertificate results. */
function makeFakeRenewer (sequence) {
  let idx = 0;
  return {
    async getCertificate (hostname) {
      const entry = sequence[idx];
      if (idx < sequence.length - 1) idx++;
      if (entry == null) return null;
      return entry[hostname] ?? null;
    }
  };
}

const mkCert = (leaf, key, issuedAt = 1000, expiresAt = 2000) => ({
  certPem: leaf,
  chainPem: '',
  keyPem: key,
  issuedAt,
  expiresAt
});

describe('[FILEMAT] FileMaterializer', () => {
  let tmp;

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-fm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  describe('constructor validation', () => {
    it('rejects missing args', () => {
      assert.throws(() => new FileMaterializer({}), /certRenewer is required/);
      assert.throws(() => new FileMaterializer({ certRenewer: {} }), /tlsDir is required/);
      assert.throws(() => new FileMaterializer({ certRenewer: {}, tlsDir: '/tmp' }), /hostname is required/);
    });
  });

  describe('checkOnce()', () => {
    it('writes fresh cert on first call (initial-write)', async () => {
      const renewer = makeFakeRenewer([{
        '*.example.com': mkCert('LEAF', 'KEY', 100, 200)
      }]);
      let rotated = null;
      const fm = new FileMaterializer({
        certRenewer: renewer,
        tlsDir: tmp,
        hostname: '*.example.com',
        onRotate: async (c, k, h) => { rotated = { c, k, h }; },
        log: () => {}
      });
      const r = await fm.checkOnce();
      assert.equal(r.rotated, true);
      assert.equal(r.reason, 'initial-write');
      assert.equal(fm.hostDir, path.join(tmp, 'wildcard.example.com'));
      assert.equal(fs.readFileSync(fm.certPath, 'utf8'), 'LEAF');
      assert.equal(fs.readFileSync(fm.keyPath, 'utf8'), 'KEY');
      assert.equal(fs.statSync(fm.keyPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(fm.certPath).mode & 0o777, 0o644);
      assert.deepEqual(rotated, { c: fm.certPath, k: fm.keyPath, h: '*.example.com' });
    });

    it('concatenates cert + chain into fullchain.pem', async () => {
      const renewer = makeFakeRenewer([{
        'host.test': { certPem: 'LEAF', chainPem: 'CHAIN', keyPem: 'K', issuedAt: 1, expiresAt: 2 }
      }]);
      const fm = new FileMaterializer({ certRenewer: renewer, tlsDir: tmp, hostname: 'host.test', log: () => {} });
      await fm.checkOnce();
      assert.equal(fs.readFileSync(fm.certPath, 'utf8'), 'LEAFCHAIN');
    });

    it('is idempotent: second call with same cert returns unchanged', async () => {
      const c = mkCert('LEAF', 'KEY');
      const renewer = makeFakeRenewer([{ 'h.test': c }, { 'h.test': c }]);
      let hookCalls = 0;
      const fm = new FileMaterializer({
        certRenewer: renewer,
        tlsDir: tmp,
        hostname: 'h.test',
        onRotate: async () => { hookCalls++; },
        log: () => {}
      });
      const r1 = await fm.checkOnce();
      const r2 = await fm.checkOnce();
      assert.equal(r1.rotated, true);
      assert.equal(r2.rotated, false);
      assert.equal(r2.reason, 'unchanged');
      assert.equal(hookCalls, 1, 'onRotate fires only when cert changes');
    });

    it('detects cert change and re-rotates', async () => {
      const renewer = makeFakeRenewer([
        { 'h.test': mkCert('LEAF-1', 'KEY-1') },
        { 'h.test': mkCert('LEAF-2', 'KEY-2') }
      ]);
      const rotations = [];
      const fm = new FileMaterializer({
        certRenewer: renewer,
        tlsDir: tmp,
        hostname: 'h.test',
        onRotate: async () => { rotations.push('rotated'); },
        log: () => {}
      });
      await fm.checkOnce();
      const r = await fm.checkOnce();
      assert.equal(r.rotated, true);
      assert.equal(r.reason, 'cert-changed');
      assert.equal(fs.readFileSync(fm.certPath, 'utf8'), 'LEAF-2');
      assert.equal(fs.readFileSync(fm.keyPath, 'utf8'), 'KEY-2');
      assert.equal(rotations.length, 2);
    });

    it('returns { rotated:false, reason:"no-cert-in-platformdb" } when there\'s nothing stored', async () => {
      const renewer = makeFakeRenewer([null]);
      const fm = new FileMaterializer({
        certRenewer: renewer, tlsDir: tmp, hostname: 'h.test', log: () => {}
      });
      const r = await fm.checkOnce();
      assert.equal(r.rotated, false);
      assert.equal(r.reason, 'no-cert-in-platformdb');
      assert.equal(fs.existsSync(fm.certPath), false);
    });

    it('swallows onRotate errors — cert still written', async () => {
      const renewer = makeFakeRenewer([{ 'h.test': mkCert('LEAF', 'KEY') }]);
      const fm = new FileMaterializer({
        certRenewer: renewer,
        tlsDir: tmp,
        hostname: 'h.test',
        onRotate: async () => { throw new Error('reload-nginx failed'); },
        log: () => {}
      });
      // Should NOT throw
      const r = await fm.checkOnce();
      assert.equal(r.rotated, true);
      assert.equal(fs.readFileSync(fm.certPath, 'utf8'), 'LEAF');
    });
  });
});

describe('[FILEMAT] runRotateScript', function () {
  this.timeout(10_000);
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-rs-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('runs a script with PRYV_CERT_* env vars and captures stdout', async () => {
    const script = path.join(tmp, 'ok.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho "host=$PRYV_CERT_HOSTNAME cert=$PRYV_CERT_PATH key=$PRYV_CERT_KEYPATH"\n', { mode: 0o755 });
    const r = await runRotateScript({
      scriptPath: script,
      hostname: '*.ex.com',
      certPath: '/etc/pryv/tls/wildcard.ex.com/fullchain.pem',
      keyPath: '/etc/pryv/tls/wildcard.ex.com/privkey.pem'
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /host=\*\.ex\.com/);
    assert.match(r.stdout, /cert=\/etc\/pryv\/tls\/wildcard\.ex\.com\/fullchain\.pem/);
    assert.match(r.stdout, /key=\/etc\/pryv\/tls\/wildcard\.ex\.com\/privkey\.pem/);
  });

  it('returns non-zero exitCode for a failing script (no throw)', async () => {
    const script = path.join(tmp, 'fail.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho bad >&2\nexit 7\n', { mode: 0o755 });
    const r = await runRotateScript({
      scriptPath: script, hostname: 'x', certPath: '/c', keyPath: '/k'
    });
    assert.equal(r.exitCode, 7);
    assert.match(r.stderr, /bad/);
  });

  it('kills the script after timeoutMs (exitCode 124)', async () => {
    // Use a node hang-loop rather than `bash + sleep` — bash delegates to
    // a child `sleep` which can keep stdio pipes open past the bash kill,
    // blocking the 'close' event.
    const script = path.join(tmp, 'hang.js');
    fs.writeFileSync(script,
      '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n',
      { mode: 0o755 });
    const r = await runRotateScript({
      scriptPath: script,
      hostname: 'x',
      certPath: '/c',
      keyPath: '/k',
      timeoutMs: 200
    });
    assert.equal(r.exitCode, 124);
    assert.ok(r.durationMs >= 200 && r.durationMs < 3000);
  });

  it('rejects relative scriptPath (security)', async () => {
    await assert.rejects(
      runRotateScript({
        scriptPath: 'not-absolute.sh', hostname: 'x', certPath: '/c', keyPath: '/k'
      }),
      /absolute path/
    );
  });
});
