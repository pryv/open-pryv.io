/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createWorkerStop } from '../../src/workerStop.ts';

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

describe('[WSTP] what an API worker finishes before it stops', function () {
  let proc, kills;

  beforeEach(function () {
    kills = [];
    proc = new EventEmitter();
    proc.pid = 4242;
    proc.kill = (pid, signal) => { kills.push([pid, signal]); };
  });

  /** Once the signal was raised again; then the time for one too many. */
  async function killed () {
    for (let i = 0; i < 400 && kills.length === 0; i++) await sleep(5);
    await sleep(20);
  }

  it('[WSTP1] the tasks run together; the signal is raised again once, after the slower one', async function () {
    const { onWorkerStop } = createWorkerStop(proc, 60_000);
    let release;
    const done = [];
    onWorkerStop('fast', async () => { done.push('fast'); });
    onWorkerStop('slow', () => new Promise((resolve) => { release = () => { done.push('slow'); resolve(); }; }));
    proc.emit('SIGTERM');
    await sleep(20);
    assert.deepStrictEqual([done, kills], [['fast'], []], 'not before the slower one');
    release();
    await killed();
    assert.deepStrictEqual(done, ['fast', 'slow']);
    assert.deepStrictEqual(kills, [[4242, 'SIGTERM']]);
    assert.strictEqual(proc.listenerCount('SIGTERM'), 0, 'the default action ends the process');
  });

  it('[WSTP2] a task that never ends does not hold the worker past the bound', async function () {
    const { onWorkerStop } = createWorkerStop(proc, 40);
    onWorkerStop('stuck', () => new Promise(() => {}));
    proc.emit('SIGTERM');
    assert.deepStrictEqual(kills, []);
    await killed();
    assert.deepStrictEqual(kills, [[4242, 'SIGTERM']]);
  });

  it('[WSTP3] a task that throws or rejects does not stop the others', async function () {
    const { onWorkerStop } = createWorkerStop(proc, 60_000);
    let done = false;
    onWorkerStop('throws', () => { throw new Error('thrown'); });
    onWorkerStop('rejects', () => Promise.reject(new Error('rejected')));
    onWorkerStop('works', async () => { await sleep(20); done = true; });
    proc.emit('SIGINT');
    await killed();
    assert.strictEqual(done, true);
    assert.deepStrictEqual(kills, [[4242, 'SIGINT']]);
  });

  it('[WSTP4] no task, no listener; a name registered again replaces the task', async function () {
    const { onWorkerStop } = createWorkerStop(proc, 5_000);
    assert.strictEqual(proc.listenerCount('SIGTERM') + proc.listenerCount('SIGINT'), 0);
    const ran = [];
    onWorkerStop('a', () => { ran.push('first'); });
    onWorkerStop('a', () => { ran.push('second'); });
    assert.strictEqual(proc.listenerCount('SIGTERM'), 1);
    proc.emit('SIGTERM');
    await killed();
    assert.deepStrictEqual(ran, ['second']);
    assert.strictEqual(kills.length, 1);
  });

  it('[WSTP5] the other signal while stopping: the worker leaves at once, once', async function () {
    const { onWorkerStop } = createWorkerStop(proc, 60);
    onWorkerStop('stuck', () => new Promise(() => {}));
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    assert.deepStrictEqual(kills, [[4242, 'SIGINT']]);
    await sleep(120);
    assert.strictEqual(kills.length, 1);
  });
});
