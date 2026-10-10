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
const { ignoredUsernameSubdomains } = require('../../src/usernameSubdomains.ts');
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

  it('[USUB-03] `single` cannot be registered as a username (its host is the core)', () => {
    const reserved = require('platform/src/reserved-words.json').list;
    assert.ok(reserved.includes('single'));
  });
});
