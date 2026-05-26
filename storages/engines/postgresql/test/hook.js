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

// Plan 61 Stage 5 (post-`faed485` follow-up): seed `helpers.state.config`
// here so every parallel-mode worker that picks up a sibling file
// (`audit-conformance.test.js` [PGAC], `schema.test.js` [PGSC],
// `series.test.js`) gets a usable config. Sequential mode used to rely
// on `global.test.js` running first in the same process, but
// mocha-parallel dispatches files to separate workers — workers that
// never load `global.test.js` see `state.config == null` and crash at
// `new DatabasePG(undefined)` with `Cannot read properties of null
// (reading 'host')`.
const helpers = require('../../../test/helpers');
if (helpers.state.config == null) {
  helpers.state.config = helpers.getEngineConfig('postgresql', require('../manifest.json'));
}
