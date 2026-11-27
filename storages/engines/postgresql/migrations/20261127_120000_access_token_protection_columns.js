/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Access tokens and session ids at rest, step 1 (DDL, additive): the keyed
 * hash and encrypted copy columns, and the unique index on the hash that
 * replaces the one on the clear token (dropped in step 3). Its name keeps
 * `token` so a duplicate still reports `isDuplicateIndex('token')`.
 * `idx_access_token_clear` covers the rows not converted yet: empty in steady
 * state, it makes the boot probe for them free.
 *
 * Idempotent.
 */
module.exports = {
  async up (context) {
    await context.db.query(`
      ALTER TABLE accesses ADD COLUMN IF NOT EXISTS token_hash TEXT;
      ALTER TABLE accesses ADD COLUMN IF NOT EXISTS token_enc TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id_enc TEXT;
      DROP INDEX IF EXISTS idx_access_token_hash;
      CREATE UNIQUE INDEX idx_access_token_hash
        ON accesses(user_id, token_hash) WHERE deleted IS NULL AND head_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_access_token_clear
        ON accesses(user_id) WHERE token IS NOT NULL;
    `);
  }
};
