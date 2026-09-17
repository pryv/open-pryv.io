/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Boiler MUST be initialized at module load before any transitive
// ESM import of `business/src/integrity/integrity.ts` (which calls
// `getConfigUnsafe(true)` at module top-level). In sequential mode,
// storage/test/global.test.js loads `api-server-tests-config.ts`
// first (which inits boiler), and subsequent files
// (storage/test/unit/*.test.js) inherit that init. In parallel mode,
// mocha-parallel can assign files to different workers —
// `unit/userAccountStorage.test.js` loaded in a worker that never
// touched `global.test.js` crashes at integrity.ts import.
require('test-helpers/src/api-server-tests-config.ts');

// Export mochaHooks so per-worker rqlited spawns via
// `setupParallelWorker`. Without this storage tests run in parallel
// mode against the shared host rqlited instead of the worker's own
// (worker ports start at 4011), so concurrent workers race on one
// platform DB.
const base = require('test-helpers/src/helpers-base.ts');
base.init({});
export const mochaHooks = base.getMochaHooks(true);

Object.assign(global, {
  assert: require('node:assert'),
  bluebird: require('bluebird'),
  _: require('lodash')
});
