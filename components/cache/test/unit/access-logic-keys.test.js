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

  it('[CAKY3] an access set again under a new token is no longer found by its previous token', function () {
    const u = freshUserId();
    cache.setAccessLogic(u, { id: 'a', token: 'old-token' });
    const renewed = { id: 'a', token: 'new-token' };
    cache.setAccessLogic(u, renewed);
    assert.strictEqual(cache.getAccessLogicForToken(u, 'old-token') ?? null, null);
    assert.strictEqual(cache.getAccessLogicForToken(u, 'new-token'), renewed);
    assert.strictEqual(cache.getAccessLogicForId(u, 'a'), renewed);
    // the id-only invalidation then evicts the current token
    cache.unsetAccessLogic(u, { id: 'a' }, false);
    assert.strictEqual(cache.getAccessLogicForToken(u, 'new-token') ?? null, null);
    // the same token set again for the same id stays found
    const same = { id: 'b', token: 'b-token' };
    cache.setAccessLogic(u, same);
    cache.setAccessLogic(u, same);
    assert.strictEqual(cache.getAccessLogicForToken(u, 'b-token'), same);
  });
});
