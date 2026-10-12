/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');

describe('[PVRQ] previews render limiter', function () {
  const { createRenderLimiter } = require('../src/renderLimiter.ts');

  function deferred () {
    const gate = {};
    gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
    return gate;
  }

  it('[PVRQ1] runs at most two renders at once, the others wait their turn in order', async function () {
    const limiter = createRenderLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started = [];
    let running = 0;
    let peak = 0;
    const runs = gates.map((gate, i) => limiter.run(async () => {
      started.push(i);
      running++;
      peak = Math.max(peak, running);
      await gate.promise;
      running--;
      return i;
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(started, [0, 1]);
    assert.strictEqual(limiter.waiting, 2);

    gates[1].resolve();
    await runs[1];
    // a newcomer arriving as the slot is freed does not jump the queue
    const late = limiter.run(async () => { started.push('late'); return 'late'; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(started, [0, 1, 2]);

    gates[0].resolve();
    gates[2].resolve();
    gates[3].resolve();
    assert.deepStrictEqual(await Promise.all(runs), [0, 1, 2, 3]);
    assert.strictEqual(await late, 'late');
    assert.deepStrictEqual(started, [0, 1, 2, 3, 'late']);
    assert.strictEqual(peak, 2);
    assert.strictEqual(limiter.active, 0);
  });

  it('[PVRQ2] a failing render frees its slot', async function () {
    const limiter = createRenderLimiter(1);
    await assert.rejects(limiter.run(async () => { throw new Error('render failed'); }), /render failed/);
    assert.strictEqual(await limiter.run(async () => 'next'), 'next');
    assert.strictEqual(limiter.active, 0);
  });
});
