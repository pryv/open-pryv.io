/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Acceptance-style tests for Plan 34 Phase 2e — bootstrap CLI orchestration.
 *
 * Exercises the same code path the operator-facing `bin/bootstrap.js` calls,
 * with everything externally-stateful injected: a fake PlatformDB, tmp dirs
 * for the cluster CA + token store + bundle output. No boiler, no rqlited.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const cliOps = require('../../src/bootstrap/cliOps');
const Bundle = require('../../src/bootstrap/Bundle');
const BundleEncryption = require('../../src/bootstrap/BundleEncryption');

function makeFakeDB () {
  const coreInfos = new Map();
  const dns = new Map();
  return {
    async setCoreInfo (id, info) { coreInfos.set(id, info); },
    async getCoreInfo (id) { return coreInfos.get(id) ?? null; },
    async deleteCoreInfo (id) { coreInfos.delete(id); },
    async setDnsRecord (sub, records) { dns.set(sub, records); },
    async getDnsRecord (sub) { return dns.get(sub) ?? null; },
    async deleteDnsRecord (sub) { dns.delete(sub); },
    _coreInfos: coreInfos,
    _dns: dns
  };
}

function baseOpts (overrides) {
  return {
    caDir: overrides.caDir,
    tokensPath: overrides.tokensPath,
    dnsDomain: 'mc.example.com',
    ackUrlBase: 'https://core-a.mc.example.com',
    secrets: {
      adminAccessKey: 'admin-key-0123456789abcdef0123',
      filesReadTokenSecret: 'files-secret-0123456789abcdef0'
    },
    rqlite: { raftPort: 4002, httpPort: 4001 },
    coreId: 'core-b',
    ip: '203.0.113.7',
    url: null,
    hosting: 'us-east-1',
    outPath: overrides.outPath,
    platformDB: overrides.platformDB
  };
}

describe('[BOOTSTRAPCLI] cliOps', function () {
  this.timeout(20_000);

  let tmp;

  before(function () {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
      console.log('  skipping: openssl not available');
      this.skip();
    }
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-bootstrap-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('newCore()', () => {
    it('writes a decryptable, schema-valid bundle and pre-registers in PlatformDB + DNS', async () => {
      const db = makeFakeDB();
      const out = path.join(tmp, 'bundle.age');
      const result = await cliOps.newCore(baseOpts({
        caDir: path.join(tmp, 'ca'),
        tokensPath: path.join(tmp, 'tokens.json'),
        outPath: out,
        platformDB: db
      }));

      // Returned summary
      assert.equal(result.outPath, out);
      assert.equal(result.caCreated, true);
      assert.match(result.passphrase, /^[A-Za-z0-9_-]{4}(-[A-Za-z0-9_-]{1,4})+$/);
      assert.ok(result.expiresAt > Date.now());
      assert.equal(result.ackUrl, 'https://core-a.mc.example.com/system/admin/cores/ack');

      // Bundle on disk decrypts + validates round-trip
      assert.ok(fs.existsSync(out));
      const armored = fs.readFileSync(out, 'utf8');
      const decoded = BundleEncryption.decrypt(armored, result.passphrase);
      Bundle.validate(decoded);
      assert.equal(decoded.node.id, 'core-b');
      assert.equal(decoded.node.ip, '203.0.113.7');
      assert.equal(decoded.node.hosting, 'us-east-1');
      assert.equal(decoded.cluster.domain, 'mc.example.com');
      assert.equal(decoded.cluster.ackUrl, 'https://core-a.mc.example.com/system/admin/cores/ack');
      assert.equal(decoded.platformSecrets.auth.adminAccessKey, 'admin-key-0123456789abcdef0123');

      // PlatformDB pre-registration
      const info = db._coreInfos.get('core-b');
      assert.ok(info);
      assert.equal(info.available, false);
      assert.equal(info.ip, '203.0.113.7');
      assert.deepEqual(db._dns.get('core-b'), { a: ['203.0.113.7'] });
      assert.deepEqual(db._dns.get('lsc'), { a: ['203.0.113.7'] });

      // Bundle file written 0600 (operator owns secret material)
      const mode = fs.statSync(out).mode & 0o777;
      assert.equal(mode, 0o600);

      // Token persisted (one active row, this coreId)
      const active = cliOps.listTokens({ tokensPath: path.join(tmp, 'tokens.json') });
      assert.equal(active.length, 1);
      assert.equal(active[0].coreId, 'core-b');
    });

    it('reuses an existing CA on the second call and reports caCreated:false', async () => {
      const out1 = path.join(tmp, 'b.age');
      const out2 = path.join(tmp, 'c.age');
      const caDir = path.join(tmp, 'ca');
      const tokensPath = path.join(tmp, 'tokens.json');

      const r1 = await cliOps.newCore(baseOpts({
        caDir, tokensPath, outPath: out1, platformDB: makeFakeDB()
      }));
      assert.equal(r1.caCreated, true);

      const r2 = await cliOps.newCore({
        ...baseOpts({ caDir, tokensPath, outPath: out2, platformDB: makeFakeDB() }),
        coreId: 'core-c',
        ip: '203.0.113.8'
      });
      assert.equal(r2.caCreated, false);
    });

    it('rolls back DNS + PlatformDB + token when bundle write fails', async () => {
      const db = makeFakeDB();
      const tokensPath = path.join(tmp, 'tokens.json');
      // outPath is a directory, not a file → fs.writeFileSync throws.
      const badOut = path.join(tmp, 'is-a-dir');
      fs.mkdirSync(badOut);

      await assert.rejects(
        cliOps.newCore(baseOpts({
          caDir: path.join(tmp, 'ca'),
          tokensPath,
          outPath: badOut,
          platformDB: db
        })),
        /EISDIR|illegal operation/
      );

      // PlatformDB rolled back: lsc record gone, per-core record gone, coreInfo gone.
      assert.equal(db._coreInfos.get('core-b'), undefined);
      assert.equal(db._dns.get('core-b'), undefined);
      assert.equal(db._dns.get('lsc'), undefined);
      // Token revoked.
      assert.equal(cliOps.listTokens({ tokensPath }).length, 0);
    });

    it('rejects ttlMs that is not a positive integer', async () => {
      await assert.rejects(
        cliOps.newCore({
          ...baseOpts({
            caDir: path.join(tmp, 'ca'),
            tokensPath: path.join(tmp, 'tokens.json'),
            outPath: path.join(tmp, 'b.age'),
            platformDB: makeFakeDB()
          }),
          ttlMs: -5
        }),
        /ttlMs must be a positive integer/
      );
    });
  });

  describe('listTokens()', () => {
    it('returns [] when the store does not exist yet', () => {
      const rows = cliOps.listTokens({ tokensPath: path.join(tmp, 'never.json') });
      assert.deepEqual(rows, []);
    });
  });

  describe('revokeToken()', () => {
    it('removes the token but keeps DNS state when no platformDB/ip given', async () => {
      const tokensPath = path.join(tmp, 'tokens.json');
      const db = makeFakeDB();
      await cliOps.newCore(baseOpts({
        caDir: path.join(tmp, 'ca'),
        tokensPath,
        outPath: path.join(tmp, 'b.age'),
        platformDB: db
      }));
      assert.equal(cliOps.listTokens({ tokensPath }).length, 1);

      const result = await cliOps.revokeToken({ tokensPath, coreId: 'core-b' });
      assert.equal(result.tokensRevoked, 1);
      assert.equal(result.unregister, null);
      // DNS untouched — caller deliberately scoped to token-only undo.
      assert.deepEqual(db._dns.get('lsc'), { a: ['203.0.113.7'] });
    });

    it('full undo with platformDB + ip removes coreInfo, per-core record and lsc entry', async () => {
      const tokensPath = path.join(tmp, 'tokens.json');
      const db = makeFakeDB();
      await cliOps.newCore(baseOpts({
        caDir: path.join(tmp, 'ca'),
        tokensPath,
        outPath: path.join(tmp, 'b.age'),
        platformDB: db
      }));

      const result = await cliOps.revokeToken({
        tokensPath, coreId: 'core-b', platformDB: db, ip: '203.0.113.7'
      });
      assert.equal(result.tokensRevoked, 1);
      assert.equal(result.unregister.coreInfoDeleted, true);
      assert.equal(result.unregister.perCoreDeleted, true);
      assert.deepEqual(result.unregister.lscIpsAfter, []);
      assert.equal(db._coreInfos.get('core-b'), undefined);
      assert.equal(db._dns.get('core-b'), undefined);
      assert.equal(db._dns.get('lsc'), undefined);
    });
  });
});
