/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const storage = require('../src/storage.ts');
const cache = require('../src/revokedClientsCache.ts');

function fakePlatform () {
  const kv = new Map();
  return {
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return Array.from(kv.keys()).filter((k) => k.startsWith(p)); },
    _kv: kv,
  };
}

const CLIENT = { clientId: 'myapp', redirectUris: ['https://a/cb'], scope: ['cmc:x'], grantTypes: ['authorization_code'], clientName: 'X', updatedAt: 1 };

describe('[OAUTH-CLIENT-REVOKE] operator client revoke', () => {
  describe('[OCR-STORE] tombstone storage (token epoch)', () => {
    it('[OCR01] deleteClient removes the client row AND writes a revoke tombstone with an epoch', async () => {
      const p = fakePlatform();
      await storage.setClient(p, CLIENT);
      assert.ok(await storage.getClient(p, 'myapp'));
      const before = Date.now();
      await storage.deleteClient(p, 'myapp');
      assert.equal(await storage.getClient(p, 'myapp'), null);
      const revokedAt = await storage.getRevokedAt(p, 'myapp');
      assert.ok(typeof revokedAt === 'number' && revokedAt >= before);
      assert.equal(await storage.isClientRevoked(p, 'myapp'), true);
    });

    it('[OCR02] setClient (re-register) does NOT clear the tombstone — the epoch stays', async () => {
      const p = fakePlatform();
      await storage.setClient(p, CLIENT);
      await storage.deleteClient(p, 'myapp');
      const epoch = await storage.getRevokedAt(p, 'myapp');
      await storage.setClient(p, CLIENT); // re-register
      assert.equal(await storage.getRevokedAt(p, 'myapp'), epoch, 'epoch unchanged by re-register');
      assert.equal(await storage.isClientRevoked(p, 'myapp'), true);
    });

    it('[OCR03] getRevokedAt is null for an unknown / empty id', async () => {
      const p = fakePlatform();
      assert.equal(await storage.getRevokedAt(p, 'never'), null);
      assert.equal(await storage.getRevokedAt(p, ''), null);
    });

    it('[OCR04] listRevokedClients returns each tombstoned id with its epoch (re-register keeps it)', async () => {
      const p = fakePlatform();
      await storage.deleteClient(p, 'a');
      await storage.deleteClient(p, 'b');
      await storage.setClient(p, { ...CLIENT, clientId: 'b' }); // does NOT clear b
      const entries = await storage.listRevokedClients(p);
      const ids = entries.map((e) => e.clientId).sort();
      assert.deepEqual(ids, ['a', 'b']);
      assert.ok(entries.every((e) => typeof e.revokedAt === 'number' && e.revokedAt > 0));
    });

    it('[OCR05] pruneRevokedClients drops only tombstones older than maxAge', async () => {
      const p = fakePlatform();
      await p.setPlatformKv('oauth-client-revoked/old', JSON.stringify({ revokedAt: 1000 }));
      await p.setPlatformKv('oauth-client-revoked/new', JSON.stringify({ revokedAt: 9000 }));
      const pruned = await storage.pruneRevokedClients(p, 3000, 10000); // now=10000, maxAge=3000 → cutoff 7000
      assert.equal(pruned, 1);
      assert.equal(await storage.isClientRevoked(p, 'old'), false);
      assert.equal(await storage.isClientRevoked(p, 'new'), true);
    });
  });

  describe('[OCR-CACHE] per-core cache (epoch map)', () => {
    beforeEach(() => cache._resetForTests());

    it('[OCR10] loads on first use and returns the revoke epoch (null when not revoked)', async () => {
      const p = fakePlatform();
      await storage.deleteClient(p, 'gone');
      const epoch = await cache.getRevokedAt(p, 'gone', 30, 1000);
      assert.ok(typeof epoch === 'number' && epoch > 0);
      assert.equal(await cache.getRevokedAt(p, 'other', 30, 1000), null);
    });

    it('[OCR11] serves from cache within the TTL (no re-read) then refreshes after it', async () => {
      const p = fakePlatform();
      let reads = 0;
      const orig = p.listPlatformKvKeys.bind(p);
      p.listPlatformKvKeys = async (pre) => { reads++; return orig(pre); };

      await cache.getRevokedAt(p, 'x', 30, 1000); // cold load (read #1)
      await storage.deleteClient(p, 'x'); // revoke AFTER the load
      // Within TTL: served from the stale cache → still null, no read.
      assert.equal(await cache.getRevokedAt(p, 'x', 30, 5000), null);
      assert.equal(reads, 1);
      // Past TTL: refresh picks up the revoke epoch.
      assert.ok((await cache.getRevokedAt(p, 'x', 30, 40000)) > 0);
      assert.equal(reads, 2);
    });

    it('[OCR12] fail-open on a platform read error: keeps the stale map, does not throw', async () => {
      const p = fakePlatform();
      await storage.deleteClient(p, 'known');
      await cache.getRevokedAt(p, 'known', 30, 1000); // warm: {known}
      p.listPlatformKvKeys = async () => { throw new Error('platform down'); };
      // Past TTL → refresh throws internally, but the call resolves (fail-open).
      assert.ok((await cache.getRevokedAt(p, 'known', 30, 40000)) > 0);
      assert.equal(await cache.getRevokedAt(p, 'other', 30, 40000), null);
    });
  });
});
