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
 * refused with SQLSTATE `PU001` (the error names the table). The lock is what
 * closes the race with an account erasure: the erasure removes the index
 * entry FIRST, which waits for an insert in flight to commit, and its data
 * removal (later) then sees that row; an insert arriving after the index
 * entry is gone finds nothing.
 *
 * Tables: those whose rows the erasure removes after the index entry. Not
 * guarded: `event_streams` (each link is written only while its event row
 * exists, holding it, and the erasure deletes `events` before
 * `event_streams`: see localUserEventsPG), `audit_events` (kept for erased
 * ids under `audit.onUserDelete: keep`, which a trigger cannot know: the
 * insert of UserAuditDatabasePG does the same check under `erase`, and a
 * restore imports without it), `series_data` (per-point cost; the
 * erasure drops series again last), `attachment_files` (removed before the
 * index entry), and the core-level tables (`external_ids`, `alias_index`,
 * `cmc_deletion_notices`, `account_erasures`).
 *
 * Escape hatch, for an operator loading data before its index (a data-only
 * `pg_restore` into an existing schema): `SET pryv.unindexed_writes = 'allow'`
 * in that session (or `pg_restore --disable-triggers`).
 *
 * Installed at boot, after the tables, under the schema advisory lock
 * (`installUnindexedWritesGuard`): the function is replaced, then each
 * table's trigger is created where absent, or enabled again where it was
 * left disabled (an interrupted `pg_restore --disable-triggers`). Each table
 * is its own short statement with a lock timeout, retried: a first install
 * while another process serves never holds more than one table's lock, nor
 * waits long behind its writes.
 */

import type { Logger } from '@pryv/boiler';

const UNINDEXED_USER_ERRCODE = 'PU001';
const TRIGGER_NAME = 'refuse_unindexed_user';

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
    RAISE EXCEPTION 'user id "%" is not in the users index: row refused in %', NEW.user_id, TG_TABLE_NAME
      USING ERRCODE = '${UNINDEXED_USER_ERRCODE}', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$guard$;
`;

/** Lock wait allowed to each table's DDL, and attempts. */
const LOCK_TIMEOUT_MS = 2000;
const ATTEMPTS = 5;
/** SQLSTATEs worth a retry: lock_not_available (the lock timeout), deadlock_detected. */
const RETRYABLE = new Set(['55P03', '40P01']);

type QueryClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
type LoggerLike = Pick<Logger, 'info' | 'warn' | 'error'>;

/**
 * Install (or repair) the guard on `client`'s database. The caller holds the
 * schema advisory lock; the tables exist. A table whose DDL keeps timing out
 * is left as it is, logged at error (the next boot tries again).
 * @returns per table: 'present', 'created', 're-enabled' or 'failed'
 */
async function installUnindexedWritesGuard (client: QueryClient, logger: LoggerLike, options: { lockTimeoutMs?: number; attempts?: number } = {}): Promise<Record<string, string>> {
  const lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const attempts = options.attempts ?? ATTEMPTS;
  const outcome: Record<string, string> = {};
  await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
  try {
    await withRetry(() => client.query(FUNCTION_SQL), attempts);
    for (const table of GUARDED_TABLES) {
      const res = await client.query(
        'SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass', [TRIGGER_NAME, table]);
      const state = res.rows[0]?.tgenabled as string | undefined;
      // 'O' fires in ordinary sessions, 'A' always; 'D' (disabled) and 'R'
      // (replica sessions only) leave the table unguarded.
      if (state === 'O' || state === 'A') { outcome[table] = 'present'; continue; }
      const ddl = state == null
        ? `CREATE TRIGGER ${TRIGGER_NAME} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_unindexed_user()`
        : `ALTER TABLE ${table} ENABLE TRIGGER ${TRIGGER_NAME}`;
      if (state != null) {
        logger.warn(`PostgreSQL: the unindexed-user guard of table "${table}" was disabled (tgenabled ${state}): enabling it again`);
      }
      try {
        await withRetry(() => client.query(ddl), attempts);
        outcome[table] = state == null ? 'created' : 're-enabled';
      } catch (err: unknown) {
        outcome[table] = 'failed';
        logger.error(`PostgreSQL: the unindexed-user guard of table "${table}" could not be ${state == null ? 'installed' : 'enabled'} ` +
          `(${(err as Error)?.message}); rows of an unindexed user id are not refused there until a later boot installs it`);
      }
    }
  } finally {
    await client.query('RESET lock_timeout');
  }
  return outcome;
}

async function withRetry<T> (fn: () => Promise<T>, attempts: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt >= attempts || !RETRYABLE.has((err as { code?: string })?.code ?? '')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** True for the refusal of the trigger (possibly wrapped). */
function isUnindexedUserError (err: unknown): boolean {
  for (let e = err, depth = 0; e != null && depth < 5; depth++) {
    const x = e as { code?: unknown; innerError?: unknown; cause?: unknown };
    if (x.code === UNINDEXED_USER_ERRCODE) return true;
    e = x.innerError ?? x.cause;
  }
  return false;
}

export { installUnindexedWritesGuard, UNINDEXED_USER_ERRCODE, GUARDED_TABLES, TRIGGER_NAME, isUnindexedUserError };
