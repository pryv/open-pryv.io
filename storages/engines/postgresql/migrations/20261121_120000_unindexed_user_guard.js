/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Refuse rows of a user id the users index does not hold: the
 * `refuse_unindexed_user()` function and its BEFORE INSERT trigger on the
 * user-keyed tables, and the `lock_user_index_removal` trigger on
 * `users_index` (see src/unindexedWritesGuard.ts). The boot installs them
 * (and enables a trigger left disabled) before migrations run; this migration
 * records the change for existing deployments and runs the same check, under
 * the same advisory lock as the boot. Rows already stored are not checked.
 *
 * Idempotent.
 */
module.exports = {
  async up (context) {
    await context.db.ensureUnindexedWritesGuard();
  }
};
