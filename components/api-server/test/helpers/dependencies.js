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

const path = require('path');

const testHelpers = require('test-helpers');
const DynamicInstanceManager = testHelpers.DynamicInstanceManager;
const { getConfigUnsafe } = require('@pryv/boiler');

/**
 * Overrides common test dependencies with server-specific config settings.
 * Uses DynamicInstanceManager for parallel test execution support.
 *
 * The exported `deps` is a reference to test-helpers' singleton dependencies
 * object. Mutations on its properties (settings, instanceManager) propagate
 * to every consumer that reads `helpers.dependencies.X` via the index barrel.
 */
const deps = testHelpers.dependencies;
// Plan 61: lazy deep-clone getter. Two failure modes are closed:
//   1. Shared nconf reference leak (Stage 1, B-2026-05-21-2 root cause):
//      `nconf.get()` returns nested objects that share refs with the live
//      literal stores. `injectTestConfig(...)` later in a test would
//      mutate `deps.settings.storages.platform.engine` through that
//      shared chain. Solution: deep-clone on every access.
//   2. Module-load timing miss (Stage 3 parallel harness): the previous
//      eager snapshot ran at FIRST require — before `mochaHooks.beforeAll`
//      injected per-worker `config.set(...)` overrides for ports, DB
//      names, etc. Captured deps.settings carried default ports across
//      workers → DynamicInstanceManager forked child api-servers all
//      bound port 3000 → `Server failed (code 1)` cascade. Solution: read
//      live config on every access so per-worker overrides surface
//      whenever a test later asks for `helpers.dependencies.settings`.
Object.defineProperty(deps, 'settings', {
  configurable: true,
  enumerable: true,
  get () {
    return JSON.parse(JSON.stringify(getConfigUnsafe(true).get()));
  }
});

deps.instanceManager = new DynamicInstanceManager({
  serverFilePath: path.join(__dirname, '/../../bin/server')
});

export default deps;
