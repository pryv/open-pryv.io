/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Base test helpers for all components
 * Provides common Pattern C test initialization
 */

require('./api-server-tests-config.ts');
const { getConfig } = require('@pryv/boiler');

const storage = require('storage');
const supertest = require('supertest');
const { getApplication } = require('api-server/src/application.ts');
const { databaseFixture } = require('test-helpers');
const { pubsub } = require('messages');
const userLocalDirectory = require('storage').userLocalDirectory;

let initTestsDone = false;
let initCoreDone = false;
let options: any = {};
const _global: any = global as any;

/**
 * Initialize basic test infrastructure
 */
async function initTests () {
  if (initTestsDone) return;
  initTestsDone = true;
  _global.config = await getConfig();
  // Plan 61: expose snapshot/restore helpers as globals so tests reaching
  // `config` as a global also get `withInjectedConfig` /
  // `injectTestConfigSnapshot` without an explicit require.
  const { withInjectedConfig, injectTestConfigSnapshot } = require('./withInjectedConfig.ts');
  _global.withInjectedConfig = withInjectedConfig;
  _global.injectTestConfigSnapshot = injectTestConfigSnapshot;
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
  _global.config.injectTestConfig(testConfig);

  // Hook before app initialization
  if (options.beforeInitCore) {
    await options.beforeInitCore();
  }

  await require('storages').init(_global.config);
  _global.app = getApplication();
  await _global.app.initiate();

  // Get StorageLayer (now initialized by app) for engine-agnostic fixtures
  const storageLayer = await storage.getStorageLayer();

  // Reconfigure test dependencies for non-MongoDB engines
  const dependencies = require('./dependencies.ts');
  await dependencies.init();

  _global.getNewFixture = function () {
    const fixture = databaseFixture(storageLayer);
    // Add profile helper — uses StorageLayer.profile (engine-agnostic)
    fixture.context.profile = async (username: any, profileData: any) => {
      const user = { id: username };
      await new Promise<void>((resolve) => {
        storageLayer.profile.removeOne(user, { id: profileData.id }, () => resolve());
      });
      await new Promise((resolve, reject) => {
        storageLayer.profile.insertOne(user, { id: profileData.id, data: profileData.data }, (err: any, result: any) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    };
    return fixture;
  };

  // Initialize notifications
  _global.testMsgs = [];
  const testNotifier = {
    emit: (...args: any[]) => _global.testMsgs.push(args)
  };
  pubsub.setTestNotifier(testNotifier);
  pubsub.status.emit(pubsub.SERVER_READY);

  // Notification tracking helpers
  _global.notifications = {
    reset: () => { _global.testMsgs = []; },
    count: (type: any, username: any) => {
      return _global.testMsgs.filter((msg: any) =>
        msg[0] === type && (username == null || msg[1] === username)
      ).length;
    },
    eventsChanged: (username: any) => _global.notifications.count('test-events-changed', username),
    streamsChanged: (username: any) => _global.notifications.count('test-streams-changed', username),
    accountChanged: (username: any) => _global.notifications.count('test-account-changed', username),
    accessesChanged: (username: any) => _global.notifications.count('test-accesses-changed', username),
    all: () => _global.testMsgs
  };

  // Load API methods based on options
  const methods = options.methods || ['events', 'streams', 'service', 'auth/login', 'auth/register', 'accesses', 'account', 'profile', 'webhooks', 'utility', 'mfa'];

  for (const method of methods) {
    const mod = require(`api-server/src/methods/${method}.ts`);
    // Node 24 require(esm) returns a namespace; the registration function lives on .default
    const loaded = (mod && mod.default) || mod;
    if (typeof loaded === 'function') {
      await loaded(_global.app.api);
    }
  }

  // Load audit if config says so
  if (_global.config.get('audit:active')) {
    await require('audit/src/methods/audit-logs.ts').default(_global.app.api);
  }

  _global.coreRequest = supertest(_global.app.expressApp);

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

  let usersIndex: any, platform: any;

  async function initIndexPlatform () {
    if (usersIndex != null) return;
    const { getUsersLocalIndex } = require('storage');
    usersIndex = await getUsersLocalIndex();
    platform = require('platform').platform;
    await platform.init();
  }

  async function checkIndexAndPlatformIntegrity (title: any) {
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
      // Plan 61 Stage 3 — apply per-worker config overrides + spawn the
      // worker-private rqlited BEFORE any config-reading code runs (the
      // previewsDirPath lookup below, storages.init() in initCore, …).
      // No-op in non-parallel mode (host rqlited at 4001 serves the
      // sequential matrix unchanged).
      const { setupParallelWorker } = require('./parallelWorkerSetup.ts');
      await setupParallelWorker();

      const config = await getConfig();
      const previewsDirPath = config.get('storages:engines:filesystem:previewsDirPath');
      if (!fs.existsSync(previewsDirPath)) {
        fs.mkdirSync(previewsDirPath, { recursive: true });
      }
      // Static event fixtures (test-helpers/data/events.ts) defer their
      // integrity attachment until post-init (8a-ii). Trigger that here,
      // after `await getConfig()`, so any test consumer that reads
      // `testData.events` directly (rather than going through
      // `resetEvents`) still sees integrity-ready events.
      const { ensureIntegrity: ensureEventsIntegrity } = require('./data/events.ts');
      ensureEventsIntegrity();
    },
    async afterAll () {
      const { teardownParallelWorker } = require('./parallelWorkerSetup.ts');
      await teardownParallelWorker();
    },
    // Integrity checks disabled in parallel mode (no transport between workers).
    ...(isParallelMode
      ? {}
      : {
          async beforeEach (this: any) {
            if (process.env.DISABLE_INTEGRITY_CHECK === '1') return;
            await checkIndexAndPlatformIntegrity('BEFORE ' + this.currentTest.title);
          },
          async afterEach (this: any) {
            if (process.env.DISABLE_INTEGRITY_CHECK === '1') return;
            await checkIndexAndPlatformIntegrity('AFTER ' + this.currentTest.title);
          }
        })
  };
}

export { init, initTests, initCore, getMochaHooks };
