/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
exports = module.exports = {
  request: require('./request'),
  InstanceManager: require('./InstanceManager'),
  DynamicInstanceManager: require('./DynamicInstanceManager'),
  instanceTestSetup: require('./instanceTestSetup'),
  spawner: require('./spawner'),
  child_process: require('./child_process'),
  syncPrimitives: require('./condition_variable'),
  databaseFixture: require('./databaseFixture'),
  portAllocator: require('./portAllocator'),
  parallelTestHelper: require('./parallelTestHelper'),
  systemStreamFilters: require('./systemStreamFilters')
};
// NOTE: Pattern C helpers (helpers-c.js) is NOT exported here due to circular dependency.
// Load it directly via: require('test-helpers/src/helpers-c')
// ---------------------------------------------------------- deprecated helpers
// NOTE Below we define a few helpers as being lazily loaded attributes on the
//  exports object. This is because we don't want to load them each time we load
//  the test helpers. Eventually, we'll write tests in a different style and not
//  need these anymore.

Object.defineProperty(exports, 'attachmentsCheck', {
  get: function () {
    return require('./attachmentsCheck');
  }
});

Object.defineProperty(exports, 'data', {
  get: function () {
    return require('./data');
  }
});

Object.defineProperty(exports, 'dynData', {
  get: function () {
    return require('./dynData');
  }
});

Object.defineProperty(exports, 'dependencies', {
  get: function () {
    return require('./dependencies');
  }
});
