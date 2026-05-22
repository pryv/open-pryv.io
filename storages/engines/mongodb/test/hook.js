/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
Object.assign(global, {
  assert: require('node:assert'),
  bluebird: require('bluebird'),
  _: require('lodash')
});

// Plan 61 Stage 3 — wire the per-worker rqlited harness into this engine
// suite too. No-op when MOCHA_PARALLEL is unset so sequential matrices
// keep talking to the host rqlited on 4001/4002.
export const mochaHooks = {
  async beforeAll () {
    const { setupParallelWorker } = require('test-helpers/src/parallelWorkerSetup.ts');
    await setupParallelWorker();
  },
  async afterAll () {
    const { teardownParallelWorker } = require('test-helpers/src/parallelWorkerSetup.ts');
    await teardownParallelWorker();
  }
};
