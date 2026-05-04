/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [WFTL] worker harness — Plan 57 Phase 5a.
 *
 * Deliberately does NOT explicitly require bin/_ts-register.js. The whole
 * point of the test that spawns this is to assert that NODE_OPTIONS
 * inheritance is sufficient to load .ts files in a forked child. If the
 * parent's NODE_OPTIONS isn't propagating, this require() throws
 * MODULE_NOT_FOUND for the .ts source.
 */

try {
  // UserStorage is a .ts file under storages/interfaces/baseStorage/.
  // It exports `{ validateUserStorage, REQUIRED_METHODS }` (Phase 1 pattern).
  const UserStorage = require('storages/interfaces/baseStorage/UserStorage');
  process.send({
    ok: true,
    tsModuleType: typeof UserStorage,
    exportKeys: UserStorage && typeof UserStorage === 'object' ? Object.keys(UserStorage) : null
  });
} catch (err) {
  process.send({ ok: false, error: err.message + '\n' + (err.stack || '') });
} finally {
  // Give the IPC message time to flush before exit.
  setTimeout(() => process.exit(0), 100);
}
