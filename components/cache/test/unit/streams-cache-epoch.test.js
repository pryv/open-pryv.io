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
 * Fences the streams-cache set-after-unset race (mirror of the access-logic
 * epoch): a producer captures getStreamsEpoch() before its storage read and
 * passes it back to setStreams(), which skips re-inserting a now-stale stream
 * tree if an invalidation moved the epoch meanwhile.
 */
describe('[SEP] Streams-cache unset epoch', function () {
  before(async function () {
    await cache.loadConfiguration();
  });

  let seq = 0;
  function freshUserId () { return 'sep-' + (++seq) + '-' + process.pid; }

  it('[SEP1] setStreams skips the insert when unsetStreams moved the epoch (nothing cached still bumps)', function () {
    const u = freshUserId();
    const epoch = cache.getStreamsEpoch(u, 'local');
    cache.unsetStreams(u, 'local'); // routes through _unsetStreams -> bumps
    cache.setStreams(u, 'local', ['stale'], epoch);
    assert.ok(cache.getStreams(u, 'local') == null, 'stale stream tree must not be re-inserted');
  });

  it('[SEP2] setStreams inserts when the epoch is unchanged', function () {
    const u = freshUserId();
    const epoch = cache.getStreamsEpoch(u, 'local');
    cache.setStreams(u, 'local', ['fresh'], epoch);
    assert.deepStrictEqual(cache.getStreams(u, 'local'), ['fresh']);
  });

  it('[SEP3] setStreams inserts when no expected epoch is passed (back-compat)', function () {
    const u = freshUserId();
    cache.setStreams(u, 'local', ['fresh']);
    assert.deepStrictEqual(cache.getStreams(u, 'local'), ['fresh']);
  });

  it('[SEP4] unsetUserData bumps the streams epoch (via _unsetStreams)', function () {
    const u = freshUserId();
    const epoch = cache.getStreamsEpoch(u, 'local');
    cache.unsetUserData(u);
    cache.setStreams(u, 'local', ['stale'], epoch);
    assert.ok(cache.getStreams(u, 'local') == null, 'stale stream tree must not be re-inserted');
  });

  it('[SEP5] a pre-clear epoch cannot recur after clear() plus a later bump (monotonic, no ABA)', function () {
    const u = freshUserId();
    cache.unsetStreams(u, 'local'); // epoch now > 0
    const epochBeforeClear = cache.getStreamsEpoch(u, 'local');
    assert.ok(epochBeforeClear > 0);
    cache.clear(); // clears the epoch map but NOT the monotonic counter
    cache.unsetStreams(u, 'local'); // a later invalidation must be strictly larger
    cache.setStreams(u, 'local', ['stale'], epochBeforeClear);
    assert.ok(cache.getStreams(u, 'local') == null, 'pre-clear epoch must invalidate the insert');
  });
});
