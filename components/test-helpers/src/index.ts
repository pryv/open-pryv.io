/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const request = require('./request').default;
const InstanceManager = require('./InstanceManager').default;
const DynamicInstanceManager = require('./DynamicInstanceManager').default;
const instanceTestSetup = require('./instanceTestSetup');
const spawner = require('./spawner');
const child_process = require('./child_process').default;
const syncPrimitives = require('./condition_variable');
const databaseFixture = require('./databaseFixture').default;
const portAllocator = require('./portAllocator');
const parallelTestHelper = require('./parallelTestHelper');
const systemStreamFilters = require('./systemStreamFilters');

// Pattern C helpers (helpers-c.ts) is NOT exported here due to circular dependency.
// Load it directly via: require('test-helpers/src/helpers-c')

// Deprecated helpers — eagerly loaded under ESM (Object.defineProperty getters
// don't work on the namespace object, and the loading-cost concern that
// motivated lazy-loading no longer applies under Node 24 module caching).
const attachmentsCheck = require('./attachmentsCheck');
const data = require('./data');
const dynData = require('./dynData').default;
const dependencies = require('./dependencies').default;

export {
  request,
  InstanceManager,
  DynamicInstanceManager,
  instanceTestSetup,
  spawner,
  child_process,
  syncPrimitives,
  databaseFixture,
  portAllocator,
  parallelTestHelper,
  systemStreamFilters,
  attachmentsCheck,
  data,
  dynData,
  dependencies
};
