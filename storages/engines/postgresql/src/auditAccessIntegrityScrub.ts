/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The audit record of an access write names the access version by its key
 * only (the hash covers the token: a copy of it would be an offline oracle for
 * a weak token). Records written before carry the hash in
 * `content.record.integrity`: removed in one statement over `audit_events`
 * (event records left alone; audit records carry no integrity of their own,
 * so the content is edited in place).
 *
 * `idx_audit_access_integrity` covers exactly the records to scrub: built once
 * (one scan of the table), empty afterwards, so the statement costs an empty
 * index read when it runs again. It runs from the migration `20261127_120500`
 * and from the storages barrel's start pass whenever this engine holds the
 * audit (also when PostgreSQL holds the audit only, where its migrations do
 * not run, and after a rollback during which a previous image wrote records
 * with the hash).
 */

import { _internals } from './_internals.ts';

type PgQueryable = { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> };

const logger = _internals.lazyLogger('storage:audit-access-integrity-pg');

/** Must stay the literal predicate of `idx_audit_access_integrity` (no bind parameter). */
const TO_SCRUB_WHERE = 'content #> \'{record,integrity}\' IS NOT NULL AND content #>> \'{record,key}\' LIKE \'ACCESS:%\'';

/** Remove the hash from the access-write records of `audit_events`; returns the records changed. */
async function scrubAuditEventsTable (db: PgQueryable): Promise<number> {
  // Only when the index is missing: `CREATE INDEX IF NOT EXISTS` takes the SHARE lock on the table before it looks at
  // the name, which queues every audit write behind a concurrent index build of `audit_events` and makes that build
  // fail as a deadlock. The start pass runs this at every start.
  await db.query('DO $$ BEGIN IF to_regclass(\'idx_audit_access_integrity\') IS NULL THEN ' +
    'CREATE INDEX IF NOT EXISTS idx_audit_access_integrity ON audit_events(user_id) WHERE ' + TO_SCRUB_WHERE + '; END IF; END $$;');
  const res = await db.query('UPDATE audit_events SET content = content #- \'{record,integrity}\' WHERE ' + TO_SCRUB_WHERE);
  const n = res.rowCount ?? 0;
  if (n > 0) logger.info('audit records of access writes: the integrity copy removed from ' + n + ' records');
  return n;
}

/** The barrel's call when this engine holds the audit: on the audit storage's own pool, else the base one. */
async function scrubAccessAuditIntegrity (options: { force?: boolean; auditStorage?: unknown } = {}): Promise<{ records: number; failedUsers: number } | null> {
  const db = (options.auditStorage as { db?: PgQueryable } | null | undefined)?.db ?? (_internals.databasePG as PgQueryable | undefined);
  if (db == null) return null;
  return { records: await scrubAuditEventsTable(db), failedUsers: 0 };
}

export { scrubAuditEventsTable, scrubAccessAuditIntegrity };
