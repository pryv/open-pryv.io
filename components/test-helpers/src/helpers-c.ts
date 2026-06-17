/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Pattern C test helpers for api-server
 * Loaded by .mocharc.js for node tests
 *
 * Environment variables for test modes:
 * - DISABLE_INTEGRITY_CHECK=1  : per-test opt-out (reg-multicore, default-streams, …)
 * - MOCHA_PARALLEL=1           : Parallel mode (also disables caching, cluster_kv IPC,
 *                                and per-test platform/usersIndex integrity hooks —
 *                                see helpers-base.ts getMochaHooks for the latter).
 * - PATTERN_C_AUDIT=1          : Enable audit functionality
 */

// Signal to helpers-base.ts that this process is an api-server test.
// helpers-base.ts beforeAll uses this to skip the matrix-hygiene wipe
// (api-server runs first in the matrix and has no upstream leftover
// state to clean; the wipe also conflicts with Pattern A
// `dependencies.ts` init that runs in this file's beforeAll).
process.env.PRYV_IS_API_SERVER_TEST = '1';

const base = require('./helpers-base.ts');

// Test mode flags from environment
const disableIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK === '1';
const isParallelMode = process.env.MOCHA_PARALLEL === '1';
const isAuditMode = process.env.PATTERN_C_AUDIT === '1';

// Build test config based on environment
const testConfig: any = {};
// Override storage engines via STORAGE_ENGINE env var (e.g. 'postgresql')
if (process.env.STORAGE_ENGINE) {
  const eng = process.env.STORAGE_ENGINE;
  // Do NOT override `platform.engine` here. rqlite is the only
  // supported platform engine; the PG + Mongo PlatformDB impls are
  // intentionally incomplete (B-2026-05-21-1). Sequential matrices got
  // away with the override because the storages barrel always inits
  // early enough that the default-config value (`rqlite`) wins.
  // Parallel mode's per-worker `beforeAll` setup pushes
  // injectTestConfig BEFORE first barrel init, exposing the latent
  // broken PG/Mongo PlatformDB.
  testConfig.storages = {
    base: { engine: eng },
    series: { engine: eng },
    file: { engine: 'filesystem' },
    audit: { engine: eng === 'postgresql' ? 'postgresql' : 'sqlite' }
  };
  // CRITICAL: apply the engine override at MODULE LOAD time (not at
  // mochaHooks.beforeAll) so test files that capture
  // `helpers.dependencies.settings` at module-load (e.g.
  // `const settings = _.merge(structuredClone(helpers.dependencies.settings),
  // passwordRules.settingsOverride)` inside a describe in account.test.js
  // and login.test.js) see the right engine. By the time mochaHooks
  // runs, those captures are already frozen with whatever
  // `dependencies.settings` returned at file-load time.
  //
  // Use `config.set()` rather than `injectTestConfig(...)` because some
  // tests (reg-multicore restoreSingleCore) call `injectTestConfig({})`
  // mid-suite to wipe the 'test' scope — config.set survives that
  // (memory scope > test scope).
  const { getConfigUnsafe } = require('@pryv/boiler');
  const cfg = getConfigUnsafe(true);
  cfg.set('storages:base:engine', testConfig.storages.base.engine);
  cfg.set('storages:series:engine', testConfig.storages.series.engine);
  cfg.set('storages:audit:engine', testConfig.storages.audit.engine);
  cfg.set('storages:file:engine', testConfig.storages.file.engine);
  // (platform.piiHmacKey is set unconditionally in helpers-base.ts, which
  // this module requires — no need to repeat it here.)
}

if (isAuditMode) {
  testConfig.audit = {
    active: true,
    storage: {
      filter: {
        methods: {
          include: ['all'],
          exclude: []
        }
      }
    }
  };
  testConfig.syslog = {
    filter: {
      methods: {
        exclude: ['all'],
        include: []
      }
    }
  };
}

// Initialize base helpers
base.init({
  testConfig,
  // All API methods for api-server tests
  methods: [
    'events', 'streams', 'service', 'auth/login', 'auth/register',
    'accesses', 'account', 'profile', 'webhooks', 'utility', 'mfa'
  ]
});

// Export mocha hooks. The per-test platform/usersIndex integrity hooks are
// skipped in parallel mode pending the cleanup-asymmetry investigation
// (platform DB vs users repository drift by 1 per test under MOCHA_PARALLEL=1).
// The clean()-time integrityFinalCheck on events + accesses runs in both modes.
const baseHooks = base.getMochaHooks(disableIntegrityCheck || isParallelMode);

// Extend the base beforeAll: after setupParallelWorker has applied the
// per-worker config overrides (per-worker DB names + per-worker rqlite URL),
// initialize the api-server-side `dependencies` lazy proxies. This routes
// pluginLoader and the StorageLayer-backed Sessions/Accesses/etc through the
// per-worker engine wiring BEFORE the first test's Pattern A child-server
// boot pulls them. Fixes the [ACCO]/[SYRO]/[PGTD] cold-start race: when 14
// worker DIM spawns happen concurrently, Pattern A child-servers were
// inheriting the worker-0 engine wiring and timing out on engine init.
//
// CRITICAL: stage the storage-engine override via `config.set()` (highest
// nconf priority — memory scope) BEFORE calling `dependencies.init()`.
// `dependencies.init()` walks through `storage.getStorageLayer()` →
// `ensureBarrel()` → `storages.init()` → `pluginLoader.init(config)` which
// has a one-shot `if (initialized)` guard. Without the engine override in
// scope first, the barrel locks to the default engine (postgresql) for
// the rest of the process lifetime — under `STORAGE_ENGINE=sqlite`, the
// PARENT would talk to PG while the DIM-spawned CHILD (reads engine=sqlite
// from its temp config) talks to SQLite, and every login lookup misses
// across the engine boundary.
//
// We use `config.set()` rather than `injectTestConfig(...)` because some
// tests (e.g. reg-multicore restoreSingleCore) call
// `config.injectTestConfig({})` to wipe the 'test' scope mid-suite —
// `config.set()` survives that (memory scope > test scope).
const mochaHooks = {
  ...baseHooks,
  async beforeAll (this: any) {
    if (typeof baseHooks.beforeAll === 'function') {
      await baseHooks.beforeAll.call(this);
    }
    const { dependencies } = require('./dependencies.ts');
    await dependencies.init();
  }
};
export { mochaHooks };
