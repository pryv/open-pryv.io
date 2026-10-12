/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The master replaced a dead worker at once, every time: a worker crashing
 * at boot looped without pause. Replacements of workers that keep dying
 * soon after they started are delayed, doubling up to a cap.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkerRestartBackoff, restartDelayMs } = require('../../src/workerRestartBackoff.ts');

describe('[WRBO] master: restart delay of dead workers', function () {
  it('[WRBO1] a one-off death is replaced at once; early deaths in a row double the delay up to the cap', function () {
    const backoff = createWorkerRestartBackoff({ baseMs: 1000, maxMs: 30000, stableMs: 60000 });
    const delays = [];
    for (let i = 0; i < 8; i++) delays.push(backoff.onWorkerExit('api', 2000));
    assert.deepEqual(delays, [0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('[WRBO2] a worker that stayed up resets the delay of its kind; kinds are counted apart', function () {
    const backoff = createWorkerRestartBackoff({ baseMs: 1000, maxMs: 30000, stableMs: 60000 });
    assert.equal(backoff.onWorkerExit('hfs', 500), 0);
    assert.equal(backoff.onWorkerExit('hfs', 500), 1000);
    assert.equal(backoff.onWorkerExit('hfs', 500), 2000);
    // another kind starts from scratch
    assert.equal(backoff.onWorkerExit('previews', 500), 0);
    // a long-lived hfs worker: replaced at once, the count starts over
    assert.equal(backoff.onWorkerExit('hfs', 61000), 0);
    assert.equal(backoff.onWorkerExit('hfs', 500), 1000);
  });

  it('[WRBO3] the delay stays finite and capped for long runs', function () {
    assert.equal(restartDelayMs(0), 0);
    assert.equal(restartDelayMs(1), 1000);
    assert.equal(restartDelayMs(1000), 30000);
  });

  it('[WRBO4] bin/master.js forks a replacement through the backoff', function () {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../../bin/master.js'), 'utf8');
    assert.match(source, /restartBackoff\.onWorkerExit\(/);
    assert.match(source, /setTimeout\(\(\) => \{\s*if \(masterShutdown\.isShuttingDown\(\)\) return;/);
  });
});
