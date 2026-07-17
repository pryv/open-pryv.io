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
    it('[OAUTH-CLIENT-1m] presented URI carrying a fragment rejected (RFC 6749 §3.1.2)', () => {
      // Even against an identical registered entry — a fragment URI can never
      // receive the appended ?code= (it lands inside the fragment).
      assert.equal(validateRedirectUri(['https://a.example.com/cb#f'], 'https://a.example.com/cb#f'), false);
      assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/cb#f'), false);
    });
  });

  /**
   * [OAUTH-REDIR] exhaustive redirect-URI matcher matrix — RFC 8252
   * §7.1 (private-use schemes), §7.2 (claimed https), §7.3 (loopback)
   * + RFC 9700 §2.1 exact-match rule against canonical attack strings.
   * Complements the [OAUTH-CLIENT-1] basics above.
   */
  describe('[OAUTH-REDIR] redirect-URI matcher — exhaustive matrix', () => {
    describe('[OAUTH-REDIR-1] exact-match strictness (no normalization)', () => {
      it('[OAUTH-REDIR-1a] scheme/host case difference rejected (no case folding)', () => {
        assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'HTTPS://a.example.com/cb'), false);
        assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://A.EXAMPLE.COM/cb'), false);
      });
      it('[OAUTH-REDIR-1b] explicit default port vs none rejected (no port normalization)', () => {
        assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com:443/cb'), false);
        assert.equal(validateRedirectUri(['https://a.example.com:443/cb'], 'https://a.example.com/cb'), false);
      });
      it('[OAUTH-REDIR-1c] percent-encoding difference rejected (no decode)', () => {
        assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/%63b'), false);
        assert.equal(validateRedirectUri(['https://a.example.com/cb%2Fx'], 'https://a.example.com/cb/x'), false);
      });
      it('[OAUTH-REDIR-1d] path traversal segment rejected (no path normalization)', () => {
        assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/cb/../evil'), false);
        assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/./cb'), false);
      });
      it('[OAUTH-REDIR-1e] prefix-matching attempts rejected both ways', () => {
        assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/cb/extra'), false);
        assert.equal(validateRedirectUri(['https://a.example.com/cb/extra'], 'https://a.example.com/cb'), false);
        assert.equal(validateRedirectUri(['https://a.example.com/'], 'https://a.example.com/cb'), false);
      });
      it('[OAUTH-REDIR-1f] fragment mismatch rejected', () => {
        assert.equal(validateRedirectUri(['https://a.example.com/cb'], 'https://a.example.com/cb#frag'), false);
      });
      it('[OAUTH-REDIR-1g] query param order/extension rejected', () => {
        assert.equal(validateRedirectUri(['https://a.example.com/cb?a=1&b=2'], 'https://a.example.com/cb?b=2&a=1'), false);
        assert.equal(validateRedirectUri(['https://a.example.com/cb?a=1'], 'https://a.example.com/cb?a=1&x=1'), false);
      });
      it('[OAUTH-REDIR-1h] any one of multiple registered URIs matches', () => {
        const registered = ['https://a.example.com/cb', 'com.example.app:/cb', 'http://127.0.0.1/cb'];
        assert.equal(validateRedirectUri(registered, 'com.example.app:/cb'), true);
        assert.equal(validateRedirectUri(registered, 'https://a.example.com/cb'), true);
        assert.equal(validateRedirectUri(registered, 'https://b.example.com/cb'), false);
      });
    });

    describe('[OAUTH-REDIR-2] canonical attack strings', () => {
      it('[OAUTH-REDIR-2a] userinfo trick: registered host as userinfo of attacker host', () => {
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'https://legit.example.com:443@attacker.example/cb'), false);
        assert.equal(validateRedirectUri(['https://legit.example.com:443/cb'], 'https://legit.example.com:443@attacker.example/cb'), false);
      });
      it('[OAUTH-REDIR-2b] registered URI as path/query of attacker URI', () => {
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'https://attacker.example/https://legit.example.com/cb'), false);
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'https://attacker.example/?u=https://legit.example.com/cb'), false);
      });
      it('[OAUTH-REDIR-2c] lookalike / suffix-domain hosts rejected', () => {
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'https://legit.example.com.attacker.example/cb'), false);
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'https://xlegit.example.com/cb'), false);
      });
      it('[OAUTH-REDIR-2d] backslash / whitespace / control-char confusion rejected, no throw', () => {
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'https://legit.example.com\\@attacker.example/cb'), false);
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], ' https://legit.example.com/cb'), false);
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'https://legit.example.com/cb '), false);
      });
      it('[OAUTH-REDIR-2e] garbage / non-URI strings rejected, no throw', () => {
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'not a uri at all'), false);
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], '//attacker.example/cb'), false);
        assert.equal(validateRedirectUri(['https://legit.example.com/cb'], 'javascript:alert(1)'), false);
      });
    });

    describe('[OAUTH-REDIR-3] loopback carve-out boundaries (RFC 8252 §7.3)', () => {
      it('[OAUTH-REDIR-3a] registered port is ignored too (only port relaxed, both sides)', () => {
        assert.equal(validateRedirectUri(['http://127.0.0.1:8080/cb'], 'http://127.0.0.1:9999/cb'), true);
        assert.equal(validateRedirectUri(['http://127.0.0.1:8080/cb'], 'http://127.0.0.1/cb'), true);
      });
      it('[OAUTH-REDIR-3b] localhost hostname is NOT carved out (resolvable ≠ loopback literal)', () => {
        assert.equal(validateRedirectUri(['http://localhost/cb'], 'http://localhost:8742/cb'), false);
        assert.equal(validateRedirectUri(['http://localhost:8742/cb'], 'http://localhost:8742/cb'), true);
      });
      it('[OAUTH-REDIR-3c] other 127.0.0.0/8 literals are NOT carved out', () => {
        assert.equal(validateRedirectUri(['http://127.0.0.2/cb'], 'http://127.0.0.2:8742/cb'), false);
      });
      it('[OAUTH-REDIR-3d] https loopback is NOT carved out (carve-out is http-only)', () => {
        assert.equal(validateRedirectUri(['https://127.0.0.1/cb'], 'https://127.0.0.1:8742/cb'), false);
        assert.equal(validateRedirectUri(['https://[::1]/cb'], 'https://[::1]:8742/cb'), false);
      });
      it('[OAUTH-REDIR-3e] userinfo mismatch on loopback rejected (everything but port is exact)', () => {
        assert.equal(validateRedirectUri(['http://127.0.0.1/cb'], 'http://user@127.0.0.1:8742/cb'), false);
        assert.equal(validateRedirectUri(['http://user@127.0.0.1/cb'], 'http://user@127.0.0.1:8742/cb'), true);
        assert.equal(validateRedirectUri(['http://user:pw@127.0.0.1/cb'], 'http://user:other@127.0.0.1:8742/cb'), false);
      });
      it('[OAUTH-REDIR-3f] query/fragment mismatch on loopback rejected', () => {
        assert.equal(validateRedirectUri(['http://127.0.0.1/cb?a=1'], 'http://127.0.0.1:8742/cb?a=2'), false);
        assert.equal(validateRedirectUri(['http://127.0.0.1/cb'], 'http://127.0.0.1:8742/cb#f'), false);
      });
      it('[OAUTH-REDIR-3g] loopback path normalization applies inside carve-out URL parsing', () => {
        // new URL() collapses dot-segments — a traversal cannot escape the registered path
        assert.equal(validateRedirectUri(['http://127.0.0.1/cb'], 'http://127.0.0.1:8742/cb/../evil'), false);
      });
      it('[OAUTH-REDIR-3h] IPv6 loopback long form canonicalizes to [::1] — still loopback, accepted', () => {
        assert.equal(validateRedirectUri(['http://[::1]/cb'], 'http://[0:0:0:0:0:0:0:1]:8742/cb'), true);
      });
    });

    describe('[OAUTH-REDIR-4] private-use schemes (RFC 8252 §7.1)', () => {
      it('[OAUTH-REDIR-4a] exact match required — scheme case difference rejected', () => {
        assert.equal(validateRedirectUri(['com.example.app:/cb'], 'COM.EXAMPLE.APP:/cb'), false);
      });
      it('[OAUTH-REDIR-4b] no port relaxation for private-use schemes', () => {
        assert.equal(validateRedirectUri(['com.example.app:/cb'], 'com.example.app:8080/cb'), false);
      });
      it('[OAUTH-REDIR-4c] path mismatch rejected', () => {
        assert.equal(validateRedirectUri(['com.example.app:/cb'], 'com.example.app:/other'), false);
      });
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
    it('[OAUTH-CLIENT-3e] rejects a redirectUri carrying a fragment (RFC 6749 §3.1.2)', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, {
        clientId: 'a', redirectUris: ['https://app.example/cb#frag'], grantTypes: ['authorization_code'],
      }), /fragment/);
      await assert.rejects(persistClient(platform, {
        clientId: 'a', redirectUris: ['https://ok/cb', 'https://app.example/cb#'], grantTypes: ['authorization_code'],
      }), /fragment/);
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

  describe('[OAUTH-CLIENT-4] cmcOffers validation on persistClient', () => {
    const base = {
      clientId: 'myapp',
      redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code'],
    };
    const CAP_URL = 'https://AbCdToken@myapp.example.com/';

    it('[OAUTH-CLIENT-4a] accepts a valid offer map + matching scope token', async () => {
      const platform = fakePlatform();
      await persistClient(platform, {
        ...base,
        scope: ['cmc:study-A'],
        cmcOffers: { 'study-A': { capabilityUrl: CAP_URL } },
      });
      const c = await getClient(platform, 'myapp');
      assert.deepEqual(c.cmcOffers, { 'study-A': { capabilityUrl: CAP_URL } });
    });
    it('[OAUTH-CLIENT-4b] rejects invalid offer names', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, {
        ...base, scope: [], cmcOffers: { '-bad': { capabilityUrl: CAP_URL } },
      }), /invalid offer name/);
    });
    it('[OAUTH-CLIENT-4c] rejects non-https or token-less capability URLs', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, {
        ...base, scope: [], cmcOffers: { a: { capabilityUrl: 'http://tok@x.example.com/' } },
      }), /https/);
      await assert.rejects(persistClient(platform, {
        ...base, scope: [], cmcOffers: { a: { capabilityUrl: 'https://x.example.com/' } },
      }), /userinfo|token/);
      await assert.rejects(persistClient(platform, {
        ...base, scope: [], cmcOffers: { a: {} },
      }), /capabilityUrl required/);
      await assert.rejects(persistClient(platform, {
        ...base, scope: [], cmcOffers: { a: { capabilityUrl: 'not a url' } },
      }), /not a valid URL/);
    });
    it('[OAUTH-CLIENT-4d] rejects a cmc: scope token without a matching offer entry', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, {
        ...base, scope: ['cmc:ghost'], cmcOffers: {},
      }), /no matching cmcOffers/);
      await assert.rejects(persistClient(platform, {
        ...base, scope: ['cmc:ghost'],
      }), /no matching cmcOffers/);
    });
  });
});
