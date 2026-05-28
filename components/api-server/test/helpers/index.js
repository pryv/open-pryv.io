/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Extends the common test support object with server-specific stuff.
 *
 * Uses ESM named re-exports rather than the CJS spread-mutation pattern:
 *
 *   exports = module.exports = { ...require('test-helpers') };
 *   exports.commonTests = require('./commonTests');
 *   ...
 *
 * doesn't work under ESM (consumer namespace is read-only). All the
 * sub-modules (commonTests, dependencies, validation, SourceStream,
 * passwordRules) are now ESM and explicitly re-exported here. test-helpers
 * fields are also explicitly re-exported (only the ones consumers actually
 * use — anything not on the list can be added when the consumer surfaces).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const tested = require('test-helpers');

// Sub-modules — names are explicitly re-exported so consumers can do
// `helpers.X` (legacy spread-style) or `require('./helpers/X')` (direct).
const commonTests = require('./commonTests');
const dependencies = require('./dependencies').default;
const validation = require('./validation');
const SourceStream = require('./SourceStream').default;
const passwordRules = require('./passwordRules');

// Re-exports from test-helpers — explicitly named so the helpers namespace
// continues to expose them as direct properties.
const data = tested.data;
const dynData = tested.dynData;
const request = tested.request;
const databaseFixture = tested.databaseFixture;
const InstanceManager = tested.InstanceManager;
const DynamicInstanceManager = tested.DynamicInstanceManager;
const instanceTestSetup = tested.instanceTestSetup;
const spawner = tested.spawner;
const child_process = tested.child_process; // eslint-disable-line camelcase
const syncPrimitives = tested.syncPrimitives;
const portAllocator = tested.portAllocator;
const parallelTestHelper = tested.parallelTestHelper;
const systemStreamFilters = tested.systemStreamFilters;
const attachmentsCheck = tested.attachmentsCheck;

export {
  commonTests,
  dependencies,
  validation,
  SourceStream,
  passwordRules,
  data,
  dynData,
  request,
  databaseFixture,
  InstanceManager,
  DynamicInstanceManager,
  instanceTestSetup,
  spawner,
  child_process, // eslint-disable-line camelcase
  syncPrimitives,
  portAllocator,
  parallelTestHelper,
  systemStreamFilters,
  attachmentsCheck
};
