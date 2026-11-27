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
 * up in `users_index`. An insert for an id that is not indexed (an erased
 * account, a typo'd id) is refused with SQLSTATE `PU001` (the error names the
 * table).
 *
 * The race with an account erasure is closed by a per-user transaction
 * advisory lock: the insert trigger takes it SHARED, then (a separate
 * statement, so with a snapshot taken after any wait) looks the id up; a
 * BEFORE DELETE OR UPDATE OF user_id trigger on `users_index` takes it
 * EXCLUSIVE. The erasure removes the index entry FIRST, which therefore waits
 * for every insert in flight for that id to end, and its data removal (later)
 * sees those rows; an insert arriving after the entry is gone waits for the
 * removal to commit, then finds nothing. Writers of one account never wait
 * for each other (shared locks), and no row lock is written on the index
 * entry. Because the exclusive side lives in the database, every deleter is
 * covered (a previous release's code, a hand `DELETE`); the guard therefore
 * depends on the `users_index` trigger being enabled, which the boot check
 * repairs like the insert triggers. Outside READ COMMITTED the probe keeps a
 * KEY SHARE row lock instead: a plain probe would read the transaction's
 * older snapshot, where the row lock raises a serialization failure.
 *
 * Lock key: the two-int form (`LOCK_CLASS`, hashtext(user_id)), its own key
 * space (the schema lock uses the bigint form) and recognisable in
 * `pg_locks`. A hash collision only serializes an erasure with the other
 * account's writers; the probe is by exact id, so it never weakens the guard.
 * Advisory locks use the shared lock table: one transaction inserting rows
 * for thousands of distinct accounts with the triggers on fails with "out of
 * shared memory"; bulk loads use the escape below, which takes no lock.
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
 * (`installUnindexedWritesGuard`): the `users_index` lock function and
 * trigger FIRST, then the insert function, then each table's trigger, each
 * created where absent, or enabled again where it was left disabled (an
 * interrupted `pg_restore --disable-triggers`). Each table is its own short
 * statement with a lock timeout, retried: a first install while another
 * process serves never holds more than one table's lock, nor waits long
 * behind its writes. If the `users_index` trigger cannot be installed, the
 * insert function gets the row-lock body, which needs no `users_index`
 * trigger, so no state of the install leaves a hole.
 *
 * To remove the guard by hand (every process stopped), drop both sides
 * together, never the `users_index` trigger alone.
 */

import type { Logger } from '@pryv/boiler';

const UNINDEXED_USER_ERRCODE = 'PU001';
const TRIGGER_NAME = 'refuse_unindexed_user';
const INDEX_TRIGGER_NAME = 'lock_user_index_removal';
/** Class of the per-user advisory locks (two-int form), 0x70727577. */
const LOCK_CLASS = 1886549367;

const GUARDED_TABLES = ['events', 'streams', 'accesses', 'profile', 'webhooks', 'account_fields', 'passwords', 'store_key_values'] as const;

const REFUSAL_SQL = `
    RAISE EXCEPTION 'user id "%" is not in the users index: row refused in %', NEW.user_id, TG_TABLE_NAME
      USING ERRCODE = '${UNINDEXED_USER_ERRCODE}', TABLE = TG_TABLE_NAME;`;

/**
 * Insert side. Both functions stay VOLATILE (the default): each statement
 * then takes a fresh snapshot, which is what makes the probe after the lock
 * wait see a removal that committed meanwhile. The lock and the probe stay
 * two statements, in that order.
 */
const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION refuse_unindexed_user() RETURNS trigger
LANGUAGE plpgsql AS $guard$
BEGIN
  IF current_setting('pryv.unindexed_writes', true) = 'allow' THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') = 'read committed' THEN
    PERFORM pg_advisory_xact_lock_shared(${LOCK_CLASS}, hashtext(NEW.user_id));
    PERFORM 1 FROM users_index WHERE user_id = NEW.user_id;
  ELSE
    PERFORM 1 FROM users_index WHERE user_id = NEW.user_id FOR KEY SHARE;
  END IF;
  IF NOT FOUND THEN${REFUSAL_SQL}
  END IF;
  RETURN NEW;
END;
$guard$;
`;

/** Insert side without the `users_index` trigger: the entry's row lock alone. */
const ROW_LOCK_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION refuse_unindexed_user() RETURNS trigger
LANGUAGE plpgsql AS $guard$
BEGIN
  IF current_setting('pryv.unindexed_writes', true) = 'allow' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users_index WHERE user_id = NEW.user_id FOR KEY SHARE;
  IF NOT FOUND THEN${REFUSAL_SQL}
  END IF;
  RETURN NEW;
END;
$guard$;
`;

/** Removal side: an index entry leaves (or changes id) only once no insert for its id is in flight. */
const INDEX_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION lock_user_index_removal() RETURNS trigger
LANGUAGE plpgsql AS $guard$
BEGIN
  PERFORM pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(OLD.user_id));
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
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
 * @returns per table (and `users_index` for the removal side): 'present',
 *   'created', 're-enabled' or 'failed'
 */
async function installUnindexedWritesGuard (client: QueryClient, logger: LoggerLike, options: { lockTimeoutMs?: number; attempts?: number } = {}): Promise<Record<string, string>> {
  const lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const attempts = options.attempts ?? ATTEMPTS;
  const outcome: Record<string, string> = {};
  await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
  try {
    // Removal side first: the advisory insert body is safe only once every
    // index removal takes the exclusive lock.
    let removalSide: string;
    try {
      await withRetry(() => client.query(INDEX_FUNCTION_SQL), attempts);
      removalSide = await ensureTrigger(client, logger, 'users_index', INDEX_TRIGGER_NAME,
        `CREATE TRIGGER ${INDEX_TRIGGER_NAME} BEFORE DELETE OR UPDATE OF user_id ON users_index FOR EACH ROW EXECUTE FUNCTION lock_user_index_removal()`,
        attempts, 'the row-lock form of the guard is kept until a later boot installs it');
    } catch (err: unknown) {
      removalSide = 'failed';
      logger.error(`PostgreSQL: the users-index removal lock could not be installed (${(err as Error)?.message}); ` +
        'the row-lock form of the guard is kept until a later boot installs it');
    }
    outcome.users_index = removalSide;
    await withRetry(() => client.query(removalSide === 'failed' ? ROW_LOCK_FUNCTION_SQL : FUNCTION_SQL), attempts);
    for (const table of GUARDED_TABLES) {
      outcome[table] = await ensureTrigger(client, logger, table, TRIGGER_NAME,
        `CREATE TRIGGER ${TRIGGER_NAME} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_unindexed_user()`,
        attempts, 'rows of an unindexed user id are not refused there until a later boot installs it');
    }
  } finally {
    await client.query('RESET lock_timeout');
  }
  return outcome;
}

/** Create `trigger` on `table` where absent, enable it where disabled; never throws. */
async function ensureTrigger (client: QueryClient, logger: LoggerLike, table: string, trigger: string, createSql: string, attempts: number, consequence: string): Promise<string> {
  const res = await client.query(
    'SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass', [trigger, table]);
  const state = res.rows[0]?.tgenabled as string | undefined;
  // 'O' fires in ordinary sessions, 'A' always; 'D' (disabled) and 'R'
  // (replica sessions only) leave the table unguarded.
  if (state === 'O' || state === 'A') return 'present';
  const ddl = state == null ? createSql : `ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`;
  if (state != null) {
    logger.warn(`PostgreSQL: the unindexed-user guard of table "${table}" was disabled (tgenabled ${state}): enabling it again`);
  }
  try {
    await withRetry(() => client.query(ddl), attempts);
    return state == null ? 'created' : 're-enabled';
  } catch (err: unknown) {
    logger.error(`PostgreSQL: the unindexed-user guard of table "${table}" could not be ${state == null ? 'installed' : 'enabled'} ` +
      `(${(err as Error)?.message}); ${consequence}`);
    return 'failed';
  }
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

export {
  installUnindexedWritesGuard, UNINDEXED_USER_ERRCODE, GUARDED_TABLES, TRIGGER_NAME, INDEX_TRIGGER_NAME, LOCK_CLASS,
  ROW_LOCK_FUNCTION_SQL, isUnindexedUserError
};
