/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — rate-limit tests.
 *
 * [CMCRL] covers per-worker sliding-window enforcement, retry-after
 * computation, and reset / size observability.
 */

const assert = require('node:assert/strict');
const {
  RateLimiter,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_IN_WINDOW,
} = require('../src/rateLimit.ts');

describe('[CMCRL] cmc/rateLimit', () => {
  it('[RL01] defaults: 100 events / 60s window', () => {
    assert.equal(DEFAULT_WINDOW_MS, 60 * 1000);
    assert.equal(DEFAULT_MAX_IN_WINDOW, 100);
  });

  it('[RL02] allows up to maxInWindow events; rejects the next one', () => {
    let now = 1000;
    const rl = new RateLimiter({ windowMs: 1000, maxInWindow: 3, now: () => now });
    for (let i = 0; i < 3; i++) {
      const r = rl.checkAndRecord({ source: 'a', recipient: 'b' });
      assert.equal(r.allowed, true, 'expected allow #' + i);
      assert.equal(r.currentCount, i + 1);
      now += 1;
    }
    const blocked = rl.checkAndRecord({ source: 'a', recipient: 'b' });
    assert.equal(blocked.allowed, false);
    assert.ok((blocked.retryAfterMs ?? 0) > 0);
    assert.equal(blocked.currentCount, 3);
  });

  it('[RL03] window slides — old entries drop off and new slots open', () => {
    let now = 1000;
    const rl = new RateLimiter({ windowMs: 1000, maxInWindow: 2, now: () => now });
    rl.checkAndRecord({ source: 'a', recipient: 'b' });
    now += 500;
    rl.checkAndRecord({ source: 'a', recipient: 'b' });
    now += 200;
    // Window full
    assert.equal(rl.checkAndRecord({ source: 'a', recipient: 'b' }).allowed, false);
    now += 400; // first entry now 1100ms old (>1000ms window) → falls out
    assert.equal(rl.checkAndRecord({ source: 'a', recipient: 'b' }).allowed, true);
  });

  it('[RL04] separates buckets per (source, recipient) pair', () => {
    const now = 1000;
    const rl = new RateLimiter({ windowMs: 1000, maxInWindow: 1, now: () => now });
    assert.equal(rl.checkAndRecord({ source: 'a', recipient: 'b' }).allowed, true);
    // Different recipient → fresh bucket
    assert.equal(rl.checkAndRecord({ source: 'a', recipient: 'c' }).allowed, true);
    // Different source → fresh bucket
    assert.equal(rl.checkAndRecord({ source: 'd', recipient: 'b' }).allowed, true);
    // Same pair → blocked
    assert.equal(rl.checkAndRecord({ source: 'a', recipient: 'b' }).allowed, false);
  });

  it('[RL05] retryAfterMs reflects time until oldest entry expires', () => {
    let now = 10000;
    const rl = new RateLimiter({ windowMs: 1000, maxInWindow: 1, now: () => now });
    rl.checkAndRecord({ source: 'a', recipient: 'b' });
    now += 300;
    const r = rl.checkAndRecord({ source: 'a', recipient: 'b' });
    assert.equal(r.allowed, false);
    // Oldest entry was at 10000; window expires at 11000; current is 10300.
    // retryAfter = 11000 - 10300 = 700ms
    assert.equal(r.retryAfterMs, 700);
  });

  it('[RL06] countFor returns current usage without recording', () => {
    const rl = new RateLimiter({ windowMs: 1000, maxInWindow: 5, now: () => 1000 });
    rl.checkAndRecord({ source: 'a', recipient: 'b' });
    rl.checkAndRecord({ source: 'a', recipient: 'b' });
    assert.equal(rl.countFor({ source: 'a', recipient: 'b' }), 2);
    // countFor shouldn't bump the count
    assert.equal(rl.countFor({ source: 'a', recipient: 'b' }), 2);
  });

  it('[RL07] countFor trims stale entries even without checkAndRecord', () => {
    let now = 1000;
    const rl = new RateLimiter({ windowMs: 1000, maxInWindow: 5, now: () => now });
    rl.checkAndRecord({ source: 'a', recipient: 'b' });
    now += 2000;
    assert.equal(rl.countFor({ source: 'a', recipient: 'b' }), 0);
  });

  it('[RL08] reset() clears all windows; size() reports tracked-pair count', () => {
    const rl = new RateLimiter({ windowMs: 1000, maxInWindow: 5, now: () => 1000 });
    rl.checkAndRecord({ source: 'a', recipient: 'b' });
    rl.checkAndRecord({ source: 'a', recipient: 'c' });
    assert.equal(rl.size(), 2);
    rl.reset();
    assert.equal(rl.size(), 0);
  });
});
