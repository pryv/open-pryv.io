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
 * one-time scan of `audit_events`). Event records are left alone. Audit
 * records carry no integrity of their own, so the content is edited in place.
 *
 * Idempotent.
 */
module.exports = {
  async up (context) {
    const res = await context.db.query(
      'UPDATE audit_events SET content = content #- \'{record,integrity}\' ' +
      'WHERE content #>> \'{record,key}\' LIKE \'ACCESS:%\' AND content #> \'{record,integrity}\' IS NOT NULL');
    context.logger?.info?.('audit records of access writes: the integrity copy removed from ' + res.rowCount + ' records');
    return { records: res.rowCount };
  }
};
