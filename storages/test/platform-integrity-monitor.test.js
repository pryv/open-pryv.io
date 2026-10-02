/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [PIMO] The periodic platform DB integrity check run by the master. A copy
 * damaged while the core runs must be reported without a restart: an error at
 * every failed check, one info line when it passes again, never two checks at
 * once, nothing after stop().
 */

const assert = require('node:assert/strict');
const { startPlatformIntegrityMonitor, resolveIntervalMs, DEFAULT_INTERVAL_MS } = require('../interfaces/platformStorage/integrityMonitor.ts');

const OK = { ok: true, structural: ['ok'], duplicateKeys: [] };
const FAILED = { ok: false, structural: ['ok'], duplicateKeys: [{ key: 'core-info/core-a', count: 2 }] };

function recorder () {
  const lines = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push('INFO ' + m),
      warn: (m) => lines.push('WARN ' + m),
      error: (m) => lines.push('ERROR ' + m)
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('[PIMO] periodic platform integrity check', () => {
  it('[PIM1] runs at the interval, logs an error at each failure and one info line on recovery', async () => {
    const results = [OK, FAILED, FAILED, OK, OK];
    let calls = 0;
    const { lines, logger } = recorder();
    const monitor = startPlatformIntegrityMonitor({
      check: async () => results[Math.min(calls++, results.length - 1)],
      intervalMs: 20,
      initialOk: true,
      logger
    });
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (calls >= 5) break;
        await sleep(10);
      }
      await sleep(5);
    } finally {
      monitor.stop();
    }
    assert.ok(calls >= 5, `scheduled checks ran (${calls})`);
    const errors = lines.filter((l) => l.startsWith('ERROR'));
    assert.equal(errors.length, 2);
    assert.match(errors[0], /\[platform-integrity\] FAILED/);
    assert.match(errors[0], /core-info\/core-a \(x2\)/);
    const infos = lines.filter((l) => l.startsWith('INFO'));
    assert.equal(infos.length, 1);
    assert.match(infos[0], /\[platform-integrity\] OK again/);
    assert.ok(lines.indexOf(infos[0]) > lines.indexOf(errors[1]));
  });

  it('[PIM2] a failure seen at boot is reported as recovered by the first passing check', async () => {
    const { lines, logger } = recorder();
    const monitor = startPlatformIntegrityMonitor({ check: async () => OK, intervalMs: 0, initialOk: false, logger });
    await monitor.runCheck();
    await monitor.runCheck();
    monitor.stop();
    assert.deepEqual(lines.filter((l) => l.startsWith('INFO')).length, 1);
    assert.equal(lines.length, 1);
  });

  it('[PIM3] checks never overlap', async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const { logger } = recorder();
    const monitor = startPlatformIntegrityMonitor({
      check: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(60);
        running--;
        return OK;
      },
      intervalMs: 10,
      logger
    });
    await sleep(200);
    monitor.stop();
    await sleep(70);
    assert.equal(maxRunning, 1);
    assert.ok(calls >= 2 && calls <= 4, `calls: ${calls}`);
  });

  it('[PIM4] a check that cannot run is a warning and keeps the known state', async () => {
    const results = [FAILED, new Error('rqlite not ready'), OK];
    let i = 0;
    const { lines, logger } = recorder();
    const monitor = startPlatformIntegrityMonitor({
      check: async () => {
        const r = results[i++];
        if (r instanceof Error) throw r;
        return r;
      },
      intervalMs: 0,
      logger
    });
    await monitor.runCheck();
    await monitor.runCheck();
    await monitor.runCheck();
    monitor.stop();
    assert.match(lines[0], /^ERROR \[platform-integrity\] FAILED/);
    assert.match(lines[1], /^WARN \[platform-integrity\] periodic check could not run: rqlite not ready/);
    assert.match(lines[2], /^INFO \[platform-integrity\] OK again/);
  });

  it('[PIM5] interval 0 disables the timer; stop() silences a check in flight', async () => {
    let calls = 0;
    const { lines, logger } = recorder();
    const disabled = startPlatformIntegrityMonitor({ check: async () => { calls++; return FAILED; }, intervalMs: 0, logger });
    await sleep(30);
    assert.equal(calls, 0);
    const pending = disabled.runCheck();
    disabled.stop();
    await pending;
    assert.equal(calls, 1);
    assert.deepEqual(lines, []);
  });

  it('[PIM6] resolveIntervalMs: default one hour, 0 disables, strings accepted, nonsense refused', () => {
    assert.equal(resolveIntervalMs(undefined), DEFAULT_INTERVAL_MS);
    assert.equal(resolveIntervalMs(null), 3600000);
    assert.equal(resolveIntervalMs(0), 0);
    assert.equal(resolveIntervalMs('600000'), 600000);
    assert.throws(() => resolveIntervalMs(-1), /integrityCheckIntervalMs/);
    assert.throws(() => resolveIntervalMs('soon'), /integrityCheckIntervalMs/);
  });
});
