/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-CLIENT] OAuth2 — client-registry tests.
 *
 * Unit-level: validateRedirectUri (pure) + getClient/persistClient/
 * removeClient/listClientIds via a fake PlatformDB. The full
 * conformance tests against the real rqlite engine live in
 * components/platform/test/conformance/PlatformDB.test.js
 * ([PLKV]).
 */

const assert = require('node:assert/strict');
const {
  getClient,
  validateRedirectUri,
  persistClient,
  removeClient,
  listClientIds,
} = require('../src/clientRegistry.ts');

/**
 * Fake PlatformDB exposing ONLY the generic kv primitives the
 * storage.ts module consumes. Refactor: storage.ts owns the OAuth
 * key prefix convention (`oauth-client/<id>`) — the engine interface
 * stays generic.
 */
function fakePlatform () {
  const store = new Map();
  return {
    async setPlatformKv (key, value) { store.set(key, value); },
    async getPlatformKv (key) { return store.has(key) ? store.get(key) : null; },
    async deletePlatformKv (key) { store.delete(key); },
    async listPlatformKvKeys (prefix) {
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
  };
}

describe('[OAUTH-CLIENT] client registry', () => {
  describe('[OAUTH-CLIENT-1] validateRedirectUri', () => {
    it('[OAUTH-CLIENT-1a] exact match passes', () => {
      assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/cb'), true);
    });
    it('[OAUTH-CLIENT-1b] trailing slash mismatch rejected', () => {
      assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/cb/'), false);
    });
    it('[OAUTH-CLIENT-1c] query-string mismatch rejected', () => {
      assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/cb?x=1'), false);
    });
    it('[OAUTH-CLIENT-1d] scheme mismatch rejected (http vs https)', () => {
      assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'http://a.example.com/cb'), false);
    });
    it('[OAUTH-CLIENT-1e] host mismatch rejected (subdomain attack)', () => {
      assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://attacker.example.com/cb'), false);
    });
    it('[OAUTH-CLIENT-1f] embedded userinfo phishing attempt rejected', () => {
      assert.equal(validateRedirectUri(['https://app.example.com/cb'], 'https://app.example.com:443@attacker.example/cb'), false);
    });
    it('[OAUTH-CLIENT-1g] loopback IPv4 carve-out: port may vary', () => {
      assert.equal(validateRedirectUri(['http://127.0.0.1/cb'], 'http://127.0.0.1:8742/cb'), true);
      assert.equal(validateRedirectUri(['http://127.0.0.1/cb'], 'http://127.0.0.1/cb'), true);
    });
    it('[OAUTH-CLIENT-1h] loopback IPv6 carve-out: port may vary', () => {
      assert.equal(validateRedirectUri(['http://[::1]/cb'], 'http://[::1]:8742/cb'), true);
    });
    it('[OAUTH-CLIENT-1i] loopback carve-out does NOT extend to path/scheme', () => {
      assert.equal(validateRedirectUri(['http://127.0.0.1/cb'], 'http://127.0.0.1:8742/cb/'), false);
      assert.equal(validateRedirectUri(['http://127.0.0.1/cb'], 'https://127.0.0.1/cb'), false);
    });
    it('[OAUTH-CLIENT-1j] loopback carve-out does NOT extend to non-loopback hosts', () => {
      assert.equal(validateRedirectUri(['http://example.com/cb'], 'http://example.com:8742/cb'), false);
    });
    it('[OAUTH-CLIENT-1k] private-use URI scheme — exact match works', () => {
      assert.equal(validateRedirectUri(['com.example.app:/cb'], 'com.example.app:/cb'), true);
    });
    it('[OAUTH-CLIENT-1l] empty input rejected', () => {
      assert.equal(validateRedirectUri([], 'https://x/cb'), false);
      assert.equal(validateRedirectUri(['https://x/cb'], ''), false);
      assert.equal(validateRedirectUri(null, 'https://x/cb'), false);
    });
  });

  describe('[OAUTH-CLIENT-2] getClient', () => {
    it('[OAUTH-CLIENT-2a] returns the registered client', async () => {
      const platform = fakePlatform();
      await platform.setPlatformKv('oauth-client/myapp', JSON.stringify({ clientId: 'myapp', redirectUris: ['x'], scope: ['pryv:read'], grantTypes: ['authorization_code'], updatedAt: 1 }));
      const c = await getClient(platform, 'myapp');
      assert.equal(c.clientId, 'myapp');
    });
    it('[OAUTH-CLIENT-2b] returns null on unknown client', async () => {
      const platform = fakePlatform();
      assert.equal(await getClient(platform, 'missing'), null);
    });
    it('[OAUTH-CLIENT-2c] returns null on empty / non-string', async () => {
      const platform = fakePlatform();
      assert.equal(await getClient(platform, ''), null);
      assert.equal(await getClient(platform, null), null);
    });
  });

  describe('[OAUTH-CLIENT-3] persistClient + removeClient + listClientIds', () => {
    it('[OAUTH-CLIENT-3a] persists with updatedAt stamped', async () => {
      const platform = fakePlatform();
      await persistClient(platform, {
        clientId: 'myapp',
        redirectUris: ['https://x/cb'],
        scope: ['pryv:read'],
        grantTypes: ['authorization_code'],
        updatedAt: 0,
      });
      const c = await getClient(platform, 'myapp');
      assert.ok(c.updatedAt > 0);
    });
    it('[OAUTH-CLIENT-3b] rejects missing clientId / redirectUris / grantTypes', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, { redirectUris: ['x'], grantTypes: ['authorization_code'] }), /clientId/);
      await assert.rejects(persistClient(platform, { clientId: 'a', grantTypes: ['authorization_code'] }), /redirectUris/);
      await assert.rejects(persistClient(platform, { clientId: 'a', redirectUris: ['x'] }), /grantTypes/);
    });
    it('[OAUTH-CLIENT-3c] removeClient is idempotent', async () => {
      const platform = fakePlatform();
      await removeClient(platform, 'missing'); // no throw
    });
    it('[OAUTH-CLIENT-3d] listClientIds returns sorted ids', async () => {
      const platform = fakePlatform();
      await persistClient(platform, { clientId: 'zeta', redirectUris: ['x'], scope: [], grantTypes: ['authorization_code'] });
      await persistClient(platform, { clientId: 'alpha', redirectUris: ['x'], scope: [], grantTypes: ['authorization_code'] });
      const list = await listClientIds(platform);
      assert.deepEqual(list, ['alpha', 'zeta']);
    });
  });
});
