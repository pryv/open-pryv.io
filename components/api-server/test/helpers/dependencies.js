/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const path = require('path');

const testHelpers = require('test-helpers');
const DynamicInstanceManager = testHelpers.DynamicInstanceManager;
const { getConfigUnsafe } = require('@pryv/boiler');

/**
 * Overrides common test dependencies with server-specific config settings.
 * Uses DynamicInstanceManager for parallel test execution support.
 */
const deps = module.exports = testHelpers.dependencies;
deps.settings = getConfigUnsafe(true).get();
deps.instanceManager = new DynamicInstanceManager({
  serverFilePath: path.join(__dirname, '/../../bin/server')
});
