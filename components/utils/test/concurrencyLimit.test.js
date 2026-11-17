/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { createLimiter, isCapacityRefusal, CapacityRefusal } = require('../src/concurrencyLimit.ts');
const encryption = require('../src/encryption.ts');

/** A work the test finishes by hand: `start` is the work, `finish`/`fail` end it. */
function gated () {
  let finish, fail;
  let started = false;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  return {
    get started () { return started; },
    start: () => { started = true; return done; },
    finish: (v) => finish(v),
    fail: (e) => fail(e)
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function settings (over = {}) {
  return { concurrency: 2, queue: 50, maxWaitMs: 10000, retryAfterSeconds: 5, ...over };
}

describe('[CLIM] bounded concurrency limiter', function () {
  it('[CLIM1] never runs more than N works at once, and serves them in arrival order', async () => {
    const limiter = createLimiter('test work');
    limiter.configure(settings({ concurrency: 3 }));
    let running = 0;
    let peak = 0;
    const order = [];
    const gates = [];
    const calls = [];
    for (let i = 0; i < 20; i++) {
      const g = gated();
      gates.push(g);
      calls.push(limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        order.push(i);
        try { return await g.start(); } finally { running--; }
      }));
    }
    await tick();
    assert.equal(running, 3);
    assert.deepEqual(limiter.stats(), { running: 3, waiting: 17 });
    // Finish in arrival order, one at a time.
    for (let i = 0; i < 20; i++) {
      gates[i].finish(i);
      await tick();
      assert.ok(running <= 3, `running ${running} > 3`);
    }
    assert.deepEqual(await Promise.all(calls), [...Array(20).keys()]);
    assert.equal(peak, 3);
    assert.deepEqual(order, [...Array(20).keys()]);
    assert.deepEqual(limiter.stats(), { running: 0, waiting: 0 });
  });

  it('[CLIM2] refuses the call past slots + queue at once with a typed refusal; the others complete', async () => {
    const limiter = createLimiter('test work');
    limiter.configure(settings({ concurrency: 2, queue: 3 }));
    const gates = [];
    const calls = [];
    for (let i = 0; i < 5; i++) {
      const g = gated();
      gates.push(g);
      calls.push(limiter.run(g.start));
    }
    let workRan = false;
    await assert.rejects(limiter.run(async () => { workRan = true; }), (err) => {
      assert.ok(isCapacityRefusal(err));
      assert.ok(err instanceof CapacityRefusal);
      assert.equal(err.retryAfterSeconds, 5);
      return true;
    });
    assert.equal(workRan, false);
    gates.forEach((g, i) => g.finish(i));
    assert.deepEqual(await Promise.all(calls), [0, 1, 2, 3, 4]);
  });

  it('[CLIM3] a call whose turn comes after the wait limit is refused and its work never runs', async () => {
    const limiter = createLimiter('test work');
    limiter.configure(settings({ concurrency: 1, maxWaitMs: 30 }));
    const holder = gated();
    const held = limiter.run(holder.start);
    let lateRan = false;
    const late = limiter.run(async () => { lateRan = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    holder.finish('held');
    assert.equal(await held, 'held');
    await assert.rejects(late, (err) => isCapacityRefusal(err));
    assert.equal(lateRan, false);
    // The refused call released its slot: the next one runs.
    assert.equal(await limiter.run(async () => 'next'), 'next');
    assert.deepEqual(limiter.stats(), { running: 0, waiting: 0 });
  });

  it('[CLIM4] a work that fails frees its slot, also to a call waiting for it', async () => {
    const limiter = createLimiter('test work');
    limiter.configure(settings({ concurrency: 1, queue: 1 }));
    await assert.rejects(limiter.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await limiter.run(async () => 'after failure'), 'after failure');
    const failing = gated();
    const first = limiter.run(failing.start);
    const second = limiter.run(async () => 'second');
    failing.fail(new Error('late boom'));
    await assert.rejects(first, /late boom/);
    assert.equal(await second, 'second');
    assert.deepEqual(limiter.stats(), { running: 0, waiting: 0 });
  });

  it('[CLIM5] unconfigured, or with concurrency 0, every call runs at once and none is refused', async () => {
    for (const configure of [null, settings({ concurrency: 0, queue: 0 })]) {
      const limiter = createLimiter('test work');
      if (configure != null) limiter.configure(configure);
      const gates = [];
      const calls = [];
      for (let i = 0; i < 200; i++) {
        const g = gated();
        gates.push(g);
        calls.push(limiter.run(g.start));
      }
      await tick();
      assert.equal(gates.filter((g) => g.started).length, 200);
      gates.forEach((g, i) => g.finish(i));
      assert.equal((await Promise.all(calls)).length, 200);
    }
  });
});

describe('[CLIB] bcrypt calls share one limiter', function () {
  this.timeout(10000);
  afterEach(() => encryption.configureBcryptLimit(null));

  it('[CLIB1] hash and compare wait for a held slot, and complete once it is released', async () => {
    const stored = await encryption.hash('clib-password');
    encryption.configureBcryptLimit({ concurrency: 1, queue: 10 });
    const holder = gated();
    const held = encryption.withBcryptSlot(holder.start);
    let hashed = null;
    let compared = null;
    const h = encryption.hash('another').then((v) => { hashed = v; });
    const c = encryption.compare('clib-password', stored).then((v) => { compared = v; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hashed, null);
    assert.equal(compared, null);
    assert.deepEqual(encryption.bcryptLimitStats(), { running: 1, waiting: 2 });
    holder.finish();
    await Promise.all([held, h, c]);
    assert.equal(typeof hashed, 'string');
    assert.equal(compared, true);
  });

  it('[CLIB2] a full queue refuses hash and compare with a capacity refusal, without hashing', async () => {
    const stored = await encryption.hash('clib-password');
    encryption.configureBcryptLimit({ concurrency: 1, queue: 0 });
    const holder = gated();
    const held = encryption.withBcryptSlot(holder.start);
    await assert.rejects(encryption.hash('x'), (err) => isCapacityRefusal(err));
    await assert.rejects(encryption.compare('clib-password', stored), (err) => isCapacityRefusal(err));
    holder.finish();
    await held;
    assert.equal(await encryption.compare('clib-password', stored), true);
  });
});
