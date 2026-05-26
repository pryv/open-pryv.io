/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Helper methods and setup for all unit tests.
const assert = require('node:assert');
const superagent = require('superagent');
const request = require('supertest');
require('test-helpers/src/api-server-tests-config.ts');

// Plan 61: per-worker mocha hook so parallel-mode workers spawn their
// own rqlited + apply per-worker config overrides. Without this,
// `[USRP] Users repository` `before all` hits `fetch failed` trying
// to reach the host rqlite at :4001 (killed in parallel mode), and
// `[WHBK] Webhook` storage writes go to the default DB.
const base = require('test-helpers/src/helpers-base.ts');
base.init({});
export const mochaHooks = base.getMochaHooks(true);

export { assert, superagent, request };
