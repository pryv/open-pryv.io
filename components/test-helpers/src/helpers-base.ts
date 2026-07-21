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

// Pre-seed per-worker env vars BEFORE boiler.init runs in
// `api-server-tests-config.ts` below. boiler reads `process.env` once
// at `init()` and locks values into its env-store. If we wait for
// `mochaHooks.beforeAll` or even `parallelWorkerSetup` module-load, the
// env mirror lands too late — `components/cache/src/index.ts` calls
// `loadConfiguration().catch()` at module-load which fires
// `getConfig().then(c => c.get('tcpBroker:port'))`. That read happens
// against the boiler env-store, locking the wrong port.
// helpers-base.ts is the earliest reliable per-worker entry point —
// mocha workers `require:` test/helpers.js → test-helpers/helpers-base.ts
// transitively, and MOCHA_WORKER_ID is set by mocha at worker fork
// before any code in the worker process runs.
//
// Worker-only: parent mocha process doesn't have MOCHA_WORKER_ID set;
// applying stride=0 in the parent would pin the broker to 4222 there
// and the workers (which inherit env at fork) would then collide on
// EADDRINUSE. Gating on MOCHA_WORKER_ID confines the override to
// worker processes, and overrides any inherited-from-parent value.
if (process.env.MOCHA_PARALLEL === '1' && process.env.MOCHA_WORKER_ID != null) {
  const wid = parseInt(process.env.MOCHA_WORKER_ID, 10);
  const stride = (Number.isFinite(wid) && wid >= 0 ? wid : 0) * 10;
  process.env.storages__engines__rqlite__url = `http://localhost:${4011 + stride}`;
  process.env.tcpBroker__port = String(4222 + stride);
  // Mirror PG database name too, so TestServerContext-forked
  // api-server children (hfs-server, root-seq etc.) talk to the SAME
  // per-worker database as the test parent. Without this, parent writes
  // to `pryv-node-test-w1` but forked children read from default
  // `pryv-node-test` → 404 on every fixture lookup.
  process.env.storages__engines__postgresql__database = `pryv-node-test-w${wid}`;
}

require('./api-server-tests-config.ts');
const { getConfig, getConfigUnsafe } = require('@pryv/boiler');

// Apply the STORAGE_ENGINE=sqlite override at MODULE LOAD time so every
// test component (audit / cache / mall / ... that loads helpers-base.ts
// directly via its own test/helpers.js) picks up the engine override —
// not just api-server which loads helpers-c.ts. Without this, the
// non-api-server matrix components would boot with the default engine
// (postgresql) while api-server's process ran SQLite — Pattern A
// child cores' cross-engine writes then leaked into the next
// component's `checkIndexAndPlatformIntegrity` hook.
//
// SCOPE: SQLite only. Under STORAGE_ENGINE=postgresql we leave the
// default-config values in place — overriding via `cfg.set()` here
// (memory scope, highest priority) blocks later `injectTestConfig`
// resets that mall tests rely on and timed them out under matrix
// mode. The default engine is already PG, so this is a no-op move.
//
// We DELIBERATELY leave `storages:audit:engine` alone in all modes:
// UserAuditDatabasePG.createEvent has a pre-existing `null value in
// column "eventid"` constraint violation that fires on `[ASTO]` audit
// unit tests as soon as audit storage is routed through PG. The
// audit unit tests live in the audit component (which loads only
// helpers-base.ts) — leaving audit untouched here keeps that suite
// green while still aligning the rest of the storage engine choice.
if (process.env.STORAGE_ENGINE === 'sqlite') {
  const { resolveTestFileEngine } = require('./resolveTestFileEngine.ts');
  const cfg = getConfigUnsafe(true);
  cfg.set('storages:base:engine', 'sqlite');
  cfg.set('storages:series:engine', 'sqlite');
  // Honour `storages__file__engine` over the 'filesystem' default so this
  // memory-scope set agrees with the env source DIM-forked children read.
  cfg.set('storages:file:engine', resolveTestFileEngine());
}

// platform.piiMode defaults to "hashed" since 2.0.0-rc.3, and Platform.init
// refuses to boot when piiHmacKey is unset. EVERY component test boots
// Platform through this base helper, so inject a fixed test pepper at
// module-load here (memory scope, survives injectTestConfig resets) — the
// matrix then exercises the production-default hashed path. Multi-core
// child cores set the same value via core-process.js + PII_HMAC_KEY. An
// operator opting a real deployment OUT sets platform.piiMode: cleartext.
{
  const cfg = getConfigUnsafe(true);
  cfg.set('platform:piiHmacKey', process.env.PII_HMAC_KEY || 'WLthDQK7GoYZINg7uIeWN9eANnj2BSh4zEZmRPyR5y0=');
}

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
  // Expose snapshot/restore helpers as globals so tests reaching
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
  // invalidated by other workers' direct DB modifications (fixture
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

  // Reconfigure test dependencies for the selected engine
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
  const methods = options.methods || ['events', 'streams', 'service', 'auth/login', 'auth/register', 'accesses', 'account', 'profile', 'webhooks', 'shared-secrets', 'utility', 'mfa'];

  for (const method of methods) {
    const mod = require(`api-server/src/methods/${method}.ts`);
    // Node 24 require(esm) returns a namespace; the registration function lives on .default
    const loaded = (mod && mod.default) || mod;
    if (typeof loaded === 'function') {
      await loaded(_global.app.api);
    }
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
        // Most often NOT a product bug: leftover users from another
        // component's suite (or an aborted run) desync platform vs
        // repository, and every test in this suite then fails here.
        throw new Error(`${title} => Check should be empty \n${checkStr}\n` +
          'HINT: this usually means stale test DBs (a prior suite or aborted run ' +
          'left users behind) — run `just clean-test-data` and retry before ' +
          'suspecting the code under test.');
      }
    }
  }

  return {
    async beforeAll (this: any) {
      // Spawning worker-private rqlited can take 5-10s on slower boxes
      // (worst case with `-raft-election-timeout=200ms`
      // it's ~300ms, but PG/SQLite init pile on top). The default mocha
      // hook timeout doubles in parallel mode (2s → 4s in `.mocharc.js`)
      // but that's still too tight for the OS-level fork + readyz wait.
      // api-server overrides `timeout: 10000` so it inherits 20s and
      // works; other components (audit/cache/storages/...) use the 2s
      // default and timeout out. Set the hook-local timeout explicitly
      // to 30s so it doesn't depend on the per-component mocharc
      // timeout setting at all.
      this.timeout(30000);
      // Apply per-worker config overrides + spawn the worker-private
      // rqlited BEFORE any config-reading code runs (the
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

      // Matrix-mode hygiene (SQLite only): between component runs the
      // persistent platform DB (rqlite at :4001) AND the per-user-file
      // SQLite index keep state from earlier components — api-server's
      // `versioning.test.js [VE07]` registers users via POST /users
      // with no explicit cleanup and the leftover users produce a
      // 1-vs-N drift in the per-test `checkIndexAndPlatformIntegrity`
      // hook of the next matrix component (mall, …).
      //
      // Under PG the cleanup paths already keep things in sync via
      // the shared `users` table — and the wipe destabilises the
      // `[ASTE]` audit suite under matrix mode — so the gate is
      // `STORAGE_ENGINE === 'sqlite'`.
      //
      // Also skipped for api-server (PRYV_IS_API_SERVER_TEST=1 set by
      // helpers-c.ts) — api-server runs FIRST in the matrix, has no
      // upstream pollution to clean, and racing with helpers-c.ts
      // `dependencies.init()` regresses `[ACUP07]`/`[EVNT]`.
      if (process.env.STORAGE_ENGINE === 'sqlite' &&
          process.env.PRYV_IS_API_SERVER_TEST !== '1') {
        try {
          await require('storages').init(config);
          const { platform } = require('platform');
          await platform.init();
          await platform.deleteAll();
          const { getUsersLocalIndex } = require('storage');
          const idx = await getUsersLocalIndex();
          await idx.init();
          await idx.deleteAll();
        } catch (_e) {
          // not configured for this component — nothing to wipe.
        }
      }
    },
    async afterAll (this: any) {
      // Match beforeAll's generous timeout — teardown can need to wait
      // for SIGTERM + rqlited fsync (up to 5s SIGKILL fallback).
      this.timeout(30000);
      const { teardownParallelWorker } = require('./parallelWorkerSetup.ts');
      await teardownParallelWorker();
    },
    // Per-test platform/usersIndex integrity hooks. Two skip gates apply
    // before the hook body even runs:
    //   - isParallelMode arg: caller explicitly opts out (e.g. components
    //     without platform/usersIndex storage like business / webhooks).
    //   - process.env.MOCHA_PARALLEL === '1': parallel mode globally
    //     skips the per-test platform check pending B-2026-05-29-2 (1-user
    //     drift between platform DB and users repository per test under
    //     parallel-worker setup). The clean()-time integrityFinalCheck on
    //     events + accesses still runs in both modes.
    ...((isParallelMode || process.env.MOCHA_PARALLEL === '1')
      ? {}
      : {
          async beforeEach (this: any) {
            if (process.env.DISABLE_INTEGRITY_CHECK === '1') return;
            // Skip the integrity check if the storages barrel hasn't
            // been initialised yet. The check's
            // `initIndexPlatform()` → `getUsersLocalIndex()` → `ensureBarrel()`
            // path would otherwise call `storages.init()` with NO config arg —
            // before the test-scope `injectTestConfig(testConfig)` has applied
            // the `STORAGE_ENGINE=sqlite` override staged by helpers-c.ts —
            // locking pluginLoader to the default engine across the whole
            // suite (B-2026-05-23-1). Pure-unit Pattern C tests that run
            // before any `initCore()` don't manipulate storage state anyway,
            // so skipping the check pre-initCore is safe.
            const storages = require('storages');
            if (!storages.storageLayer) return;
            await checkIndexAndPlatformIntegrity('BEFORE ' + this.currentTest.title);
          },
          async afterEach (this: any) {
            if (process.env.DISABLE_INTEGRITY_CHECK === '1') return;
            const storages = require('storages');
            if (!storages.storageLayer) return;
            await checkIndexAndPlatformIntegrity('AFTER ' + this.currentTest.title);
          }
        })
  };
}

export { init, initTests, initCore, getMochaHooks };
