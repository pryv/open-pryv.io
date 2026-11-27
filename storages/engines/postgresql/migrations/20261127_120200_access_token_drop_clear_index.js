/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Access tokens and session ids at rest, step 3: the unique index on the
 * clear token goes (the column stays, always NULL, for a later release to
 * drop). `bin/access-tokens.js unprotect` recreates it for a rollback.
 *
 * Idempotent.
 */
module.exports = {
  async up (context) {
    await context.db.query('DROP INDEX IF EXISTS idx_access_token');
  }
};
