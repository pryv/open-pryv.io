/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Plan 61 Stage 5: ensure boiler init + per-worker rqlited spawn for
// storages/engines/postgresql tests in parallel mode. Without this,
// schema/series/PlatformDB conformance tests fetch-fail against
// host rqlited on 4001 (killed by parallel-mode setup).
require('test-helpers/src/api-server-tests-config.ts');

const base = require('test-helpers/src/helpers-base.ts');
base.init({});
export const mochaHooks = base.getMochaHooks(true);

const assert = require('node:assert');
global.assert = assert;
