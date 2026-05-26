/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Parallel-mode mochaHook for the previews-server component (mirrors
// components/webhooks/test/hook.js + components/storage/test/hook.js).
// Without this the worker uses root mocharc defaults — no boiler init,
// no per-worker rqlited spawn — and `before all` fetches fail trying
// to reach the host rqlite at :4001.
require('test-helpers/src/api-server-tests-config.ts');

const base = require('test-helpers/src/helpers-base.ts');
base.init({});
export const mochaHooks = base.getMochaHooks(true);

Object.assign(global, {
  assert: require('node:assert'),
  bluebird: require('bluebird'),
  _: require('lodash')
});
