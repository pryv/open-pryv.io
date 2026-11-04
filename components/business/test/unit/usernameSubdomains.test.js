/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * The core's own host is never read as a username by the username-in-host
 * rewriter, whatever its id: with the default `core.id: single`, a DNS-style
 * core's URL is `https://single.<domain>/`, and its root routes (account
 * deletion `DELETE /users/:username`) must stay reachable there.
 */

const assert = require('node:assert/strict');
const { ignoredUsernameSubdomains, ROOT_ONLY_PATHS } = require('../../src/usernameSubdomains.ts');
const subdomainToPath = require('middleware/src/subdomainToPath.ts').default;

const config = (values) => ({ get: (key) => values[key] });

function routedPath (coreId, host, url) {
  const ignored = ignoredUsernameSubdomains(config({ 'core:id': coreId }));
  const req = { url, headers: { host } };
  subdomainToPath(['/system', '/reg'], ignored)(req, {}, () => {}); // ignored paths: a stand-in for the routes list
  return req.url;
}

describe('[USUB] username subdomains ignored by the rewriter', () => {
  it('[USUB-01] the core id is ignored, the default `single` included', () => {
    for (const coreId of ['single', 'core-a']) {
      assert.ok(ignoredUsernameSubdomains(config({ 'core:id': coreId })).includes(coreId), coreId);
    }
  });

  it('[USUB-02] the core host reaches the root deletion route; a user host is still rewritten', () => {
    assert.strictEqual(routedPath('single', 'single.example.com', '/users/alice'), '/users/alice');
    assert.strictEqual(routedPath('core-a', 'core-a.example.com', '/users/alice'), '/users/alice');
    assert.strictEqual(routedPath('single', 'alice.example.com', '/events'), '/alice/events');
  });

  it('[USUB-04] the OAuth and discovery paths stay at the root on any host; other paths of a user host are still rewritten', () => {
    const ignored = ignoredUsernameSubdomains(config({ 'core:id': 'core-a' }));
    // the api-server's ignore list: the root routes plus the root-only prefixes
    const routed = (host, url) => {
      const req = { url, headers: { host } };
      subdomainToPath(['/system', '/reg'].concat(ROOT_ONLY_PATHS), ignored)(req, {}, () => {});
      return req.url;
    };
    for (const host of ['auth-eu.example.com', 'alice.example.com']) {
      for (const url of ['/oauth2/authorize?client_id=x', '/oauth2/token', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
        assert.strictEqual(routed(host, url), url, host + url);
      }
    }
    // prefix with the trailing slash: a look-alike path is a user path
    assert.strictEqual(routed('alice.example.com', '/oauth2x/y'), '/alice/oauth2x/y');
    assert.strictEqual(routed('alice.example.com', '/events'), '/alice/events');
  });

  it('[USUB-05] the root sign-in and account routes stay at the root on any host; a user\'s own sign-in is still rewritten', () => {
    const ignored = ignoredUsernameSubdomains(config({ 'core:id': 'core-a' }));
    const routed = (host, url) => {
      const req = { url, headers: { host } };
      subdomainToPath(['/system', '/reg'].concat(ROOT_ONLY_PATHS), ignored)(req, {}, () => {});
      return req.url;
    };
    for (const host of ['auth-eu.example.com', 'alice.example.com']) {
      for (const url of ['/auth/sso/providers', '/auth/sso/google/start?x=1', '/users', '/users?x=1', '/users/bob']) {
        assert.strictEqual(routed(host, url), url, host + url);
      }
    }
    assert.strictEqual(routed('alice.example.com', '/auth/login'), '/alice/auth/login');
    assert.strictEqual(routed('alice.example.com', '/accesses'), '/alice/accesses');
  });

  it('[USUB-03] `single` cannot be registered as a username (its host is the core)', () => {
    const reserved = require('platform/src/reserved-words.json').list;
    assert.ok(reserved.includes('single'));
  });
});
