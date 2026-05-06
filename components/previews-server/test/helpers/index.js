/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Extends the common test support object with server-specific stuff.
 *
 * Plan 57 5g.4 — converted from CJS spread-mutation pattern to ESM
 * named re-exports. The previous `module.exports = { ...require('test-helpers') }`
 * + property assignments doesn't work under ESM (consumer namespace is
 * read-only). The mutations on `dependencies` properties still propagate
 * because `dependencies` is a singleton object reference shared with
 * test-helpers — modifying its properties is independent of how the
 * top-level binding is exported.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV = 'test';
require('test-helpers/src/api-server-tests-config');

const tested = require('test-helpers');
const { getConfigUnsafe } = require('@pryv/boiler');
const path = require('path');

const dependencies = tested.dependencies;
const data = tested.data;
const request = tested.request;
const DynamicInstanceManager = tested.DynamicInstanceManager;

dependencies.settings = getConfigUnsafe(true).get();
dependencies.instanceManager = new DynamicInstanceManager({
  serverFilePath: path.resolve(__dirname, '../../src/server.ts')
});

before(async function () {
  await dependencies.init();
});

export { dependencies, data, request, DynamicInstanceManager };
