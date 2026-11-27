/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Access tokens at rest, step 6: the audit record of an access write names
 * the access version by its key only (the hash covers the token, a copy of it
 * would be an offline oracle for a weak token). Records written before carry
 * the hash in `content.record.integrity`: removed here, in one statement (a
 * one-time scan of `audit_events`; see `src/auditAccessIntegrityScrub.ts`).
 * Event records are left alone. A core whose audit is on SQLite has an empty
 * `audit_events`: its records are scrubbed by the start pass instead.
 *
 * Idempotent.
 */
module.exports = {
  async up (context) {
    const { scrubAuditEventsTable } = require('../src/auditAccessIntegrityScrub.ts');
    const records = await scrubAuditEventsTable(context.db);
    context.logger?.info?.('audit records of access writes: the integrity copy removed from ' + records + ' records');
    return { records };
  }
};
