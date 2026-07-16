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

    it('[OS-CD1] setCode + getCode round-trip; key includes coreId', async () => {
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
      await storage.setCode(platform, 'core-a', 'CODE1', payload);
      assert.ok(platform._internalStateStore.has('oauth-code/core-a/CODE1'));
      const got = await storage.getCode(platform, 'core-a', 'CODE1');
      assert.equal(got.codeChallenge, 'cc');
    });
    it('[OS-CD2] getCode returns null when expired (lazy-expire via setAccessState)', async () => {
      const platform = fakePlatform();
      await storage.setCode(platform, 'core-a', 'CODE2', {
        clientId: 'app',
        redirectUri: 'https://x/cb',
        codeChallenge: 'cc',
        codeChallengeMethod: 'S256',
        userId: 'u',
        scope: [],
        expiresAt: past(),
      });
      assert.equal(await storage.getCode(platform, 'core-a', 'CODE2'), null);
    });
    it('[OS-CD3] deleteCode removes the row', async () => {
      const platform = fakePlatform();
      await storage.setCode(platform, 'core-a', 'CODE3', {
        clientId: 'app',
        redirectUri: 'https://x/cb',
        codeChallenge: 'cc',
        codeChallengeMethod: 'S256',
        userId: 'u',
        scope: [],
        expiresAt: future(),
      });
      await storage.deleteCode(platform, 'core-a', 'CODE3');
      assert.equal(await storage.getCode(platform, 'core-a', 'CODE3'), null);
    });
    it('[OS-CD4] codes on different coreIds are independent', async () => {
      const platform = fakePlatform();
      const base = {
        redirectUri: 'https://x/cb',
        codeChallenge: 'cc',
        codeChallengeMethod: 'S256',
        userId: 'u',
        scope: [],
        expiresAt: future(),
      };
      await storage.setCode(platform, 'core-a', 'SAME', { ...base, clientId: 'A' });
      await storage.setCode(platform, 'core-b', 'SAME', { ...base, clientId: 'B' });
      assert.equal((await storage.getCode(platform, 'core-a', 'SAME')).clientId, 'A');
      assert.equal((await storage.getCode(platform, 'core-b', 'SAME')).clientId, 'B');
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
      await storage.setCode(platform, 'core-a', same, {
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
      assert.ok(await storage.getCode(platform, 'core-a', same));
      assert.ok(await storage.getRefresh(platform, 'core-a', same));
    });
  });
});
