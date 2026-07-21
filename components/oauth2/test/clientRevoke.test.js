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
  describe('[OCR-STORE] tombstone storage', () => {
    it('[OCR01] deleteClient removes the client row AND writes a revoke tombstone', async () => {
      const p = fakePlatform();
      await storage.setClient(p, CLIENT);
      assert.ok(await storage.getClient(p, 'myapp'));
      await storage.deleteClient(p, 'myapp');
      assert.equal(await storage.getClient(p, 'myapp'), null);
      assert.equal(await storage.isClientRevoked(p, 'myapp'), true);
    });

    it('[OCR02] setClient (re-register) clears an existing tombstone', async () => {
      const p = fakePlatform();
      await storage.setClient(p, CLIENT);
      await storage.deleteClient(p, 'myapp');
      assert.equal(await storage.isClientRevoked(p, 'myapp'), true);
      await storage.setClient(p, CLIENT); // re-register
      assert.equal(await storage.isClientRevoked(p, 'myapp'), false);
    });

    it('[OCR03] isClientRevoked is false for an unknown / empty id', async () => {
      const p = fakePlatform();
      assert.equal(await storage.isClientRevoked(p, 'never'), false);
      assert.equal(await storage.isClientRevoked(p, ''), false);
    });

    it('[OCR04] listRevokedClientIds returns exactly the tombstoned ids', async () => {
      const p = fakePlatform();
      await storage.deleteClient(p, 'a');
      await storage.deleteClient(p, 'b');
      await storage.setClient(p, { ...CLIENT, clientId: 'b' }); // clears b
      const ids = await storage.listRevokedClientIds(p);
      assert.deepEqual(ids.sort(), ['a']);
    });

    it('[OCR05] pruneRevokedClients drops only tombstones older than maxAge', async () => {
      const p = fakePlatform();
      // Two tombstones with hand-set ages.
      await p.setPlatformKv('oauth-client-revoked/old', JSON.stringify({ revokedAt: 1000 }));
      await p.setPlatformKv('oauth-client-revoked/new', JSON.stringify({ revokedAt: 9000 }));
      const pruned = await storage.pruneRevokedClients(p, 3000, 10000); // now=10000, maxAge=3000 → cutoff 7000
      assert.equal(pruned, 1);
      assert.equal(await storage.isClientRevoked(p, 'old'), false);
      assert.equal(await storage.isClientRevoked(p, 'new'), true);
    });
  });

  describe('[OCR-CACHE] per-core cache', () => {
    beforeEach(() => cache._resetForTests());

    it('[OCR10] loads the set on first use and reflects a revoked client', async () => {
      const p = fakePlatform();
      await storage.deleteClient(p, 'gone');
      assert.equal(await cache.isClientRevoked(p, 'gone', 30, 1000), true);
      assert.equal(await cache.isClientRevoked(p, 'other', 30, 1000), false);
    });

    it('[OCR11] serves from cache within the TTL (no re-read) then refreshes after it', async () => {
      const p = fakePlatform();
      let reads = 0;
      const orig = p.listPlatformKvKeys.bind(p);
      p.listPlatformKvKeys = async (pre) => { reads++; return orig(pre); };

      await cache.isClientRevoked(p, 'x', 30, 1000); // cold load (read #1)
      await storage.deleteClient(p, 'x'); // revoke AFTER the load
      // Within TTL: still served from the stale cache → not yet revoked, no read.
      assert.equal(await cache.isClientRevoked(p, 'x', 30, 5000), false);
      assert.equal(reads, 1);
      // Past TTL (now - loadedAt > 30s): refresh picks up the revoke.
      assert.equal(await cache.isClientRevoked(p, 'x', 30, 40000), true);
      assert.equal(reads, 2);
    });

    it('[OCR12] fail-open on a platform read error: keeps the stale set, does not throw', async () => {
      const p = fakePlatform();
      await storage.deleteClient(p, 'known');
      await cache.isClientRevoked(p, 'known', 30, 1000); // warm: {known}
      p.listPlatformKvKeys = async () => { throw new Error('platform down'); };
      // Past TTL → refresh throws internally, but the call resolves (fail-open)
      // and keeps the last known set.
      assert.equal(await cache.isClientRevoked(p, 'known', 30, 40000), true);
      assert.equal(await cache.isClientRevoked(p, 'other', 30, 40000), false);
    });
  });
});
