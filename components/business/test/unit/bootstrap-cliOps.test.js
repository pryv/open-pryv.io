/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Acceptance-style tests for bootstrap CLI orchestration.
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

const cliOps = require('../../src/bootstrap/cliOps.ts');
const Bundle = require('../../src/bootstrap/Bundle.ts');
const BundleEncryption = require('../../src/bootstrap/BundleEncryption.ts');

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
    function optsIn (dir, db, extra) {
      return Object.assign(baseOpts({
        caDir: path.join(dir, 'ca'),
        tokensPath: path.join(dir, 'tokens.json'),
        outPath: path.join(dir, 'bundle.age'),
        platformDB: db
      }), extra);
    }

    it('[BNCV1] refuses a core id outside the grammar before writing anything', async () => {
      for (const coreId of ['Core-B', 'core_b', 'evil.example.org/x', '-core', 'a'.repeat(64)]) {
        const db = makeFakeDB();
        await assert.rejects(cliOps.newCore(optsIn(tmp, db, { coreId })), /core id .* is invalid/, coreId);
        assert.equal(db._coreInfos.size, 0, coreId);
        assert.equal(fs.existsSync(path.join(tmp, 'ca')), false, 'no CA generated for ' + coreId);
      }
    });

    it('[BNCV2] refuses an http, credential-bearing or path-carrying --url; http only with the insecure flag', async () => {
      for (const url of ['http://b.example.com', 'https://user:pw@b.example.com', 'https://b.example.com/api', 'https://b.example.com/#x']) {
        const db = makeFakeDB();
        await assert.rejects(cliOps.newCore(optsIn(tmp, db, { url })), /core URL/, url);
        assert.equal(db._coreInfos.size, 0, url);
      }
      const db = makeFakeDB();
      await cliOps.newCore(optsIn(tmp, db, { url: 'http://127.0.0.1:3001', allowInsecurePeerUrl: true }));
      assert.equal(db._coreInfos.get('core-b').url, 'http://127.0.0.1:3001');
    });

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

  describe('promoteCore()', function () {
    const LEADER = 'http://leader-host:4001';

    // Only the leader's own rqlite answers: a peer's HTTP API listens on
    // loopback and is never reachable from the leader.
    function makeFetch ({ nodes, leaderApplied = 100, removeStatus = 200 }) {
      const calls = { remove: null, removeCount: 0, urls: [] };
      const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });
      const fetchImpl = async (url, opts) => {
        calls.urls.push(url);
        if (!url.startsWith(LEADER)) throw new TypeError('fetch failed (unreachable: ' + url + ')');
        if (url.includes('/nodes')) return jsonRes(nodes);
        if (url.includes('/remove')) {
          calls.removeCount++;
          calls.remove = JSON.parse(opts.body);
          return { ok: removeStatus === 200, status: removeStatus };
        }
        if (url.includes('/status')) return jsonRes({ store: { raft: { applied_index: leaderApplied } } });
        throw new Error('unexpected url ' + url);
      };
      return { fetchImpl, calls };
    }

    const threeVoterNodes = {
      'core-a': { voter: true, reachable: true, api_addr: LEADER },
      'core-x': { voter: true, reachable: true },
      'core-b': { voter: false, reachable: true, api_addr: 'http://target-host:4001' }
    };

    it('[BPRC1] removes a reachable, caught-up non-voter when result is >=3 voters, without contacting the target', async () => {
      const { fetchImpl, calls } = makeFetch({ nodes: threeVoterNodes });
      const result = await cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', targetAppliedIndex: 98, fetchImpl });
      assert.equal(result.voterCountBefore, 2);
      assert.equal(result.voterCountAfter, 3);
      assert.equal(result.lag, 2);
      assert.equal(calls.removeCount, 1);
      assert.deepEqual(calls.remove, { id: 'core-b' });
      assert.deepEqual(calls.urls.filter((u) => !u.startsWith(LEADER)), [], 'no request to the target core');
    });

    it('[BPRC2] refuses without the target applied index (never fetches the target), unless --force', async () => {
      const { fetchImpl, calls } = makeFetch({ nodes: threeVoterNodes });
      await assert.rejects(cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', fetchImpl }),
        /applied-index.*--target-applied-index/);
      assert.equal(calls.removeCount, 0);
      assert.deepEqual(calls.urls.filter((u) => !u.startsWith(LEADER)), [], 'no request to the target core');
      const forced = await cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', force: true, fetchImpl });
      assert.equal(forced.lag, null);
      assert.equal(calls.removeCount, 1);
    });

    it('[BPRC3] refuses a malformed target applied index', async () => {
      const { fetchImpl, calls } = makeFetch({ nodes: threeVoterNodes });
      await assert.rejects(cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', targetAppliedIndex: -1, fetchImpl }),
        /non-negative integer/);
      assert.equal(calls.removeCount, 0);
    });

    it('[BPRC4] readAppliedIndex reads the local rqlite /status, or null', async () => {
      const { fetchImpl } = makeFetch({ nodes: threeVoterNodes, leaderApplied: 42 });
      assert.equal(await cliOps.readAppliedIndex(LEADER, fetchImpl), 42);
      assert.equal(await cliOps.readAppliedIndex('http://elsewhere:4001', fetchImpl), null);
    });

    it('refuses when the target is already a voter (no remove)', async () => {
      const nodes = { 'core-a': { voter: true, reachable: true, api_addr: LEADER }, 'core-b': { voter: true, reachable: true } };
      const { fetchImpl, calls } = makeFetch({ nodes });
      await assert.rejects(cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', fetchImpl }), /already a voter/);
      assert.equal(calls.removeCount, 0);
    });

    it('refuses when the target is not in the cluster', async () => {
      const { fetchImpl } = makeFetch({ nodes: { 'core-a': { voter: true, reachable: true, api_addr: LEADER } } });
      await assert.rejects(cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'ghost', fetchImpl }), /not in the cluster/);
    });

    it('refuses to create a 2-voter cluster without --force', async () => {
      const nodes = {
        'core-a': { voter: true, reachable: true, api_addr: LEADER },
        'core-b': { voter: false, reachable: true, api_addr: 'http://target-host:4001' }
      };
      const { fetchImpl, calls } = makeFetch({ nodes });
      await assert.rejects(cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', fetchImpl }), /2-voter cluster/);
      assert.equal(calls.removeCount, 0);
    });

    it('allows a 2-voter promotion with --force', async () => {
      const nodes = {
        'core-a': { voter: true, reachable: true, api_addr: LEADER },
        'core-b': { voter: false, reachable: true, api_addr: 'http://target-host:4001' }
      };
      const { fetchImpl, calls } = makeFetch({ nodes });
      const result = await cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', force: true, fetchImpl });
      assert.equal(result.voterCountAfter, 2);
      assert.equal(calls.removeCount, 1);
    });

    it('refuses an unreachable target without --force', async () => {
      const nodes = {
        'core-a': { voter: true, reachable: true, api_addr: LEADER },
        'core-x': { voter: true, reachable: true },
        'core-b': { voter: false, reachable: false, api_addr: 'http://target-host:4001' }
      };
      const { fetchImpl, calls } = makeFetch({ nodes });
      await assert.rejects(cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', fetchImpl }), /not reachable/);
      assert.equal(calls.removeCount, 0);
    });

    it('refuses a lagging target without --force', async () => {
      const { fetchImpl, calls } = makeFetch({ nodes: threeVoterNodes, leaderApplied: 1000 });
      await assert.rejects(cliOps.promoteCore({ rqliteBaseUrl: LEADER, coreId: 'core-b', targetAppliedIndex: 100, fetchImpl }), /behind the leader/);
      assert.equal(calls.removeCount, 0);
    });
  });
});
