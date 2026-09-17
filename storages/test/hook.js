/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Ensure boiler is initialized at module load and mochaHooks runs so
// per-worker rqlited gets spawned. Without this, the
// [BARREL-INIT-ORDER] tests in parallel mode would not get their
// worker's own rqlite (at :4011 + N*10) and would share the host one.
require('test-helpers/src/api-server-tests-config.ts');

const base = require('test-helpers/src/helpers-base.ts');
base.init({});
export const mochaHooks = base.getMochaHooks(true);
