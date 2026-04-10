/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Base Mocha configuration for all components
 *
 * Environment variables:
 * - MOCHA_PARALLEL=1: Enable parallel test execution
 * - MOCHA_NON_PARALLEL=1: Run only tests excluded from parallel mode
 *
 * Usage in component .mocharc.js:
 *   const { createConfig } = require('../../.mocharc.js');
 *   module.exports = createConfig({
 *     require: 'test/helpers.js',  // optional
 *     timeout: 5000,               // optional override
 *     nonParallelTests: [...]      // optional exclusion list
 *   });
 */

const isParallel = process.env.MOCHA_PARALLEL === '1';
const isNonParallelOnly = process.env.MOCHA_NON_PARALLEL === '1';

// Base configuration
const baseConfig = {
  exit: true,
  slow: 75,
  timeout: 2000,
  ui: 'bdd',
  diff: true,
  reporter: 'dot',
  spec: 'test/**/*.test.js'
};

/**
 * Create a mocha config for a component
 * @param {Object} options - Configuration options
 * @param {string} [options.require] - Module to require before tests
 * @param {number} [options.timeout] - Test timeout in ms
 * @param {number} [options.slow] - Slow test threshold in ms
 * @param {string[]} [options.nonParallelTests] - Tests to exclude from parallel mode
 * @param {number} [options.parallelJobs] - Number of parallel jobs (default: 2)
 * @returns {Object} Mocha configuration
 */
function createConfig (options = {}) {
  const {
    require: requireModule,
    timeout = baseConfig.timeout,
    slow = baseConfig.slow,
    nonParallelTests = [],
    parallelJobs = 2
  } = options;

  const config = {
    ...baseConfig,
    slow,
    timeout: isParallel ? timeout * 2 : timeout
  };

  if (requireModule) {
    config.require = requireModule;
  }

  if (isNonParallelOnly && nonParallelTests.length > 0) {
    // Run only the non-parallel tests
    config.spec = nonParallelTests;
  } else if (isParallel) {
    config.parallel = true;
    config.jobs = parallelJobs;
    if (nonParallelTests.length > 0) {
      config.ignore = nonParallelTests;
    }
  }

  return config;
}

// Export both the base config (for direct use) and the factory function
module.exports = baseConfig;
module.exports.createConfig = createConfig;
module.exports.isParallel = isParallel;
module.exports.isNonParallelOnly = isNonParallelOnly;
