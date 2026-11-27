/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Fill `audit_event_streams`, the access stream ids of each audit record
 * (table and triggers come from the schema step of the start; see
 * src/auditStreamIndex.ts). One pass over `audit_events` in batches, its
 * position recorded so a stopped run resumes; writes go on meanwhile. A fresh
 * database starts complete (this is then one query).
 *
 * The start also runs the fill after the migrations (bin/master.js), which
 * covers a state reset by a later start (a trigger found missing) and the
 * pairing of a SQLite base storage with a PostgreSQL audit storage, where
 * this migration does not run.
 *
 * A failed fill does not fail the migration: the state stays incomplete, the
 * readers keep the plain statement, and the fill that follows (start or
 * `bin/migrate.js up`) resumes it and reports the failure.
 */
module.exports = {
  async up (context) {
    const { ensureAuditStreamIndex } = require('../src/auditStreamIndex.ts');
    try {
      return await ensureAuditStreamIndex(context.db, { logger: context.logger });
    } catch (err) {
      context.logger?.warn?.('audit stream index: fill failed (' + err.message + '); it is resumed after the migrations');
      return { failed: err.message };
    }
  }
};
