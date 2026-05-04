/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";


/**
 * Base test helpers for all components
 * Provides common Pattern C test initialization
 *
 * Usage in component helpers:
 *   const base = require('test-helpers/src/helpers-base');
 *   base.init({
 *     methods: ['events', 'streams', 'accesses'],  // API methods to load
 *     globals: { myModule: require('my-module') }, // Additional globals
 *     beforeInitCore: async () => { ... },         // Hook before initCore
 *     afterInitCore: async () => { ... }           // Hook after initCore
 *   });
 */

require('./api-server-tests-config');
const { getConfig } = require('@pryv/boiler');

const storage = require('storage');
const supertest = require('supertest');
const { getApplication } = require('api-server/src/application');
const { databaseFixture } = require('test-helpers');
const { pubsub } = require('messages');
const userLocalDirectory = require('storage').userLocalDirectory;

let initTestsDone = false;
let initCoreDone = false;
let options: any = {};

/**
 * Initialize basic test infrastructure
 */
async function initTests () {
  if (initTestsDone) return;
  initTestsDone = true;
  global.config = await getConfig();
  await userLocalDirectory.init();

  if (options.beforeInitTests) {
    await options.beforeInitTests();
  }
}

/**
 * Initialize core API server with specified methods
 */
async function initCore () {
  if (initCoreDone) return;
  initCoreDone = true;

  // Build config
  // Parallel mode: each worker has its own in-memory cache that cannot be
  // invalidated by other workers' direct MongoDB modifications (fixture
  // inserts/deletes). Without transport, cache entries become stale and cause
  // spurious 403/404 errors. Only disable caching when truly parallel.
  const isParallelMode = process.env.MOCHA_PARALLEL === '1';
  const testConfig = {
    dnsLess: { isActive: true },
    ...(isParallelMode ? { caching: { isActive: false } } : {}),
    ...options.testConfig
  };
  global.config.injectTestConfig(testConfig);

  // Hook before app initialization
  if (options.beforeInitCore) {
    await options.beforeInitCore();
  }

  await require('storages').init(global.config);
  global.app = getApplication();
  await global.app.initiate();

  // Get StorageLayer (now initialized by app) for engine-agnostic fixtures
  const storageLayer = await storage.getStorageLayer();

  // Reconfigure test dependencies for non-MongoDB engines
  const dependencies = require('./dependencies');
  await dependencies.init();

  global.getNewFixture = function () {
    const fixture = databaseFixture(storageLayer);
    // Add profile helper — uses StorageLayer.profile (engine-agnostic)
    fixture.context.profile = async (username, profileData) => {
      const user = { id: username };
      await new Promise<void>((resolve) => {
        storageLayer.profile.removeOne(user, { id: profileData.id }, () => resolve());
      });
      await new Promise((resolve, reject) => {
        storageLayer.profile.insertOne(user, { id: profileData.id, data: profileData.data }, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    };
    return fixture;
  };

  // Initialize notifications
  global.testMsgs = [];
  const testNotifier = {
    emit: (...args) => global.testMsgs.push(args)
  };
  pubsub.setTestNotifier(testNotifier);
  pubsub.status.emit(pubsub.SERVER_READY);

  // Notification tracking helpers
  global.notifications = {
    reset: () => { global.testMsgs = []; },
    count: (type, username) => {
      return global.testMsgs.filter(msg =>
        msg[0] === type && (username == null || msg[1] === username)
      ).length;
    },
    eventsChanged: (username) => global.notifications.count('test-events-changed', username),
    streamsChanged: (username) => global.notifications.count('test-streams-changed', username),
    accountChanged: (username) => global.notifications.count('test-account-changed', username),
    accessesChanged: (username) => global.notifications.count('test-accesses-changed', username),
    all: () => global.testMsgs
  };

  // Load API methods based on options
  const methods = options.methods || ['events', 'streams', 'service', 'auth/login', 'auth/register', 'accesses', 'account', 'profile', 'webhooks', 'utility', 'mfa'];

  for (const method of methods) {
    const loaded = require(`api-server/src/methods/${method}`);
    if (typeof loaded === 'function') {
      await loaded(global.app.api);
    }
  }

  // Load audit if config says so
  if (global.config.get('audit:active')) {
    await require('audit/src/methods/audit-logs')(global.app.api);
  }

  global.coreRequest = supertest(global.app.expressApp);

  // Hook after initialization
  if (options.afterInitCore) {
    await options.afterInitCore();
  }
}

/**
 * Initialize the base helpers with options
 */
function init (opts: any = {}) {
  options = opts;

  // Base globals
  const baseGlobals = {
    initCore,
    initTests,
    assert: require('node:assert'),
    cuid: require('cuid'),
    charlatan: require('charlatan'),
    sinon: require('sinon'),
    path: require('path'),
    _: require('lodash')
  };

  // Merge with component-specific globals
  Object.assign(global, baseGlobals, opts.globals || {});
}

/**
 * Get mocha hooks for integrity checks
 */
function getMochaHooks (isParallelMode = false) {
  const fs = require('fs');
  const util = require('util');

  let usersIndex, platform;

  async function initIndexPlatform () {
    if (usersIndex != null) return;
    const { getUsersLocalIndex } = require('storage');
    usersIndex = await getUsersLocalIndex();
    platform = require('platform').platform;
    await platform.init();
  }

  async function checkIndexAndPlatformIntegrity (title) {
    await initIndexPlatform();
    const checks = [
      await platform.checkIntegrity(),
      await usersIndex.checkIntegrity()
    ];
    for (const check of checks) {
      if (check.errors.length > 0) {
        const checkStr = util.inspect(checks, false, null, true);
        throw new Error(`${title} => Check should be empty \n${checkStr}`);
      }
    }
  }

  return {
    async beforeAll () {
      const config = await getConfig();
      const previewsDirPath = config.get('storages:engines:filesystem:previewsDirPath');
      if (!fs.existsSync(previewsDirPath)) {
        fs.mkdirSync(previewsDirPath, { recursive: true });
      }
    },
    // Integrity checks disabled in parallel mode (no transport between workers).
    ...(isParallelMode
      ? {}
      : {
          async beforeEach () {
            if (process.env.DISABLE_INTEGRITY_CHECK === '1') return;
            await checkIndexAndPlatformIntegrity('BEFORE ' + this.currentTest.title);
          },
          async afterEach () {
            if (process.env.DISABLE_INTEGRITY_CHECK === '1') return;
            await checkIndexAndPlatformIntegrity('AFTER ' + this.currentTest.title);
          }
        })
  };
}

module.exports = {
  init,
  initTests,
  initCore,
  getMochaHooks
};
