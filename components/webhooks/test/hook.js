/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Parallel-mode mochaHook for the webhooks component. Mirrors
// components/storage/test/hook.js.
//
// Loading `api-server-tests-config.ts` first ensures boiler is initialized
// at module load, in case mocha-parallel hands a test file to a worker
// that hasn't yet loaded `test/test-helpers.js`. Sequential mode is a
// no-op because test-helpers.js' boiler init is idempotent.
require('test-helpers/src/api-server-tests-config.ts');

// Export mochaHooks so per-worker rqlited spawns via `setupParallelWorker`.
const base = require('test-helpers/src/helpers-base.ts');
base.init({});
export const mochaHooks = base.getMochaHooks(true);

Object.assign(global, {
  assert: require('node:assert'),
  bluebird: require('bluebird'),
  _: require('lodash')
});
