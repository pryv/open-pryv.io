/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — RetryScheduler tests.
 *
 * [CMCRS] covers start/stop, per-user iteration, error isolation,
 * non-overlapping ticks.
 */

const assert = require('node:assert/strict');
const { RetryScheduler } = require('../src/retryScheduler.ts');

function fakeRunRetryLoop (recorder, opts = {}) {
  return async function runRetryLoop (params) {
    recorder.push(params.userId);
    if (opts.throwFor && opts.throwFor.includes(params.userId)) {
      throw new Error('boom-' + params.userId);
    }
    if (opts.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
    return {
      processed: 1,
      succeeded: 1,
      rescheduled: 0,
      failedPermanent: 0,
      skipped: 0,
    };
  };
}

describe('[CMCRS] cmc/retryScheduler', () => {
  it('[RS01] tick iterates over provider-supplied userIds and aggregates stats', async () => {
    const seen = [];
    const sched = new RetryScheduler({
      retryDeps: {},
      userIdsProvider: () => ['u1', 'u2', 'u3'],
      runRetryLoop: fakeRunRetryLoop(seen),
    });
    const r = await sched.tick();
    assert.deepEqual(seen, ['u1', 'u2', 'u3']);
    assert.equal(r.users, 3);
    assert.equal(r.succeeded, 3);
    assert.equal(r.errors, 0);
  });

  it('[RS02] per-user errors are isolated; tick continues + counts them', async () => {
    const seen = [];
    const sched = new RetryScheduler({
      retryDeps: {},
      userIdsProvider: () => ['u1', 'u2', 'u3'],
      runRetryLoop: fakeRunRetryLoop(seen, { throwFor: ['u2'] }),
      logger: { warn: () => {} },
    });
    const r = await sched.tick();
    assert.deepEqual(seen, ['u1', 'u2', 'u3']);
    assert.equal(r.errors, 1);
    assert.equal(r.succeeded, 2); // u1 + u3 succeeded
    assert.equal(sched.stats().errors, 1);
  });

  it('[RS03] start + stop schedules + clears the interval', async () => {
    const seen = [];
    const sched = new RetryScheduler({
      retryDeps: {},
      userIdsProvider: () => ['u1'],
      runRetryLoop: fakeRunRetryLoop(seen),
    });
    sched.start(20);
    assert.equal(sched.stats().running, true);
    await new Promise((resolve) => setTimeout(resolve, 70)); // wait for ~3 ticks
    await sched.stop();
    assert.equal(sched.stats().running, false);
    // At least 1 tick fired
    assert.ok(seen.length >= 1, 'expected at least one tick, got ' + seen.length);
  });

  it('[RS04] stop() waits for in-flight tick before resolving', async () => {
    const seen = [];
    const sched = new RetryScheduler({
      retryDeps: {},
      userIdsProvider: () => ['u1'],
      runRetryLoop: fakeRunRetryLoop(seen, { delayMs: 50 }),
    });
    sched.start(10);
    // Wait long enough for the timer to fire and the tick to start.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stopP = sched.stop();
    // stop() shouldn't resolve before the 50ms delay has elapsed.
    const before = Date.now();
    await stopP;
    const elapsed = Date.now() - before;
    // Allow some scheduling slack but expect blocking on the in-flight tick.
    assert.ok(elapsed >= 5, 'stop should wait for in-flight tick; elapsed=' + elapsed);
  });

  it('[RS05] manual tick() while another tick is in-flight is skipped + counts', async () => {
    const seen = [];
    const sched = new RetryScheduler({
      retryDeps: {},
      userIdsProvider: () => ['u1'],
      runRetryLoop: fakeRunRetryLoop(seen, { delayMs: 30 }),
      logger: { info: () => {} },
    });
    const p1 = sched.tick();
    // Fire a second tick while p1 is still running.
    const p2 = sched.tick();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.users, 1);
    // r2 should have been the skipped one — users=0.
    assert.equal(r2.users, 0);
    assert.equal(sched.stats().skipped, 1);
  });

  it('[RS06] userIdsProvider may return a Promise', async () => {
    const seen = [];
    const sched = new RetryScheduler({
      retryDeps: {},
      userIdsProvider: async () => ['u1', 'u2'],
      runRetryLoop: fakeRunRetryLoop(seen),
    });
    const r = await sched.tick();
    assert.equal(r.users, 2);
  });

  it('[RS07] empty userIds is a no-op', async () => {
    const seen = [];
    const sched = new RetryScheduler({
      retryDeps: {},
      userIdsProvider: () => [],
      runRetryLoop: fakeRunRetryLoop(seen),
    });
    const r = await sched.tick();
    assert.deepEqual(seen, []);
    assert.equal(r.users, 0);
    assert.equal(r.succeeded, 0);
  });
});
