/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Storage-level refusal of rows for a user id the users index does not hold.
 *
 * A BEFORE INSERT trigger on the user-keyed tables looks the row's `user_id`
 * up in `users_index` and takes a KEY SHARE lock on the entry it finds. An
 * insert for an id that is not indexed (an erased account, a typo'd id) is
 * refused with SQLSTATE `PU001`. The lock is what closes the race with an
 * account erasure: the erasure removes the index entry FIRST, which waits for
 * an insert in flight to commit, and its data removal (later) then sees that
 * row; an insert arriving after the index entry is gone finds nothing.
 *
 * Tables: those whose rows the erasure removes after the index entry. Not
 * guarded: `event_streams` (written in the same transaction as its event),
 * `audit_events` (kept for erased ids under `audit.onUserDelete: keep`),
 * `series_data` (per-point cost; the erasure drops series again last),
 * `attachment_files` (removed before the index entry), and the core-level
 * tables (`external_ids`, `alias_index`, `cmc_deletion_notices`,
 * `account_erasures`).
 *
 * Escape hatch, for an operator loading data before its index (a data-only
 * `pg_restore` into an existing schema): `SET pryv.unindexed_writes = 'allow'`
 * in that session (or `pg_restore --disable-triggers`).
 */

const UNINDEXED_USER_ERRCODE = 'PU001';

const GUARDED_TABLES = ['events', 'streams', 'accesses', 'profile', 'webhooks', 'account_fields', 'passwords', 'store_key_values'] as const;

const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION refuse_unindexed_user() RETURNS trigger
LANGUAGE plpgsql AS $guard$
BEGIN
  IF current_setting('pryv.unindexed_writes', true) = 'allow' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users_index WHERE user_id = NEW.user_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user id "%" is not in the users index: row refused', NEW.user_id
      USING ERRCODE = '${UNINDEXED_USER_ERRCODE}';
  END IF;
  RETURN NEW;
END;
$guard$;
`;

// Created only where absent: no table lock at every boot once installed.
function triggerSql (table: string): string {
  return `
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'refuse_unindexed_user' AND tgrelid = '${table}'::regclass) THEN
    CREATE TRIGGER refuse_unindexed_user BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION refuse_unindexed_user();
  END IF;
END
$guard$;
`;
}

/** The function and one trigger per guarded table; idempotent. Runs after the tables exist. */
const UNINDEXED_WRITES_GUARD_SQL = FUNCTION_SQL + GUARDED_TABLES.map(triggerSql).join('');

/** True for the refusal of the trigger (possibly wrapped). */
function isUnindexedUserError (err: unknown): boolean {
  for (let e = err, depth = 0; e != null && depth < 5; depth++) {
    const x = e as { code?: unknown; innerError?: unknown; cause?: unknown };
    if (x.code === UNINDEXED_USER_ERRCODE) return true;
    e = x.innerError ?? x.cause;
  }
  return false;
}

export { UNINDEXED_WRITES_GUARD_SQL, UNINDEXED_USER_ERRCODE, GUARDED_TABLES, isUnindexedUserError };
