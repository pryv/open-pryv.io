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
// Plan 61: deep-clone the config snapshot so later test-scope mutations
// can't leak into spawned-child temp configs via shared nconf object
// references. Previously: `deps.settings = getConfigUnsafe(true).get()`
// returned a tree that shared nested references with nconf's literal
// stores, so `injectTestConfig({storages: {platform: {engine: 'mongodb'}}})`
// later in a test could mutate `deps.settings.storages.platform.engine`
// — exposing a latent typo in Mongo's createPlatformDB (B-2026-05-21-2).
deps.settings = JSON.parse(JSON.stringify(getConfigUnsafe(true).get()));

deps.instanceManager = new DynamicInstanceManager({
  serverFilePath: path.join(__dirname, '/../../bin/server')
});

export default deps;
