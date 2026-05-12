/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Plan 66 — accesses versioning: add `serial`, `head_id`, `created_by_serial`,
 * `modified_by_serial` columns; tighten unique indexes so they only apply to
 * live head rows; add a history-lookup index.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS + DROP/CREATE INDEX paired with
 * matching predicates. Safe to re-run.
 */
module.exports = {
  async up (context) {
    const sql = `
      ALTER TABLE accesses ADD COLUMN IF NOT EXISTS serial INTEGER;
      ALTER TABLE accesses ADD COLUMN IF NOT EXISTS head_id TEXT;
      ALTER TABLE accesses ADD COLUMN IF NOT EXISTS created_by_serial INTEGER;
      ALTER TABLE accesses ADD COLUMN IF NOT EXISTS modified_by_serial INTEGER;

      DROP INDEX IF EXISTS idx_access_token;
      CREATE UNIQUE INDEX idx_access_token
        ON accesses(user_id, token) WHERE deleted IS NULL AND head_id IS NULL;

      DROP INDEX IF EXISTS idx_access_name_type_deviceName;
      CREATE UNIQUE INDEX idx_access_name_type_deviceName
        ON accesses(user_id, name, type, device_name) NULLS NOT DISTINCT
        WHERE deleted IS NULL AND head_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_access_head_id
        ON accesses(user_id, head_id) WHERE head_id IS NOT NULL;
    `;
    await context.db.query(sql);
  }
};
