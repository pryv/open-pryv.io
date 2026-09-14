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
 * Fences the set-after-unset race: a caller captures getAccessLogicEpoch()
 * before a storage read and passes it back to setAccessLogic(), which must skip
 * re-inserting a now-stale entry if an invalidation moved the epoch meanwhile.
 */
describe('[CEP] Access-logic unset epoch', function () {
  before(async function () {
    // Guarantee the cache is active (config read) before asserting on inserts.
    await cache.loadConfiguration();
  });

  let seq = 0;
  function freshUserId () { return 'cep-' + (++seq) + '-' + process.pid; }

  it('[CEP1] setAccessLogic skips the insert when the epoch moved (unset with nothing cached still bumps)', function () {
    const u = freshUserId();
    const epoch = cache.getAccessLogicEpoch(u);
    // Invalidation lands "during the read"; nothing is cached yet for this user,
    // but the bump must still happen (fences the cold-cache case).
    cache.unsetAccessLogic(u, { id: 'stale', token: 'stale-tok' });
    cache.setAccessLogic(u, { id: 'stale', token: 'stale-tok' }, epoch);
    assert.ok(cache.getAccessLogicForToken(u, 'stale-tok') == null, 'stale entry must not be re-inserted');
  });

  it('[CEP2] setAccessLogic inserts when the epoch is unchanged', function () {
    const u = freshUserId();
    const epoch = cache.getAccessLogicEpoch(u);
    cache.setAccessLogic(u, { id: 'a', token: 'tok' }, epoch);
    const cached = cache.getAccessLogicForToken(u, 'tok');
    assert.ok(cached != null, 'entry should be cached');
    assert.strictEqual(cached.id, 'a');
  });

  it('[CEP3] setAccessLogic inserts when no expected epoch is passed (back-compat)', function () {
    const u = freshUserId();
    cache.setAccessLogic(u, { id: 'a', token: 'tok' });
    assert.ok(cache.getAccessLogicForToken(u, 'tok') != null, 'entry should be cached');
  });

  it('[CEP4] unsetUserData bumps the epoch (via _clearAccessLogics)', function () {
    const u = freshUserId();
    const epoch = cache.getAccessLogicEpoch(u);
    cache.unsetUserData(u);
    cache.setAccessLogic(u, { id: 'a', token: 'tok' }, epoch);
    assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'stale entry must not be re-inserted');
  });

  it('[CEP5] a pre-clear epoch cannot recur after clear() plus a later bump (monotonic counter, no ABA)', function () {
    const u = freshUserId();
    cache.unsetAccessLogic(u, { id: 'x', token: 'y' }); // epoch(u) now > 0
    const epochBeforeClear = cache.getAccessLogicEpoch(u);
    assert.ok(epochBeforeClear > 0);
    cache.clear(); // clears the epoch map but NOT the monotonic counter
    // A later invalidation must NOT recreate the captured value: with a global
    // monotonic counter the new epoch is strictly larger, whereas a per-user
    // reset would climb back to the same number and reopen the ABA hole.
    cache.unsetAccessLogic(u, { id: 'x', token: 'y' });
    cache.setAccessLogic(u, { id: 'a', token: 'tok' }, epochBeforeClear);
    assert.ok(cache.getAccessLogicForToken(u, 'tok') == null, 'pre-clear epoch must invalidate the insert');
  });
});
