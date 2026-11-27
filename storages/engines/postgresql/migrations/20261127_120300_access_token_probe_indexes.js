/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Access tokens and session ids at rest, step 4: indexes that keep the
 * checks run at every start from reading whole tables. The key id of the
 * protected rows (the first 9 characters of the hash: 8 of key id and the
 * dot) is indexed on accesses and sessions, so the guard against rows under
 * another key reads the smallest and the largest value only; the sessions
 * still keyed by their clear id get a partial index, empty in steady state,
 * like `idx_access_token_clear` for accesses. The expressions must stay the
 * ones the probes of `AccessesPG` / `SessionsPG` use.
 *
 * Idempotent.
 */
module.exports = {
  async up (context) {
    await context.db.query(`
      CREATE INDEX IF NOT EXISTS idx_access_token_kid
        ON accesses ((left(token_hash, 9))) WHERE token IS NULL AND token_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_session_clear
        ON sessions(id) WHERE id_enc IS NULL;
      CREATE INDEX IF NOT EXISTS idx_session_kid
        ON sessions ((left(id, 9))) WHERE id_enc IS NOT NULL;
    `);
  }
};
