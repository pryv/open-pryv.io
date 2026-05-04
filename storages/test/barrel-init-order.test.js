/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [BARREL-INIT-ORDER] — Plan 57 Phase 5a pre-flight characterization test.
 *
 * Pins the CURRENT (CommonJS) behavior of `require('storages')` getter access
 * before `init()` has run. Today the barrel uses lazy getters that return
 * `undefined` for uninitialized fields. After Phase 5 (ESM + top-level await
 * in the barrel), this contract changes — top-level await means consumers
 * that import the barrel implicitly wait for initialization.
 *
 * Without this test pinning the current contract, an ESM regression that
 * silently changes pre-init access from "returns undefined" to "throws"
 * (or vice versa) would land on `feat/ts-esm` undetected. The test also
 * documents the existing semantics for future readers: the only safe access
 * pattern today is `await storages.init(config); storages.platformDB`.
 *
 * Lifecycle: this test resets the barrel before each case so it can
 * exercise the pre-init state. Other tests in the suite assume init has
 * already run (via `before(async () => await storages.init())` hooks),
 * so we explicitly reset + restore here.
 */

require('test-helpers/src/api-server-tests-config');

const assert = require('node:assert');

// `database` + `databasePG` are intentionally excluded from the strict
// "pre-init returns undefined" pin — the barrel exposes `_earlyDatabase` /
// `_earlyDatabasePG` getters that may hold a constructed connection from a
// prior init() that's been reset() but not GC'd. Their post-reset value is
// `null` (not undefined), and they're not part of the public consumer
// contract that ESM top-level await would change.
const FIELDS_THAT_DEPEND_ON_INIT = [
  'connection',
  'storageLayer',
  'userAccountStorage',
  'usersLocalIndex',
  'platformDB',
  'auditStorage',
  'seriesConnection',
  'dataStoreModule'
];

describe('[BARREL-INIT-ORDER] storages barrel — init lifecycle pins (CJS)', () => {
  let storages;

  before(() => {
    storages = require('storages');
  });

  beforeEach(() => {
    // Reset to pre-init state for each case. Idempotent + side-effect-free
    // (closes any held audit storage, clears engine plugin registry).
    storages.reset();
  });

  after(async () => {
    // Restore the post-init state the rest of the test suite expects so
    // we don't poison subsequent tests in the same mocha run.
    await storages.init();
  });

  it('[BIO-PRE-1] pre-init: every late-bound getter returns undefined (does not throw)', () => {
    for (const field of FIELDS_THAT_DEPEND_ON_INIT) {
      assert.strictEqual(
        storages[field], undefined,
        `pre-init storages.${field} expected undefined, got ${typeof storages[field]}`
      );
    }
  });

  it('[BIO-PRE-2] pre-init: pluginLoader is exposed (it does not depend on init)', () => {
    assert.ok(storages.pluginLoader, 'pluginLoader should be exposed before init');
    assert.strictEqual(typeof storages.pluginLoader.init, 'function');
  });

  it('[BIO-INIT] init() resolves and post-init getters return non-undefined', async () => {
    await storages.init();
    // At least platformDB must always be present (rqlite is always running).
    assert.ok(storages.platformDB, 'platformDB should be defined post-init');
    assert.ok(storages.storageLayer, 'storageLayer should be defined post-init');
  });

  it('[BIO-IDEMPOTENT] double init() is a no-op (returns without re-initializing)', async () => {
    await storages.init();
    const firstPlatformDB = storages.platformDB;
    await storages.init();
    assert.strictEqual(
      storages.platformDB, firstPlatformDB,
      'second init() must not replace the platformDB instance'
    );
  });

  it('[BIO-RESET] reset() returns to pre-init state', async () => {
    await storages.init();
    assert.ok(storages.platformDB, 'sanity: post-init platformDB defined');
    storages.reset();
    for (const field of FIELDS_THAT_DEPEND_ON_INIT) {
      assert.strictEqual(
        storages[field], undefined,
        `post-reset storages.${field} expected undefined`
      );
    }
  });
});
