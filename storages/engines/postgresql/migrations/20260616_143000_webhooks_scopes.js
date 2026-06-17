/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Webhooks scoped notifications: add the `scopes` JSONB column holding the
 * optional named-scope map (key -> { kind, query, prepared }) that restricts
 * which changes fire a webhook. Fresh databases get the column from the table
 * DDL; this migration brings existing deployments in line.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
 */
module.exports = {
  async up (context) {
    await context.db.query('ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS scopes JSONB;');
  }
};
