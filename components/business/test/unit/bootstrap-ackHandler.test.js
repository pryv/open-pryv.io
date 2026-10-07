/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the ack handler.
 *
 * Exercises the handler in isolation with a real TokenStore (file-backed,
 * tmp dir) and a fake PlatformDB. No express, no rqlited.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TokenStore = require('../../src/bootstrap/TokenStore.ts').default;
const ackHandler = require('../../src/bootstrap/ackHandler.ts');

// Every refusal carries this body; the reason is logged only.
const REFUSED = { error: { id: 'ack-refused', message: 'join acknowledgement refused' } };
const FPR = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const OTHER_FPR = FPR.replace(/^AA/, '01');

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
      assert.deepEqual(replay.body, REFUSED);
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
    let handle, db, logs;
    beforeEach(() => {
      db = makeFakeDB({ cores: { 'core-b': { id: 'core-b', available: false } } });
      logs = [];
      handle = ackHandler.makeHandler({ tokenStore, platformDB: db, log: (m) => logs.push(m) });
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
      assert.deepEqual(res.body, REFUSED);
      assert.match(logs[0], /token unknown/);
    });

    it('[BACK1] a token presented with another coreId is refused without being consumed, and the body names no reason', async () => {
      db._cores.set('core-c', { id: 'core-c', available: false });
      const { token } = tokenStore.mint({ coreId: 'core-c' });
      const res = await handle({ body: { coreId: 'core-b', token } });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, REFUSED);
      assert.match(logs[0], /issued for coreId "core-c"/);
      // PlatformDB not mutated, token still usable by its own core
      assert.equal(db._cores.get('core-b').available, false);
      assert.deepEqual(tokenStore.verify(token), { ok: true, coreId: 'core-c' });
      const own = await handle({ body: { coreId: 'core-c', token } });
      assert.equal(own.statusCode, 200);
    });

    it('[BACK2] a token whose core has no pre-registered row is refused without being consumed', async () => {
      const emptyDB = makeFakeDB();
      const handle2 = ackHandler.makeHandler({ tokenStore, platformDB: emptyDB, log: (m) => logs.push(m) });
      const { token } = tokenStore.mint({ coreId: 'core-b' });
      const res = await handle2({ body: { coreId: 'core-b', token } });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, REFUSED);
      assert.match(logs[0], /no pre-registered core-info row/);
      assert.deepEqual(tokenStore.verify(token), { ok: true, coreId: 'core-b' });
    });

    it('[BFPR1] a node certificate fingerprint other than the issued one is refused and the token is not consumed', async () => {
      const { token } = tokenStore.mint({ coreId: 'core-b', certFingerprint: FPR });
      for (const tlsFingerprint of [OTHER_FPR, undefined, '']) {
        const res = await handle({ body: { coreId: 'core-b', token, tlsFingerprint } });
        assert.equal(res.statusCode, 401, String(tlsFingerprint));
        assert.deepEqual(res.body, REFUSED);
      }
      assert.match(logs[0], /fingerprint differs/);
      assert.equal(db._cores.get('core-b').available, false);
      assert.equal(tokenStore.verify(token).ok, true);

      const ok = await handle({ body: { coreId: 'core-b', token, tlsFingerprint: FPR.toLowerCase() } });
      assert.equal(ok.statusCode, 200);
      assert.equal(db._cores.get('core-b').available, true);
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
      assert.deepEqual(res.body, REFUSED);
      assert.match(logs[0], /token expired/);
    });
  });
});
