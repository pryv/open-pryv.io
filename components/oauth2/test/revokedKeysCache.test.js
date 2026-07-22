/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [RJKT10] Per-core revoked-DPoP-key cache — presence blocklist with TTL
 * refresh + fail-open. Verifies the hot path pays at most one PlatformDB read
 * per TTL, that a cluster-wide revoke propagates within one TTL, and that a
 * transient store error keeps the last-known set rather than blocking sessions.
 */

const assert = require('node:assert/strict');
const cache = require('../src/revokedKeysCache.ts');

const JKT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const JKT2 = 'ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210_-abcdef';

// Minimal PlatformDB the cache loader (listRevokedDpopKeys) needs: the two kv
// read primitives, plus a call counter and a throw toggle to exercise
// caching + fail-open.
function fakePlatform () {
  const kv = new Map();
  const p = {
    throwOnList: false,
    listCalls: 0,
    revoke (jkt) { kv.set('dpop-jkt-revoked/' + jkt, JSON.stringify({ revokedAt: Date.now() })); },
    unrevoke (jkt) { kv.delete('dpop-jkt-revoked/' + jkt); },
    async listPlatformKvKeys (prefix) {
      p.listCalls++;
      if (p.throwOnList) throw new Error('platform down');
      return Array.from(kv.keys()).filter((k) => k.startsWith(prefix));
    },
    async getPlatformKv (key) { return kv.has(key) ? kv.get(key) : null; },
  };
  return p;
}

describe('[RJKT10] revokedKeysCache', () => {
  beforeEach(() => cache._resetForTests());

  it('[RJKT10a] cold-loads on first use and reports presence', async () => {
    const p = fakePlatform();
    p.revoke(JKT);
    assert.equal(await cache.isKeyRevoked(p, JKT, 30, 1_000), true);
    assert.equal(await cache.isKeyRevoked(p, JKT2, 30, 1_000), false);
  });

  it('[RJKT10b] serves from cache within the TTL — one read per TTL, not per call', async () => {
    const p = fakePlatform();
    p.revoke(JKT);
    await cache.isKeyRevoked(p, JKT, 30, 1_000); // cold load (1 read)
    // A revoke added AFTER the load is not visible until the TTL elapses.
    p.revoke(JKT2);
    assert.equal(await cache.isKeyRevoked(p, JKT2, 30, 5_000), false); // still within TTL
    assert.equal(p.listCalls, 1);
    // Past the TTL → refresh → the new tombstone is now seen.
    assert.equal(await cache.isKeyRevoked(p, JKT2, 30, 40_000), true);
    assert.equal(p.listCalls, 2);
  });

  it('[RJKT10c] an un-revoke propagates within one TTL', async () => {
    const p = fakePlatform();
    p.revoke(JKT);
    assert.equal(await cache.isKeyRevoked(p, JKT, 30, 1_000), true);
    p.unrevoke(JKT);
    assert.equal(await cache.isKeyRevoked(p, JKT, 30, 5_000), true); // stale within TTL
    assert.equal(await cache.isKeyRevoked(p, JKT, 30, 40_000), false); // refreshed
  });

  it('[RJKT10d] fail-open: keeps the stale set and backs off one TTL on a read error', async () => {
    const p = fakePlatform();
    p.revoke(JKT);
    assert.equal(await cache.isKeyRevoked(p, JKT, 30, 1_000), true); // good load
    p.throwOnList = true;
    // TTL elapsed → refresh attempts, throws, keeps the stale set (no throw to caller).
    assert.equal(await cache.isKeyRevoked(p, JKT, 30, 40_000), true);
    const callsAfterError = p.listCalls;
    // loadedAt advanced → next in-TTL call does NOT storm the failing store.
    assert.equal(await cache.isKeyRevoked(p, JKT, 30, 45_000), true);
    assert.equal(p.listCalls, callsAfterError);
  });

  it('[RJKT10e] _resetForTests forces a cold reload', async () => {
    const p = fakePlatform();
    p.revoke(JKT);
    await cache.isKeyRevoked(p, JKT, 30, 1_000);
    const before = p.listCalls;
    cache._resetForTests();
    await cache.isKeyRevoked(p, JKT, 30, 1_000); // loadedAt null again → reloads
    assert.equal(p.listCalls, before + 1);
  });
});
