/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Refuse rows of a user id the users index does not hold: installs the
 * `refuse_unindexed_user()` function and its BEFORE INSERT trigger on the
 * user-keyed tables (see src/unindexedWritesGuard.ts). The schema DDL run at
 * boot installs them too; this migration records the change for existing
 * deployments. Rows already stored are not checked.
 *
 * Idempotent: CREATE OR REPLACE FUNCTION, triggers created only where absent.
 */
module.exports = {
  async up (context) {
    const { UNINDEXED_WRITES_GUARD_SQL } = require('../src/unindexedWritesGuard.ts');
    await context.db.query(UNINDEXED_WRITES_GUARD_SQL);
  }
};
