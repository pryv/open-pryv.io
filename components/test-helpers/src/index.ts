/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const request = require('./request.ts').default;
const DynamicInstanceManager = require('./DynamicInstanceManager.ts').default;
const instanceTestSetup = require('./instanceTestSetup.ts');
const { TestServerContext, TestServer } = require('./TestServerContext.ts');
const child_process = require('./child_process.ts').default;
const syncPrimitives = require('./condition_variable.ts');
const databaseFixture = require('./databaseFixture.ts').default;
const portAllocator = require('./portAllocator.ts');
const parallelTestHelper = require('./parallelTestHelper.ts');
const parallelWorkerSetup = require('./parallelWorkerSetup.ts');
const systemStreamFilters = require('./systemStreamFilters.ts');
const { withInjectedConfig, injectTestConfigSnapshot } = require('./withInjectedConfig.ts');

// Pattern C helpers (helpers-c.ts) is NOT exported here due to circular dependency.
// Load it directly via: require('test-helpers/src/helpers-c.ts')

// Deprecated helpers — eagerly loaded under ESM (Object.defineProperty getters
// don't work on the namespace object, and the loading-cost concern that
// motivated lazy-loading no longer applies under Node 24 module caching).
const attachmentsCheck = require('./attachmentsCheck.ts');
const data = require('./data.ts');
const dynData = require('./dynData.ts').default;
const dependencies = require('./dependencies.ts').default;

export {
  request,
  DynamicInstanceManager,
  instanceTestSetup,
  TestServerContext,
  TestServer,
  child_process,
  syncPrimitives,
  databaseFixture,
  portAllocator,
  parallelTestHelper,
  parallelWorkerSetup,
  systemStreamFilters,
  attachmentsCheck,
  data,
  dynData,
  dependencies,
  withInjectedConfig,
  injectTestConfigSnapshot
};
