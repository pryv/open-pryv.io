/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const storage = require('storage');

const { getConfigUnsafe } = require('@pryv/boiler');
const config = getConfigUnsafe(true);

const database = storage.getDatabaseSync(true);

// MongoDB-specific classes used as the synchronous bootstrap target
// before init() resolves the engine-agnostic StorageLayer. They are
// behind a transparent Proxy (see `lazyProxy`) so any consumer that
// captures `dependencies.storage.user.<X>` at module-load time still
// sees the post-init StorageLayer target on every method call.
const { PasswordResetRequests } = require('storages/engines/mongodb/src/PasswordResetRequests.ts');
const { Sessions } = require('storages/engines/mongodb/src/Sessions.ts');
const { Accesses } = require('storages/engines/mongodb/src/user/Accesses.ts');
const { Profile } = require('storages/engines/mongodb/src/user/Profile.ts');
const { Webhooks } = require('storages/engines/mongodb/src/user/Webhooks.ts');

/**
 * Stable proxy whose underlying target can be swapped by `setTarget`.
 * Method lookups + property reads always go through the current target.
 *
 * Rationale: a few test files capture
 * `require('test-helpers').dependencies.storage.user.<X>` at module-
 * load time and pass the captured reference into a Repository
 * constructor (e.g. `Webhook.test.js`). Without the proxy, the captured
 * value is the MongoDB placeholder and the Repository hangs the test
 * suite when Mongo isn't running (e.g. `just test-pg`). With the proxy
 * the captured value is stable; init() replaces the underlying engine
 * (StorageLayer-resolved) once and every subsequent method call from
 * the captured reference reaches the right engine.
 */
function lazyProxy (initial: any): { proxy: any, setTarget: (t: any) => void } {
  let target = initial;
  const proxy = new Proxy({}, {
    get (_, prop) {
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
    set (_, prop, value) { target[prop] = value; return true; },
    has (_, prop) { return prop in target; },
    ownKeys () { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor (_, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); },
  });
  return { proxy, setTarget (t: any) { target = t; } };
}

const accessesProxy = lazyProxy(new Accesses(database));
const profileProxy = lazyProxy(new Profile(database));
const webhooksProxy = lazyProxy(new Webhooks(database));
const sessionsProxy = lazyProxy(new Sessions(database));
const passwordResetRequestsProxy = lazyProxy(new PasswordResetRequests(database));

/**
 * Test process dependencies.
 *
 * `storage.user.*` + `storage.sessions` + `storage.passwordResetRequests`
 * are exposed as proxies (see `lazyProxy`) so consumers that capture
 * them at module-load time still reach the post-init StorageLayer
 * target. The shape is otherwise unchanged.
 */
const dependencies = {
  settings: config.get(),
  storage: {
    database,
    get sessions () { return sessionsProxy.proxy; },
    get passwordResetRequests () { return passwordResetRequestsProxy.proxy; },
    user: {
      get accesses () { return accessesProxy.proxy; },
      get profile () { return profileProxy.proxy; },
      get webhooks () { return webhooksProxy.proxy; }
    }
  },
  /**
   * Called by global.test.js to initialize async components.
   * Always reconfigures storage via StorageLayer (engine-agnostic).
   */
  init: async function () {
    const storageLayer = await storage.getStorageLayer();
    accessesProxy.setTarget(storageLayer.accesses);
    profileProxy.setTarget(storageLayer.profile);
    webhooksProxy.setTarget(storageLayer.webhooks);
    sessionsProxy.setTarget(storageLayer.sessions);
    passwordResetRequestsProxy.setTarget(storageLayer.passwordResetRequests);
    // Plan 32 framework / Plan 66: production runs migrations in
    // `bin/master.js` before forking workers. The test harness calls
    // `storages.init()` directly without going through master, so we
    // run the migration runner ourselves to bring the test DB up to
    // the same schema shape as a deployed server (e.g. Plan 66's
    // `head_id`-aware unique-token index).
    try {
      const { createMigrationRunner } = require('storages/interfaces/migrations/index.ts');
      const runner = await createMigrationRunner();
      await runner.runAll();
    } catch (_err) {
      // Some test contexts use engines that don't register the
      // migrations capability — proceed without crashing.
    }
  }
};
export default dependencies;
export { dependencies };
export const settings = dependencies.settings;
export const _storage = dependencies.storage;
export { _storage as storage };
export const init = dependencies.init.bind(dependencies);
