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
// [BARREL-INIT-ORDER] tests fail with ECONNREFUSED 127.0.0.1:4001 in
// parallel mode because the worker's per-worker rqlite is at :401N
// (and the host rqlited at :4001 is killed by the parallel setup
// before tests run).
require('test-helpers/src/api-server-tests-config.ts');

const base = require('test-helpers/src/helpers-base.ts');
base.init({});
export const mochaHooks = base.getMochaHooks(true);
