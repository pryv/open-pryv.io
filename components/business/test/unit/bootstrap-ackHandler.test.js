/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 34 Phase 4a — ack handler.
 *
 * Exercises the handler in isolation with a real TokenStore (file-backed,
 * tmp dir) and a fake PlatformDB. No express, no rqlited.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TokenStore = require('../../src/bootstrap/TokenStore');
const ackHandler = require('../../src/bootstrap/ackHandler');

function makeFakeDB (initial = {}) {
  const cores = new Map(Object.entries(initial.cores || {}));
  const dns = new Map(Object.entries(initial.dns || {}));
  return {
    async getCoreInfo (id) { return cores.get(id) ?? null; },
    async setCoreInfo (id, info) { cores.set(id, info); },
    async getAllCoreInfos () { return [...cores.values()]; },
    async getDnsRecord (sub) { return dns.get(sub) ?? null; },
    _cores: cores,
    _dns: dns
  };
}

describe('[ACKHANDLER] ackHandler', function () {
  this.timeout(5_000);

  let tmpDir;
  let tokenStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-ack-'));
    tokenStore = new TokenStore({ path: path.join(tmpDir, 'tokens.json') });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws if dependencies are missing', () => {
    assert.throws(() => ackHandler.makeHandler({}), /tokenStore is required/);
    assert.throws(() => ackHandler.makeHandler({ tokenStore }), /platformDB is required/);
  });

  describe('happy path', () => {
    it('flips available:true and returns the cluster snapshot', async () => {
      const db = makeFakeDB({
        cores: {
          'core-a': { id: 'core-a', url: 'https://a.ex.com', available: true, hosting: 'eu' },
          'core-b': { id: 'core-b', url: 'https://b.ex.com', available: false, hosting: 'us' }
        },
        dns: { lsc: { a: ['1.1.1.1', '2.2.2.2'] } }
      });
      const { token } = tokenStore.mint({ coreId: 'core-b' });
      const handle = ackHandler.makeHandler({ tokenStore, platformDB: db });

      const res = await handle({ body: { coreId: 'core-b', token }, ip: '2.2.2.2' });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.coreId, 'core-b');
      assert.equal(res.body.cluster.cores.length, 2);
      const coreB = res.body.cluster.cores.find(c => c.id === 'core-b');
      assert.equal(coreB.available, true);
      assert.deepEqual(res.body.cluster.lscIps, ['1.1.1.1', '2.2.2.2']);
      // PlatformDB really updated
      assert.equal(db._cores.get('core-b').available, true);
      // Token burned: second call rejects
      const replay = await handle({ body: { coreId: 'core-b', token } });
      assert.equal(replay.statusCode, 401);
      assert.equal(replay.body.error.reason, 'already-consumed');
    });

    it('records consumerIp on the token entry', async () => {
      const db = makeFakeDB({
        cores: { 'core-b': { id: 'core-b', available: false } }
      });
      const { token } = tokenStore.mint({ coreId: 'core-b' });
      const handle = ackHandler.makeHandler({ tokenStore, platformDB: db });

      await handle({ body: { coreId: 'core-b', token }, ip: '203.0.113.7' });

      // Re-load the file to confirm the on-disk record carries consumerIp
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tokens.json'), 'utf8'));
      const entries = Object.values(onDisk.tokens);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].consumerIp, '203.0.113.7');
      assert.ok(entries[0].consumedAt > 0);
    });
  });

  describe('error cases', () => {
    let handle, db;
    beforeEach(() => {
      db = makeFakeDB({ cores: { 'core-b': { id: 'core-b', available: false } } });
      handle = ackHandler.makeHandler({ tokenStore, platformDB: db });
    });

    it('400 when coreId is missing', async () => {
      const { token } = tokenStore.mint({ coreId: 'core-b' });
      const res = await handle({ body: { token } });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.id, 'invalid-body');
    });

    it('400 when token is missing', async () => {
      const res = await handle({ body: { coreId: 'core-b' } });
      assert.equal(res.statusCode, 400);
    });

    it('401 when token is unknown', async () => {
      const res = await handle({ body: { coreId: 'core-b', token: 'made-up' } });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error.reason, 'unknown');
    });

    it('401 when token belongs to a different coreId', async () => {
      const { token } = tokenStore.mint({ coreId: 'core-c' });
      const res = await handle({ body: { coreId: 'core-b', token } });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error.id, 'token-coreid-mismatch');
      // And critically: PlatformDB was NOT mutated
      assert.equal(db._cores.get('core-b').available, false);
    });

    it('401 when token is expired', async () => {
      const past = Date.now() - 1_000_000;
      tokenStore.mint({ coreId: 'core-b', ttlMs: 1, now: past });
      // Read the raw token from disk by inspecting what was minted — but mint
      // only returns it once. So mint a second one and freeze its expiry.
      // Simpler: mint with tiny ttl, then verify directly to retrieve nothing.
      // Here we test consume() returns expired by minting + expiring time.
      const { token } = tokenStore.mint({ coreId: 'core-b', ttlMs: 50, now: Date.now() - 100 });
      const res = await handle({ body: { coreId: 'core-b', token } });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error.reason, 'expired');
    });

    it('404 when token verifies but coreInfo is missing', async () => {
      const emptyDB = makeFakeDB();
      const handle2 = ackHandler.makeHandler({ tokenStore, platformDB: emptyDB });
      const { token } = tokenStore.mint({ coreId: 'core-b' });
      const res = await handle2({ body: { coreId: 'core-b', token } });
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error.id, 'core-not-pre-registered');
      // And the token IS consumed (we don't reverse): operator must mint a new one.
      const verify = tokenStore.verify(token);
      assert.equal(verify.ok, false);
      assert.equal(verify.reason, 'already-consumed');
    });
  });
});
