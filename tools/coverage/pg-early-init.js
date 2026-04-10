/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Mocha --require hook for PG coverage runs.
 *
 * Problem: global.test.js before() calls ensureBarrel() → storages.init()
 * BEFORE initCore() can inject PG config via injectTestConfig(). The barrel
 * locks to MongoDB because the default config says storages:base:engine=mongodb.
 *
 * Fix: inject PG config into boiler BEFORE any test runs. When ensureBarrel()
 * later calls storages.init() → getConfig(), it finds storages:base:engine=postgresql.
 *
 * Usage: mocha --require tools/coverage/pg-early-init.js --require test-helpers/src/helpers-c.js
 */

if (process.env.STORAGE_ENGINE === 'postgresql') {
  const { getConfigUnsafe } = require('@pryv/boiler');
  const config = getConfigUnsafe(true);
  if (config) {
    config.injectTestConfig({
      storages: {
        base: { engine: 'postgresql' },
        platform: { engine: 'postgresql' },
        series: { engine: 'postgresql' },
        file: { engine: 'filesystem' },
        audit: { engine: 'postgresql' }
      }
    });
  }
}
