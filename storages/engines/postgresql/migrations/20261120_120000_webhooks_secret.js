/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Signed webhook calls: add the `secret` TEXT column holding the per-webhook
 * signing secret. Fresh databases get the column from the table DDL; this
 * migration brings existing deployments in line. Webhooks created before it
 * keep a NULL value (unsigned calls) until their secret is rotated.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
 */
module.exports = {
  async up (context) {
    await context.db.query('ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS secret TEXT;');
  }
};
