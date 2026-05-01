/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Extends the common test support object with server-specific stuff.
 */

process.env.NODE_ENV = 'test';
require('test-helpers/src/api-server-tests-config');

const testHelpers = module.exports = require('test-helpers');

const DynamicInstanceManager = testHelpers.DynamicInstanceManager;
const { getConfigUnsafe } = require('@pryv/boiler');
const path = require('path');

testHelpers.dependencies.settings = getConfigUnsafe(true).get();
testHelpers.dependencies.instanceManager = new DynamicInstanceManager({
  serverFilePath: path.resolve(__dirname, '../../src/server.ts')
});

before(async function () {
  await testHelpers.dependencies.init();
});
