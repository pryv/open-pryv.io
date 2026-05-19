/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, assert */

/**
 * [CONFIG-RDY] — `ready()` accessor on `@pryv/boiler`.
 *
 * `ready()` is the stronger-contract sibling of `getConfig()`. It
 * resolves once configuration is fully loaded AND has passed any
 * registered boot-time validators (today: `config-validation`
 * plugin's REQUIRED_WHEN check + REPLACE/dollar-curly sentinel walk,
 * which `process.exit(1)`s on problems — so reaching `ready()` is
 * itself the validation pass).
 *
 * On the current codebase this is semantically equivalent to
 * `getConfig()`. These tests pin the contract so future work
 * (Wave 2: async loaders, change notification) can extend the gate
 * without surprising callers.
 *
 * `-seq` because boiler init happens once globally; these tests
 * piggy-back on the api-server init lifecycle.
 */

describe('[CONFIG-RDY] @pryv/boiler ready()', () => {
  let ready, getConfig, getConfigSync;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ ready, getConfig, getConfigSync } = require('@pryv/boiler'));
  });

  it('[RDY-01] is an async function exported from @pryv/boiler', () => {
    assert.strictEqual(typeof ready, 'function');
    // Native async function returns a promise even when invoked
    // without await; the test below resolves it.
    const p = ready();
    assert.ok(p && typeof p.then === 'function', 'ready() must return a thenable');
  });

  it('[RDY-02] resolves to the same singleton as getConfig() / getConfigSync()', async () => {
    const a = await ready();
    const b = await getConfig();
    const c = getConfigSync();
    assert.strictEqual(a, b, 'ready() ↔ getConfig() identity');
    assert.strictEqual(a, c, 'ready() ↔ getConfigSync() identity');
  });

  it('[RDY-03] resolved config has the test-config values', async () => {
    const config = await ready();
    // test-config.yml sets these (config-validation REQUIRED_WHEN would
    // exit-1 the process if either were missing).
    assert.strictEqual(config.get('auth:adminAccessKey'), 'some_key_yo');
    assert.strictEqual(config.get('auth:filesReadTokenSecret'), 'some_token');
  });

  it('[RDY-04] resolved config carries the test-config passwordResetPageURL', async () => {
    // Added to test-config.yml in plan 70 §2A so any test that
    // overrides services.email.enabled to truthy carries a value the
    // REQUIRED_WHEN validator accepts. The URL is a placeholder
    // (test.pryv.local) — its presence not its content is what matters.
    const config = await ready();
    assert.strictEqual(config.get('auth:passwordResetPageURL'), 'http://test.pryv.local/reset-password');
  });

  it('[RDY-05] is idempotent — calling ready() repeatedly returns the same singleton', async () => {
    const a = await ready();
    const b = await ready();
    const c = await ready();
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
  });

  it('[RDY-06] re-reading via .get() after ready() resolves picks up runtime config.set() calls', async () => {
    // Config-set semantics: a value mutated AFTER ready() resolves
    // is reflected in the next .get() call. This is what plan 70 §2C
    // depends on for the lazy-getter sweep — and what plan 61 will
    // depend on for per-worker storage isolation via config.set() at
    // test boot. Pin the contract.
    const config = await ready();
    const key = 'plan-70-ready-test:scratch';
    config.set(key, 'first');
    assert.strictEqual(config.get(key), 'first');
    config.set(key, 'second');
    assert.strictEqual(config.get(key), 'second');
  });
});
