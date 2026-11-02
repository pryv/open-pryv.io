/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Personal accesses: add the `last_login` column holding the time (seconds)
 * of the last completed sign-in on the access (password, password plus
 * second factor, or identity provider). Fresh databases get the column from
 * the table DDL; this migration brings existing deployments in line. Rows
 * written before it keep a NULL value until their next sign-in.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
 */
module.exports = {
  async up (context) {
    await context.db.query('ALTER TABLE accesses ADD COLUMN IF NOT EXISTS last_login DOUBLE PRECISION;');
  }
};
