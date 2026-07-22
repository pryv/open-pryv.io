/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-STORE] OAuth2 — storage-layer wrapper over PlatformDB primitives.
 *
 * Exercises the typed wrappers in src/storage.ts against a fake
 * PlatformDB that implements only the four generic primitives
 * (setAccessState + setPlatformKv families). Ensures the OAuth-
 * specific key-namespace conventions stay inside this component,
 * not inside the engine.
 */

const assert = require('node:assert/strict');
const storage = require('../src/storage.ts');

/**
 * Fake PlatformDB — generic primitives only. Mirrors the production
 * shape of those four methods: setAccessState carries (key, value,
 * expiresAt) and getAccessState lazy-expires; setPlatformKv carries
 * (key, value-string) indefinitely.
 */
function fakePlatform () {
  const stateStore = new Map(); // access-state (with ttl)
  const kvStore = new Map(); // generic kv (indefinite)
  return {
    async setAccessState (key, value, expiresAt) {
      stateStore.set(key, { value, expiresAt });
    },
    async getAccessState (key) {
      const e = stateStore.get(key);
      if (e == null) return null;
      if (typeof e.expiresAt === 'number' && Date.now() > e.expiresAt) {
        stateStore.delete(key);
        return null;
      }
      return e;
    },
    async deleteAccessState (key) { stateStore.delete(key); },
    async consumeAccessState (key) {
      const e = stateStore.get(key); stateStore.delete(key);
      if (e == null) return null;
      if (typeof e.expiresAt === 'number' && Date.now() > e.expiresAt) return null;
      return e;
    },
    async setPlatformKv (key, value) { kvStore.set(key, value); },
    async getPlatformKv (key) { return kvStore.has(key) ? kvStore.get(key) : null; },
    async deletePlatformKv (key) { kvStore.delete(key); },
    async listPlatformKvKeys (prefix) {
      return Array.from(kvStore.keys()).filter((k) => k.startsWith(prefix));
    },
    _internalStateStore: stateStore,
    _internalKvStore: kvStore,
  };
}

describe('[OAUTH-STORE] storage layer', () => {
  describe('[OAUTH-STORE-CLIENT] client metadata (indefinite kv)', () => {
    it('[OS-C1] setClient stores under oauth-client/<id> with updatedAt stamped', async () => {
      const platform = fakePlatform();
      await storage.setClient(platform, {
        clientId: 'myapp',
        redirectUris: ['https://x/cb'],
        scope: ['pryv:read'],
        grantTypes: ['authorization_code'],
        updatedAt: 0,
      });
      assert.ok(platform._internalKvStore.has('oauth-client/myapp'));
      const got = await storage.getClient(platform, 'myapp');
      assert.equal(got.clientId, 'myapp');
      assert.ok(got.updatedAt > 0);
    });
    it('[OS-C2] getClient returns null for unknown id', async () => {
      assert.equal(await storage.getClient(fakePlatform(), 'missing'), null);
      assert.equal(await storage.getClient(fakePlatform(), ''), null);
      assert.equal(await storage.getClient(fakePlatform(), null), null);
    });
    it('[OS-C3] deleteClient removes the row', async () => {
      const platform = fakePlatform();
      await storage.setClient(platform, {
        clientId: 'myapp', redirectUris: ['x'], scope: [], grantTypes: ['authorization_code'],
      });
      await storage.deleteClient(platform, 'myapp');
      assert.equal(await storage.getClient(platform, 'myapp'), null);
    });
    it('[OS-C4] listClientIds returns sorted ids', async () => {
      const platform = fakePlatform();
      await storage.setClient(platform, { clientId: 'zeta', redirectUris: ['x'], scope: [], grantTypes: ['authorization_code'] });
      await storage.setClient(platform, { clientId: 'alpha', redirectUris: ['x'], scope: [], grantTypes: ['authorization_code'] });
      assert.deepEqual(await storage.listClientIds(platform), ['alpha', 'zeta']);
    });
  });

  describe('[OAUTH-STORE-CODE] authorization codes (ephemeral with ttl)', () => {
    const future = () => Date.now() + 60_000;
    const past = () => Date.now() - 1_000;

    it('[OS-CD1] setCode + getCode round-trip; key is cluster-wide (no coreId)', async () => {
      const platform = fakePlatform();
      const payload = {
        clientId: 'app',
        redirectUri: 'https://x/cb',
        codeChallenge: 'cc',
        codeChallengeMethod: 'S256',
        userId: 'u',
        scope: ['pryv:read'],
        expiresAt: future(),
      };
      await storage.setCode(platform, 'CODE1', payload);
      // Deliberately NOT core-namespaced: code /token is core-agnostic.
      assert.ok(platform._internalStateStore.has('oauth-code/CODE1'));
      const got = await storage.getCode(platform, 'CODE1');
      assert.equal(got.codeChallenge, 'cc');
    });
    it('[OS-CD2] getCode returns null when expired (lazy-expire via setAccessState)', async () => {
      const platform = fakePlatform();
      await storage.setCode(platform, 'CODE2', {
        clientId: 'app',
        redirectUri: 'https://x/cb',
        codeChallenge: 'cc',
        codeChallengeMethod: 'S256',
        userId: 'u',
        scope: [],
        expiresAt: past(),
      });
      assert.equal(await storage.getCode(platform, 'CODE2'), null);
    });
    it('[OS-CD3] deleteCode removes the row', async () => {
      const platform = fakePlatform();
      await storage.setCode(platform, 'CODE3', {
        clientId: 'app',
        redirectUri: 'https://x/cb',
        codeChallenge: 'cc',
        codeChallengeMethod: 'S256',
        userId: 'u',
        scope: [],
        expiresAt: future(),
      });
      await storage.deleteCode(platform, 'CODE3');
      assert.equal(await storage.getCode(platform, 'CODE3'), null);
    });
    it('[OS-CD4] the code key is cluster-wide — the same code resolves from any core', async () => {
      // Codes are NOT core-namespaced: `/accept` may mint on one core and an
      // LB may route `/token` to another; the exchange is core-agnostic (the
      // access is already minted; the row carries the home-core apiEndpoint).
      const platform = fakePlatform();
      await storage.setCode(platform, 'SAME', {
        clientId: 'A',
        redirectUri: 'https://x/cb',
        codeChallenge: 'cc',
        codeChallengeMethod: 'S256',
        userId: 'u',
        scope: [],
        expiresAt: future(),
      });
      // A code minted anywhere resolves via one cluster-wide key.
      assert.equal((await storage.getCode(platform, 'SAME')).clientId, 'A');
      assert.ok(platform._internalStateStore.has('oauth-code/SAME'));
    });
  });

  describe('[OAUTH-STORE-REFRESH] refresh tokens (sliding + absolute)', () => {
    const now = () => Date.now();
    const sample = (overrides = {}) => ({
      clientId: 'app',
      userId: 'u',
      scope: ['pryv:read'],
      issuedAt: now(),
      lastUsedAt: now(),
      expiresAt: now() + 60_000,
      absoluteExpiresAt: now() + 86_400_000,
      ...overrides,
    });

    it('[OS-RT1] setRefresh + getRefresh round-trip', async () => {
      const platform = fakePlatform();
      await storage.setRefresh(platform, 'core-a', 'RT1', sample());
      const got = await storage.getRefresh(platform, 'core-a', 'RT1');
      assert.equal(got.clientId, 'app');
    });
    it('[OS-RT2] uses the SOONER of expiresAt and absoluteExpiresAt as the access-state ttl', async () => {
      const platform = fakePlatform();
      // absoluteExpiresAt < expiresAt → row should expire at absoluteExpiresAt
      await storage.setRefresh(platform, 'core-a', 'RT2', sample({
        expiresAt: now() + 86_400_000,
        absoluteExpiresAt: now() - 1_000,
      }));
      assert.equal(await storage.getRefresh(platform, 'core-a', 'RT2'), null);
    });
    it('[OS-RT3] deleteRefresh removes the row', async () => {
      const platform = fakePlatform();
      await storage.setRefresh(platform, 'core-a', 'RT3', sample());
      await storage.deleteRefresh(platform, 'core-a', 'RT3');
      assert.equal(await storage.getRefresh(platform, 'core-a', 'RT3'), null);
    });
    it('[OS-RT4] tokens on different coreIds are independent', async () => {
      const platform = fakePlatform();
      await storage.setRefresh(platform, 'core-a', 'SAME', sample({ userId: 'A' }));
      await storage.setRefresh(platform, 'core-b', 'SAME', sample({ userId: 'B' }));
      assert.equal((await storage.getRefresh(platform, 'core-a', 'SAME')).userId, 'A');
      assert.equal((await storage.getRefresh(platform, 'core-b', 'SAME')).userId, 'B');
    });
  });

  describe('[OAUTH-STORE-ISO] keyspace isolation', () => {
    it('[OS-ISO1] client + code + refresh keyspaces do not collide on the same id', async () => {
      const platform = fakePlatform();
      const same = 'SAME-ID';
      await storage.setClient(platform, {
        clientId: same, redirectUris: ['x'], scope: [], grantTypes: ['authorization_code'],
      });
      await storage.setCode(platform, same, {
        clientId: 'app',
        redirectUri: 'x',
        codeChallenge: 'cc',
        codeChallengeMethod: 'S256',
        userId: 'u',
        scope: [],
        expiresAt: Date.now() + 60_000,
      });
      await storage.setRefresh(platform, 'core-a', same, {
        clientId: 'app',
        userId: 'u',
        scope: [],
        issuedAt: Date.now(),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        absoluteExpiresAt: Date.now() + 86_400_000,
      });
      assert.ok(await storage.getClient(platform, same));
      assert.ok(await storage.getCode(platform, same));
      assert.ok(await storage.getRefresh(platform, 'core-a', same));
    });
  });

  describe('[RJKT01] DPoP key revoke tombstones (presence blocklist)', () => {
    // A valid RFC 7638 thumbprint: exactly 43 unpadded base64url chars.
    const JKT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 chars
    const JKT2 = 'ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210_-abcde'; // 43 chars

    it('[RJKT01a] revokeDpopKey writes a tombstone readable via getDpopKeyRevokedAt/isDpopKeyRevoked', async () => {
      const platform = fakePlatform();
      const before = Date.now();
      await storage.revokeDpopKey(platform, JKT);
      assert.ok(platform._internalKvStore.has('dpop-jkt-revoked/' + JKT));
      const at = await storage.getDpopKeyRevokedAt(platform, JKT);
      assert.ok(typeof at === 'number' && at >= before);
      assert.equal(await storage.isDpopKeyRevoked(platform, JKT), true);
    });
    it('[RJKT01b] an un-revoked key reads null / false', async () => {
      const platform = fakePlatform();
      assert.equal(await storage.getDpopKeyRevokedAt(platform, JKT), null);
      assert.equal(await storage.isDpopKeyRevoked(platform, JKT), false);
    });
    it('[RJKT01c] revokeDpopKey rejects a malformed jkt (typo must fail loud, not tombstone nothing)', async () => {
      const platform = fakePlatform();
      await assert.rejects(() => storage.revokeDpopKey(platform, 'too-short'), /43-char base64url/);
      await assert.rejects(() => storage.revokeDpopKey(platform, JKT + 'x'), /43-char base64url/); // 44 chars
      await assert.rejects(() => storage.revokeDpopKey(platform, 'has spaces in it 34567890123456789012345678'), /43-char base64url/);
      assert.equal(platform._internalKvStore.size, 0);
    });
    it('[RJKT01d] unrevokeDpopKey clears the tombstone (operator recovery)', async () => {
      const platform = fakePlatform();
      await storage.revokeDpopKey(platform, JKT);
      await storage.unrevokeDpopKey(platform, JKT);
      assert.equal(await storage.isDpopKeyRevoked(platform, JKT), false);
      await assert.rejects(() => storage.unrevokeDpopKey(platform, 'bad'), /43-char base64url/);
    });
    it('[RJKT01e] listRevokedDpopKeys returns every tombstone with its epoch', async () => {
      const platform = fakePlatform();
      await storage.revokeDpopKey(platform, JKT);
      await storage.revokeDpopKey(platform, JKT2);
      const list = await storage.listRevokedDpopKeys(platform);
      const jkts = list.map((e) => e.jkt).sort();
      assert.deepEqual(jkts, [JKT, JKT2].sort());
      for (const e of list) assert.ok(typeof e.revokedAt === 'number' && e.revokedAt > 0);
    });
    it('[RJKT01f] pruneRevokedDpopKeys drops only tombstones older than maxAge', async () => {
      const platform = fakePlatform();
      await storage.revokeDpopKey(platform, JKT); // fresh (revokedAt ~ now)
      // Plant a stale tombstone directly (revokedAt far in the past).
      platform._internalKvStore.set('dpop-jkt-revoked/' + JKT2, JSON.stringify({ revokedAt: 1000 }));
      const pruned = await storage.pruneRevokedDpopKeys(platform, 60_000);
      assert.equal(pruned, 1);
      assert.equal(await storage.isDpopKeyRevoked(platform, JKT2), false);
      assert.equal(await storage.isDpopKeyRevoked(platform, JKT), true); // fresh one survives
    });
    it('[RJKT01h] pruneRevokedDpopKeys KEEPS a corrupt tombstone (fail-closed parity with enforcement)', async () => {
      const platform = fakePlatform();
      // A corrupt value: enforcement reads it as revoked (getDpopKeyRevokedAt → 0,
      // non-null), so prune must not delete it (which would silently un-revoke).
      platform._internalKvStore.set('dpop-jkt-revoked/' + JKT, 'not-json');
      platform._internalKvStore.set('dpop-jkt-revoked/' + JKT2, JSON.stringify({ revokedAt: 1000 })); // aged, real
      const pruned = await storage.pruneRevokedDpopKeys(platform, 60_000);
      assert.equal(pruned, 1); // only the aged real one
      assert.equal(await storage.isDpopKeyRevoked(platform, JKT), true, 'corrupt tombstone survives prune');
      assert.equal(await storage.isDpopKeyRevoked(platform, JKT2), false);
    });

    it('[RJKT01g] the jkt-revoked keyspace does not collide with the jti replay keyspace', async () => {
      const platform = fakePlatform();
      await storage.revokeDpopKey(platform, JKT);
      // Both prefixes share the 'dpop-' stem; a dpop-jti/ scan (the replay
      // cache loader) must NOT catch a dpop-jkt-revoked/ tombstone, and vice
      // versa — otherwise a revoke would look like a jti or get swept with it.
      assert.equal((await platform.listPlatformKvKeys('dpop-jti/')).length, 0);
      assert.equal((await platform.listPlatformKvKeys('dpop-jkt-revoked/')).length, 1);
      assert.equal((await storage.listRevokedDpopKeys(platform)).length, 1);
    });
  });

  describe('[KINV01] DPoP key inventory (advisory seen-records)', () => {
    const JKT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 chars
    const JKT2 = 'ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210_-abcde'; // 43 chars

    it('[KINV01a] recordDpopKeySeen stores under dpop-jkt-seen/<clientId>/<jkt> and round-trips', async () => {
      const platform = fakePlatform();
      await storage.recordDpopKeySeen(platform, 'appA', JKT);
      assert.ok(platform._internalKvStore.has('dpop-jkt-seen/appA/' + JKT));
      const list = await storage.listDpopKeysSeen(platform);
      assert.equal(list.length, 1);
      assert.deepEqual({ clientId: list[0].clientId, jkt: list[0].jkt }, { clientId: 'appA', jkt: JKT });
      assert.ok(list[0].firstSeenAt > 0 && list[0].lastSeenAt > 0);
    });

    it('[KINV01b] a repeat record preserves firstSeenAt and advances lastSeenAt', async () => {
      const platform = fakePlatform();
      await storage.recordDpopKeySeen(platform, 'appA', JKT);
      const first = (await storage.listDpopKeysSeen(platform))[0];
      // Force a distinct clock by planting an older firstSeenAt, then re-record.
      platform._internalKvStore.set('dpop-jkt-seen/appA/' + JKT, JSON.stringify({ firstSeenAt: 1000, lastSeenAt: 1000 }));
      await storage.recordDpopKeySeen(platform, 'appA', JKT);
      const again = (await storage.listDpopKeysSeen(platform))[0];
      assert.equal(again.firstSeenAt, 1000, 'firstSeenAt preserved');
      assert.ok(again.lastSeenAt > 1000, 'lastSeenAt advanced');
      assert.ok(first != null);
    });

    it('[KINV01c] listDpopKeysSeen scopes to one client when given; clientIds with a jkt parse cleanly', async () => {
      const platform = fakePlatform();
      await storage.recordDpopKeySeen(platform, 'appA', JKT);
      await storage.recordDpopKeySeen(platform, 'appA', JKT2);
      await storage.recordDpopKeySeen(platform, 'appB', JKT);
      const all = await storage.listDpopKeysSeen(platform);
      assert.equal(all.length, 3);
      const scoped = await storage.listDpopKeysSeen(platform, 'appA');
      assert.equal(scoped.length, 2);
      assert.ok(scoped.every((e) => e.clientId === 'appA'));
      // The 43-char no-slash jkt tail parses back even if clientId held a slash.
      await storage.recordDpopKeySeen(platform, 'core/appC', JKT);
      const weird = await storage.listDpopKeysSeen(platform, 'core/appC');
      assert.deepEqual({ clientId: weird[0].clientId, jkt: weird[0].jkt }, { clientId: 'core/appC', jkt: JKT });
    });

    it('[KINV01d] recordDpopKeySeen no-ops (never throws) on malformed input', async () => {
      const platform = fakePlatform();
      await storage.recordDpopKeySeen(platform, '', JKT);
      await storage.recordDpopKeySeen(platform, 'appA', 'not-a-jkt');
      assert.equal((await storage.listDpopKeysSeen(platform)).length, 0);
    });

    it('[KINV01e] pruneDpopKeysSeen drops rows not touched within maxAge', async () => {
      const platform = fakePlatform();
      await storage.recordDpopKeySeen(platform, 'appA', JKT); // fresh
      platform._internalKvStore.set('dpop-jkt-seen/appA/' + JKT2, JSON.stringify({ firstSeenAt: 1000, lastSeenAt: 1000 }));
      const pruned = await storage.pruneDpopKeysSeen(platform, 60_000);
      assert.equal(pruned, 1);
      const left = await storage.listDpopKeysSeen(platform);
      assert.deepEqual(left.map((e) => e.jkt), [JKT]);
    });

    it('[KINV01f] inventory keyspace does not collide with the revoke tombstone keyspace', async () => {
      const platform = fakePlatform();
      await storage.recordDpopKeySeen(platform, 'appA', JKT);
      await storage.revokeDpopKey(platform, JKT);
      assert.equal((await storage.listDpopKeysSeen(platform)).length, 1);
      assert.equal((await storage.listRevokedDpopKeys(platform)).length, 1);
    });
  });
});
