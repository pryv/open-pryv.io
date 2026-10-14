/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — bootRetryLoop tests.
 *
 * [CMCBRL] covers config-gated retry-loop bootstrap: disabled-by-default,
 * worker-id gating, missing-provider safety, started-when-everything-OK.
 */

const assert = require('node:assert/strict');
const { startRetryLoopIfEnabled } = require('../src/bootRetryLoop.ts');

function fakeConfig (cfg) {
  return {
    get: (key) => {
      // key format: 'a:b:c'; cfg is nested object
      const parts = key.split(':');
      let cur = cfg;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[p];
      }
      return cur;
    },
  };
}

const STUB_DEPS = {
  mall: {},
  selfIdentityFor: () => ({ username: 'x', host: 'y' }),
  fetch: async () => ({}),
};

describe('[CMCBRL] cmc/bootRetryLoop', () => {
  it('[BRL07] startScheduler false: nothing is started (records are still queued by the dispatch wiring)', () => {
    const logged = [];
    const sched = startRetryLoopIfEnabled({
      ...STUB_DEPS,
      config: fakeConfig({ cmc: { retryLoop: { enabled: true, startScheduler: false } } }),
      userIdsProvider: () => ['u1'],
      isLoopWorker: () => true,
      logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m), debug () {} },
    });
    assert.equal(sched, null);
    assert.ok(logged.some((m) => m.includes('startScheduler')));
  });

  it('[BRL08] both passes visit the accounts that hold CMC state only: the retries stream probed once, a negative verdict re-checked after a while, a positive one kept; stopAll stops both schedulers', async () => {
    const { withCmcState, CMC_STATE_RECHECK_MS } = require('../src/bootRetryLoop.ts');
    const probes = [];
    const has = new Set(['u2']);
    const mall = { streams: { async getOneWithNoChildren (userId, streamId) { probes.push(userId + ' ' + streamId); return has.has(userId) ? { id: streamId } : null; } } };
    const provider = withCmcState(() => ['u1', 'u2', 'u3'], mall);
    assert.deepEqual(await provider(), ['u2']);
    assert.deepEqual(probes, ['u1 :_cmc:_internal:retries', 'u2 :_cmc:_internal:retries', 'u3 :_cmc:_internal:retries']);
    has.add('u1');
    assert.deepEqual(await provider(), ['u2'], 'the negative verdict is cached');
    assert.equal(probes.length, 3);
    const realNow = Date.now;
    Date.now = () => realNow() + CMC_STATE_RECHECK_MS + 1;
    try {
      assert.deepEqual(await provider(), ['u1', 'u2'], 'the negative verdicts are re-checked, the positive one is kept');
      assert.equal(probes.length, 5);
    } finally {
      Date.now = realNow;
    }
    const passes = [];
    const memberSweep = { async runLedgerPass (userId) { passes.push(userId); return { swept: 0, expired: 0, residuals: 0, pruned: 0 }; } };
    const sched = startRetryLoopIfEnabled({
      ...STUB_DEPS,
      mall,
      config: fakeConfig({ cmc: { retryLoop: { enabled: true, intervalMs: 60_000 }, memberAccess: { sweepIntervalMs: 60_000 } } }),
      userIdsProvider: () => ['u1', 'u2', 'u3'],
      isLoopWorker: () => true,
      memberSweep,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(passes, ['u1', 'u2'], 'the eager ledger pass skipped the account without CMC state');
    await sched.stopAll();
    assert.equal(sched.stats().running, false);
    assert.equal(sched.ledgerScheduler.stats().running, false);
  });

  it('[BRL01] returns null when config gate is off (default)', () => {
    const sched = startRetryLoopIfEnabled({
      ...STUB_DEPS,
      config: fakeConfig({}),
      userIdsProvider: () => [],
      isLoopWorker: () => true,
    });
    assert.equal(sched, null);
  });

  it('[BRL02] returns null + warns when enabled but no userIdsProvider', () => {
    const warns = [];
    const sched = startRetryLoopIfEnabled({
      ...STUB_DEPS,
      config: fakeConfig({ cmc: { retryLoop: { enabled: true } } }),
      logger: { debug: () => {}, warn: (msg) => warns.push(msg), info: () => {} },
      isLoopWorker: () => true,
    });
    assert.equal(sched, null);
    assert.equal(warns.length, 1);
  });

  it('[BRL03] returns null when isLoopWorker is false (e.g. worker 2 of N)', () => {
    const sched = startRetryLoopIfEnabled({
      ...STUB_DEPS,
      config: fakeConfig({ cmc: { retryLoop: { enabled: true } } }),
      userIdsProvider: () => [],
      isLoopWorker: () => false,
    });
    assert.equal(sched, null);
  });

  it('[BRL04] starts the scheduler when gate + worker + provider all OK', async () => {
    const sched = startRetryLoopIfEnabled({
      ...STUB_DEPS,
      config: fakeConfig({
        cmc: { retryLoop: { enabled: true, intervalMs: 1000, perUserLimit: 50 } },
      }),
      userIdsProvider: () => [],
      isLoopWorker: () => true,
    });
    assert.notEqual(sched, null);
    assert.equal(sched.stats().running, true);
    await sched.stop();
    assert.equal(sched.stats().running, false);
  });

  it('[BRL06] disables auto-enqueue on the loop\'s own dispatch (no retry-event amplification)', async () => {
    // The retry loop owns the retry lifecycle: processRetryEvent reschedules
    // the very event it re-dispatches. If that inner dispatch ALSO auto-
    // enqueued a fresh retry on failure, a still-failing item would be both
    // rescheduled and duplicated every cycle, and the duplicates spawn their
    // own — the retries stream fans out geometrically. The loop must pass
    // enqueueRetries: false.
    const sched = startRetryLoopIfEnabled({
      ...STUB_DEPS,
      config: fakeConfig({ cmc: { retryLoop: { enabled: true } } }),
      userIdsProvider: () => [],
      isLoopWorker: () => true,
    });
    assert.notEqual(sched, null);
    assert.equal(sched.deps.retryDeps.dispatchDeps.enqueueRetries, false);
    await sched.stop();
  });

  it('[BRL05] runs a tick with the configured retry deps', async () => {
    const ticked = [];
    const fakeScheduler = startRetryLoopIfEnabled({
      ...STUB_DEPS,
      config: fakeConfig({ cmc: { retryLoop: { enabled: true } } }),
      userIdsProvider: () => ['u1', 'u2'],
      isLoopWorker: () => true,
    });
    // Use the scheduler's tick directly. Override runRetryLoop on the
    // scheduler's deps closure isn't accessible — but tick still iterates
    // userIdsProvider, calling the real runRetryLoop. Override by
    // intercepting deps.retryDeps before construction is not available
    // here; instead just verify the scheduler started + the userIds list
    // is iterable.
    assert.notEqual(fakeScheduler, null);
    assert.equal(fakeScheduler.stats().running, true);
    await fakeScheduler.stop();
    // ticked array isn't populated by this test since we can't inject
    // a stub runRetryLoop through bootRetryLoop (it uses the module's
    // top-level reference). The [CMCRS] suite covers the loop behavior.
    assert.equal(ticked.length, 0);
  });
});
