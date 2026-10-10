/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global it, describe, before */

const assert = require('node:assert');
const cache = require('cache').default;

/**
 * Cached accesses are looked up by token and by access id, strings that come
 * from the request. Names of built-in object properties are ordinary keys:
 * unknown unless cached, and removed for good once unset.
 */
describe('[CAKY] Access-logic cache keys', function () {
  before(async function () {
    await cache.loadConfiguration();
  });

  let seq = 0;
  function freshUserId () { return 'caky-' + (++seq) + '-' + process.pid; }
  const NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'];

  it('[CAKY1] built-in property names are unknown tokens and ids for a user with cached accesses', function () {
    const u = freshUserId();
    cache.setAccessLogic(u, { id: 'a', token: 'tok' });
    assert.ok(cache.getAccessLogicForToken(u, 'tok') != null);
    for (const name of NAMES) {
      assert.strictEqual(cache.getAccessLogicForToken(u, name) ?? null, null, 'token ' + name);
      assert.strictEqual(cache.getAccessLogicForId(u, name) ?? null, null, 'id ' + name);
    }
  });

  it('[CAKY2] an access cached under such a token is found, then gone once unset', function () {
    const u = freshUserId();
    for (const name of NAMES) {
      const logic = { id: 'id-' + name, token: name };
      cache.setAccessLogic(u, logic);
      assert.strictEqual(cache.getAccessLogicForToken(u, name), logic, 'cached ' + name);
      cache.unsetAccessLogic(u, logic, false);
      assert.strictEqual(cache.getAccessLogicForToken(u, name) ?? null, null, 'unset ' + name);
      assert.strictEqual(cache.getAccessLogicForId(u, logic.id) ?? null, null, 'unset id of ' + name);
    }
    // Other lookups are not answered by a cached access's own properties.
    const logic = { id: 'x', token: '__proto__', permissions: [] };
    cache.setAccessLogic(u, logic);
    assert.strictEqual(cache.getAccessLogicForToken(u, 'permissions') ?? null, null);
    assert.strictEqual(cache.getAccessLogicForToken(u, 'id') ?? null, null);
  });
});
