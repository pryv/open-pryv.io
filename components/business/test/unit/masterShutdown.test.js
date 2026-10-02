/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The master's shutdown sequence. The master used to exit as soon as its
 * last worker was gone, while rqlited was still taking its snapshot-on-close,
 * which interrupted the snapshot. It must exit only once rqlited has exited.
 */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMasterShutdown } = require('../../src/masterShutdown.ts');

/** A fake worker: exits `exitAfterMs` after SIGTERM (never when null). */
function fakeWorker (cluster, id, exitAfterMs, events) {
  const w = {
    dead: false,
    signals: [],
    isDead () { return this.dead; },
    process: {
      kill (sig) {
        w.signals.push(sig);
        events.push(`worker${id}:${sig}`);
        const delay = sig === 'SIGKILL' ? 0 : exitAfterMs;
        if (delay == null || w.dead) return;
        setTimeout(() => {
          if (w.dead) return;
          w.dead = true;
          events.push(`worker${id}:exited`);
          delete cluster.workers[id];
          cluster.emit('exit', w);
        }, delay);
      }
    }
  };
  cluster.workers[id] = w;
  return w;
}

function setup ({ workers = [20, 30], rqliteStopMs = 200, workersTimeoutMs, servicesTimeoutMs, deadlineMs, stopRqlite, stopServices } = {}) {
  const events = [];
  const cluster = new EventEmitter();
  cluster.workers = {};
  workers.forEach((ms, i) => fakeWorker(cluster, i + 1, ms, events));
  let exited;
  const exitedP = new Promise((resolve) => { exited = resolve; });
  const exitCodes = [];
  const logs = [];
  const shutdown = createMasterShutdown({
    cluster,
    stopServices: stopServices ?? (() => { events.push('services:stopped'); }),
    stopRqlite: stopRqlite ?? (() => new Promise((resolve) => {
      events.push('rqlite:stopping');
      setTimeout(() => { events.push('rqlite:exited'); resolve(); }, rqliteStopMs);
    })),
    log: (m) => logs.push(m),
    warn: (m) => logs.push('WARN ' + m),
    exit: (code) => { events.push(`exit:${code}`); exitCodes.push(code); exited(code); },
    workersTimeoutMs,
    servicesTimeoutMs,
    deadlineMs
  });
  // As bin/master.js wires it.
  cluster.on('exit', () => shutdown.onWorkerExit());
  return { cluster, shutdown, events, exitCodes, exitedP, logs };
}

describe('[MSHD] master shutdown sequence', function () {
  this.timeout(10000);

  it('[MSH1] exits only after rqlited has exited, which is stopped after the workers', async () => {
    const { shutdown, events, exitedP } = setup();
    shutdown.shutdown('SIGTERM');
    assert.equal(await exitedP, 0);
    const idx = (e) => events.indexOf(e);
    assert.ok(idx('worker1:exited') >= 0 && idx('worker2:exited') >= 0);
    assert.ok(idx('rqlite:stopping') > idx('worker1:exited'));
    assert.ok(idx('rqlite:stopping') > idx('worker2:exited'));
    assert.ok(idx('exit:0') > idx('rqlite:exited'), 'master exit after rqlited exit: ' + events.join(', '));
    assert.equal(events.filter((e) => e.startsWith('exit:')).length, 1);
  });

  it('[MSH2] the last worker exiting does not exit the master on its own', async () => {
    const { shutdown, events, exitedP } = setup({ workers: [5], rqliteStopMs: 400 });
    shutdown.shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(events.includes('worker1:exited'));
    assert.ok(!events.some((e) => e.startsWith('exit:')), 'still waiting for rqlited: ' + events.join(', '));
    await exitedP;
    assert.ok(events.indexOf('exit:0') > events.indexOf('rqlite:exited'));
  });

  it('[MSH3] workers that do not stop in time are killed, then rqlited is still awaited', async () => {
    const { shutdown, events, exitedP, logs } = setup({ workers: [null], workersTimeoutMs: 100 });
    shutdown.shutdown('SIGTERM');
    assert.equal(await exitedP, 0);
    assert.ok(events.indexOf('worker1:SIGKILL') > events.indexOf('worker1:SIGTERM'));
    assert.ok(events.indexOf('exit:0') > events.indexOf('rqlite:exited'));
    assert.ok(logs.some((l) => /WARN 1 worker\(s\) still running after 100 ms/.test(l)));
  });

  it('[MSH4] a hung rqlited stop is bounded by the overall deadline', async () => {
    const { shutdown, exitedP, logs } = setup({ workers: [], deadlineMs: 150, stopRqlite: () => new Promise(() => {}) });
    shutdown.shutdown('SIGTERM');
    assert.equal(await exitedP, 1);
    assert.ok(logs.some((l) => /WARN Shutdown did not complete within 150 ms/.test(l)));
  });

  it('[MSH5] a second signal does not start a second sequence', async () => {
    let stops = 0;
    const { shutdown, exitedP, exitCodes } = setup({
      workers: [10],
      stopRqlite: () => { stops++; return new Promise((resolve) => setTimeout(resolve, 50)); }
    });
    shutdown.shutdown('SIGTERM');
    shutdown.shutdown('SIGINT');
    assert.equal(shutdown.isShuttingDown(), true);
    await exitedP;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stops, 1);
    assert.deepEqual(exitCodes, [0]);
  });

  it('[MSH6] a hung service stop is bounded, and rqlited is still stopped and awaited', async () => {
    const { shutdown, events, exitedP, logs } = setup({
      workers: [10],
      servicesTimeoutMs: 50,
      stopServices: () => new Promise(() => {})
    });
    shutdown.shutdown('SIGTERM');
    assert.equal(await exitedP, 0);
    assert.ok(events.indexOf('exit:0') > events.indexOf('rqlite:exited'), events.join(', '));
    assert.ok(logs.some((l) => /WARN Master services did not stop within 50 ms/.test(l)));
  });
});
