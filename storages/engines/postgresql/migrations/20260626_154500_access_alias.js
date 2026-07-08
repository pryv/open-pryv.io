/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Access aliases: add the `alias` column holding the routable, platform-unique
 * de-identifying name substituted for the username in this access's
 * apiEndpoint. Fresh databases get the column from the table DDL; this
 * migration brings existing deployments in line. The alias->userId resolution
 * index (`alias_index`) is created idempotently by the schema DDL on boot.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
 */
module.exports = {
  async up (context) {
    await context.db.query('ALTER TABLE accesses ADD COLUMN IF NOT EXISTS alias TEXT;');
    await context.db.query('CREATE TABLE IF NOT EXISTS alias_index (alias TEXT PRIMARY KEY, user_id TEXT NOT NULL);');
    await context.db.query('CREATE INDEX IF NOT EXISTS idx_alias_index_user_id ON alias_index(user_id);');
  }
};
