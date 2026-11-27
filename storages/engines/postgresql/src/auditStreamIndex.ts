/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `audit_event_streams`: the access stream ids of each audit record, so that
 * reading the audit trail of ONE access (what every app token may do for
 * itself) reads that access's records in time order instead of walking the
 * account's whole trail with a LIKE on `stream_ids`.
 *
 * One row per (record, `access-...` term): a record names several accesses
 * (an access deleted with its children), a versioned access adds an alias
 * term, some records name none. `time` is in the key so a page comes out of
 * the primary key in order. Records without a time are not indexed.
 *
 * ⚑ The table is only a CANDIDATE source. The reader keeps every condition of
 * the LIKE statement, the stream filter included (the authorization boundary,
 * see `convertCondition` in UserAuditDatabasePG.ts): a wrong row here can
 * hide a record, never disclose one. And the reader uses it only once
 * `audit_event_streams_state.complete` says every record is indexed.
 *
 * Kept by triggers on `audit_events`, so every writer is covered (this
 * release, a previous one, a restore, a hand statement):
 * - `audit_event_streams_put`, AFTER INSERT OR UPDATE (row level);
 * - `audit_event_streams_drop`, AFTER DELETE (statement level, with the
 *   deleted rows): an account erasure removes a whole trail in one statement,
 *   and a row left here would be account data kept after its erasure.
 *
 * Installed at boot, under the schema advisory lock, after the tables
 * (`installAuditStreamIndex`): functions replaced, each trigger created where
 * absent and enabled where found disabled, then the one-row state created
 * (complete when `audit_events` is empty, i.e. on a fresh database). A
 * trigger found absent or disabled means records may have been written or
 * deleted unseen, anywhere in the table: the state is reset (complete or
 * not: a saved fill position is stale too) and the next fill rebuilds the
 * table from zero.
 *
 * Filled by `ensureAuditStreamIndex` (a migration and the master's start, on
 * a dedicated connection, with an advisory lock of its own taken by
 * polling): a run starting from zero empties the table first, then walks
 * `audit_events` by primary key in batches, one transaction each, recording
 * its position in the state row, so a stopped run resumes where it was. A
 * fill refuses to run, and resets the state, while a trigger does not fire.
 * Its state updates are compare-and-set: a reset made meanwhile by another
 * process (its install found a trigger missing) makes the fill start again
 * from zero instead of being overwritten.
 *
 * Race with deletions and updates: a batch reads a record, a DELETE (or an
 * UPDATE of its key columns) of that record commits before the batch does.
 * The trigger would not see the batch's uncommitted rows and the old ones
 * would stay. Each batch therefore holds an exclusive transaction-level
 * advisory lock, and the delete trigger and the update branch of the put
 * trigger take it shared before removing rows: they wait for the batch in
 * progress, then (a new statement, so a fresh snapshot in READ COMMITTED)
 * see and remove its rows. Inserts take no lock (a batch never reads an
 * uncommitted record). Outside a fill nobody holds the exclusive side.
 */

import { acquireAdvisoryLock, releaseAdvisoryLock } from './advisoryLock.ts';

type StreamIndexQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type StreamIndexQueryFn = (sql: string, params?: unknown[]) => Promise<StreamIndexQueryResult>;
interface StreamIndexClient { query: StreamIndexQueryFn; end: () => Promise<void> }
/** The part of DatabasePG used by the fill: a connection outside its pools. */
interface StreamIndexDb { connectDedicated: (applicationName: string) => Promise<StreamIndexClient> }
interface StreamIndexLog { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void }
type InstallClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/** The only prefix indexed (an id starting with it is a covered term). */
const COVERED_PREFIX = 'access-';

const PUT_TRIGGER = 'audit_event_streams_put';
const DROP_TRIGGER = 'audit_event_streams_drop';

// Session advisory lock of the fill ('pras'), distinct from the schema and the
// time-index keys: a booting process must not wait for a fill.
const FILL_LOCK_KEY = 0x70726173;
// Transaction advisory lock held by each batch, taken shared by the delete
// trigger ('prab'). See the race note above.
const BATCH_LOCK_KEY = 0x70726162;

// The update branch waits for a fill batch in progress (see the race note on
// top): the batch may have read the old version and would add its rows after
// they were removed here.
const PUT_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION audit_event_streams_put() RETURNS trigger
LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM pg_advisory_xact_lock_shared(${BATCH_LOCK_KEY});
    IF OLD.time IS NOT NULL AND OLD.stream_ids IS NOT NULL THEN
      DELETE FROM audit_event_streams
        WHERE user_id = OLD.user_id AND time = OLD.time AND eventid = OLD.eventid
          AND stream_id = ANY (string_to_array(OLD.stream_ids, ' '));
    END IF;
  END IF;
  IF NEW.time IS NOT NULL AND NEW.stream_ids IS NOT NULL AND position('${COVERED_PREFIX}' IN NEW.stream_ids) > 0 THEN
    INSERT INTO audit_event_streams (user_id, stream_id, time, eventid)
      SELECT NEW.user_id, t, NEW.time, NEW.eventid
      FROM unnest(string_to_array(NEW.stream_ids, ' ')) AS t
      WHERE left(t, ${COVERED_PREFIX.length}) = '${COVERED_PREFIX}'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$f$;
`;

// Accounts left with no audit record (an erasure) lose their rows by one
// range of the primary key each; the rows of the other deleted records are
// removed one key at a time. Measured on the erasure of a 200 000-record
// account: 4.3 s with keys alone, 1.5 s this way (0.5 s without triggers).
// Finding the emptied accounts and deleting their rows is ONE statement, so
// one snapshot: a record committed for such an account after it keeps its
// row (invisible to the delete), one committed before makes the account not
// emptied. Two statements would delete the row of a record committed
// between them.
const DROP_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION audit_event_streams_drop() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE
  emptied text[];
BEGIN
  PERFORM pg_advisory_xact_lock_shared(${BATCH_LOCK_KEY});
  WITH e AS MATERIALIZED (
    SELECT u.user_id FROM (SELECT DISTINCT g.user_id FROM gone g) u
      WHERE NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.user_id = u.user_id)
  ), d AS (
    DELETE FROM audit_event_streams s USING e WHERE s.user_id = e.user_id
  )
  SELECT array_agg(e.user_id) INTO emptied FROM e;
  IF EXISTS (SELECT 1 FROM gone g WHERE emptied IS NULL OR g.user_id <> ALL (emptied)) THEN
    DELETE FROM audit_event_streams s USING (
      SELECT g.user_id, t AS stream_id, g.time, g.eventid
      FROM gone g, unnest(string_to_array(g.stream_ids, ' ')) AS t
      WHERE g.time IS NOT NULL AND left(t, ${COVERED_PREFIX.length}) = '${COVERED_PREFIX}'
        AND (emptied IS NULL OR g.user_id <> ALL (emptied))
    ) k
    WHERE s.user_id = k.user_id AND s.stream_id = k.stream_id AND s.time = k.time AND s.eventid = k.eventid;
  END IF;
  RETURN NULL;
END;
$f$;
`;

// ⚑ The install creates a trigger only where absent: a changed definition
// (the `UPDATE OF` column list, the transition table name, the timing) is
// never applied by editing these constants alone. A later change of a trigger
// definition must ship as a drop + create in the install (or a comparison
// with `pg_get_triggerdef`). The functions are replaced whenever their body
// differs, so a change of a body needs nothing more.
const PUT_TRIGGER_SQL = `CREATE TRIGGER ${PUT_TRIGGER} AFTER INSERT OR UPDATE OF stream_ids, time, user_id, eventid ` +
  'ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_event_streams_put()';
const DROP_TRIGGER_SQL = `CREATE TRIGGER ${DROP_TRIGGER} AFTER DELETE ON audit_events ` +
  'REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION audit_event_streams_drop()';

/** Lock wait allowed to each DDL statement of the install, and attempts. */
const LOCK_TIMEOUT_MS = 2000;
const ATTEMPTS = 5;
/** SQLSTATEs worth a retry: lock_not_available (the lock timeout), deadlock_detected. */
const RETRYABLE = new Set(['55P03', '40P01']);

const RESET_STATE_SQL = 'UPDATE audit_event_streams_state SET complete = false, cursor_user_id = NULL, ' +
  'cursor_eventid = NULL, updated_at = now()';

type TriggerOutcome = 'present' | 'created' | 're-enabled' | 'failed';
interface InstallOutcome {
  [PUT_TRIGGER]: TriggerOutcome;
  [DROP_TRIGGER]: TriggerOutcome;
  /** The state after the install. */
  complete: boolean;
  /** Whether this install reset the state (it said complete, or held a fill position). */
  reset: boolean;
}

/**
 * Install (or repair) the triggers and the state row on `client`'s database.
 * The caller holds the schema advisory lock; the tables exist. A trigger
 * whose DDL keeps timing out is left as it is, logged at error (the next boot
 * tries again), and the state is left incomplete so readers keep the LIKE
 * statement.
 */
async function installAuditStreamIndex (client: InstallClient, logger: StreamIndexLog, options: { lockTimeoutMs?: number; attempts?: number } = {}): Promise<InstallOutcome> {
  const lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const attempts = options.attempts ?? ATTEMPTS;
  await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
  try {
    await ensureFunction(client, 'audit_event_streams_put', PUT_FUNCTION_SQL, attempts);
    await ensureFunction(client, 'audit_event_streams_drop', DROP_FUNCTION_SQL, attempts);
    const put = await ensureTrigger(client, logger, PUT_TRIGGER, PUT_TRIGGER_SQL, attempts);
    const drop = await ensureTrigger(client, logger, DROP_TRIGGER, DROP_TRIGGER_SQL, attempts);
    // After the triggers: a record committed before they existed makes the
    // table non-empty, so the state starts incomplete and the fill covers it.
    const before = await client.query('SELECT complete, cursor_user_id FROM audit_event_streams_state');
    let complete: boolean;
    let reset = false;
    if (before.rows.length === 0) {
      const res = await client.query(
        'INSERT INTO audit_event_streams_state (complete) SELECT NOT EXISTS (SELECT 1 FROM audit_events) ' +
        'ON CONFLICT (id) DO NOTHING RETURNING complete');
      complete = res.rows[0]?.complete === true;
    } else {
      complete = before.rows[0].complete === true;
    }
    const repaired = [put, drop].some((o) => o !== 'present');
    const broken = [put, drop].includes('failed');
    // A trigger that was not firing may have missed writes anywhere in the
    // table: a complete state is wrong, and so is the position of an
    // unfinished fill (it would resume past them). A row inserted just now
    // (fresh database, triggers just created) holds neither.
    const hadRow = before.rows.length > 0;
    if (broken || (hadRow && repaired)) {
      const position = hadRow && before.rows[0].cursor_user_id != null;
      if (complete || position) {
        await client.query(RESET_STATE_SQL);
        reset = true;
        logger.warn?.('PostgreSQL: a trigger of audit_event_streams was ' + (broken ? 'not installable' : 'missing or disabled') +
          ': the index of audit records by access is rebuilt from zero at the next fill; until then reads of one access\'s ' +
          'audit trail use the slower plan');
      }
      complete = false;
    }
    return { [PUT_TRIGGER]: put, [DROP_TRIGGER]: drop, complete, reset };
  } finally {
    await client.query('RESET lock_timeout').catch(() => {});
  }
}

/**
 * Run `createSql` (a `CREATE OR REPLACE FUNCTION ... $f$body$f$`) only when
 * the stored body differs: no catalog write, and no invalidation of cached
 * plans, at every connect of every pool.
 */
async function ensureFunction (client: InstallClient, name: string, createSql: string, attempts: number): Promise<void> {
  const body = createSql.slice(createSql.indexOf('$f$') + 3, createSql.lastIndexOf('$f$'));
  const res = await client.query('SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)', [name + '()']);
  if (res.rows[0]?.prosrc === body) return;
  await withRetry(() => client.query(createSql), attempts);
}

/** Create `trigger` where absent, enable it where disabled; 'failed' rather than thrown. */
async function ensureTrigger (client: InstallClient, logger: StreamIndexLog, trigger: string, createSql: string, attempts: number): Promise<TriggerOutcome> {
  const state = await triggerState(client, trigger);
  if (state === 'O' || state === 'A') return 'present';
  const ddl = state == null ? createSql : `ALTER TABLE audit_events ENABLE TRIGGER ${trigger}`;
  if (state != null) logger.warn?.(`PostgreSQL: trigger ${trigger} on audit_events was disabled (tgenabled ${state}): enabling it again`);
  try {
    await withRetry(() => client.query(ddl), attempts);
    return state == null ? 'created' : 're-enabled';
  } catch (err: unknown) {
    logger.error?.(`PostgreSQL: trigger ${trigger} on audit_events could not be ${state == null ? 'installed' : 'enabled'} ` +
      `(${(err as Error)?.message}); reads of one access's audit trail use the slower plan until a later boot installs it`);
    return 'failed';
  }
}

/** `tgenabled` of a trigger on audit_events ('O' / 'A' fire in ordinary sessions), or undefined when absent. */
async function triggerState (client: InstallClient, trigger: string): Promise<string | undefined> {
  const res = await client.query(
    'SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = \'audit_events\'::regclass', [trigger]);
  return res.rows[0]?.tgenabled as string | undefined;
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

// -- Fill -------------------------------------------------------------------

const FILL_APPLICATION_NAME = 'open-pryv.io audit stream index';
const FILL_LOCK_LABEL = 'audit stream index';
const DEFAULT_BATCH_ROWS = 20000;
const PROGRESS_EVERY_MS = 10_000;
/**
 * The TRUNCATE of a fill from zero asks for an ACCESS EXCLUSIVE lock: while
 * it waits, every audit insert (the put trigger writes the table) queues
 * behind it, and it waits for as long as a streamed read of the table keeps
 * its cursor open. So it waits 2 s at most, then lets the inserts through
 * and tries again.
 */
const TRUNCATE_LOCK_TIMEOUT_MS = 2000;
const TRUNCATE_ATTEMPTS = 30;
const TRUNCATE_RETRY_MS = 500;
/** Restarts from zero after a reset made by another process during the fill. */
const MAX_RESTARTS = 3;

interface FillResult {
  /** True when the state was complete already (nothing done). */
  alreadyComplete: boolean;
  /** Whether the run started from zero (table emptied first). */
  fromZero: boolean;
  /** Audit records read by this run. */
  rows: number;
  batches: number;
  durationMs: number;
}

interface FillOptions {
  logger?: StreamIndexLog;
  batchRows?: number;
  /** Test hook, awaited after each committed batch (its number, from 1). */
  afterBatch?: (batch: number) => void | Promise<void>;
}

/**
 * Bring `audit_event_streams` to complete. Idempotent: on a complete state it
 * is one query. Runs on a connection of its own (outside the pools, so no
 * pool budget is taken for the whole fill), with no statement or lock time
 * limit, under its own advisory lock taken by polling (never waited on with
 * `pg_advisory_lock`: a session waiting in that statement holds a snapshot,
 * the pattern that deadlocked the concurrent index builds). Ending the
 * connection releases the lock and rolls back a batch left open by a failure.
 */
async function ensureAuditStreamIndex (db: StreamIndexDb, options: FillOptions = {}): Promise<FillResult> {
  const log: StreamIndexLog = options.logger ?? {};
  const client = await db.connectDedicated(FILL_APPLICATION_NAME);
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SET lock_timeout = 0');
    await acquireAdvisoryLock(client, FILL_LOCK_KEY, log, { label: FILL_LOCK_LABEL, holderDoing: 'filling it' });
    const res = await fillLocked(client, log, options);
    await releaseAdvisoryLock(client, FILL_LOCK_KEY, log, FILL_LOCK_LABEL);
    return res;
  } finally {
    await client.end().catch(() => {});
  }
}

/** The triggers must fire for the table to stay exact; if one does not, reset the state and throw. */
async function requireTriggersFiring (client: StreamIndexClient, when: string): Promise<void> {
  for (const trigger of [PUT_TRIGGER, DROP_TRIGGER]) {
    const state = await triggerState(client, trigger);
    if (state === 'O' || state === 'A') continue;
    // Writes it missed may sort behind any saved position.
    await client.query(RESET_STATE_SQL);
    throw new Error(`audit stream index: trigger ${trigger} on audit_events is ${state == null ? 'missing' : 'disabled'} ${when}; ` +
      'the index is left incomplete and its position reset (the next start installs the trigger and rebuilds it from zero)');
  }
}

/** TRUNCATE the table, waiting at most TRUNCATE_LOCK_TIMEOUT_MS at a time (see there). */
async function truncateTable (client: StreamIndexClient, log: StreamIndexLog): Promise<void> {
  await client.query(`SET lock_timeout = ${TRUNCATE_LOCK_TIMEOUT_MS}`);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.query('TRUNCATE audit_event_streams');
        return;
      } catch (err: unknown) {
        if (attempt >= TRUNCATE_ATTEMPTS || (err as { code?: string })?.code !== '55P03') throw err;
        if (attempt === 1) log.info?.('audit stream index: waiting for reads of audit_event_streams to end before emptying it');
        await new Promise((resolve) => setTimeout(resolve, TRUNCATE_RETRY_MS));
      }
    }
  } finally {
    await client.query('SET lock_timeout = 0');
  }
}

async function fillLocked (client: StreamIndexClient, log: StreamIndexLog, options: FillOptions): Promise<FillResult> {
  const present = await client.query('SELECT to_regclass(\'audit_event_streams_state\') IS NOT NULL AS present');
  if (present.rows[0]?.present !== true) {
    // The schema step creates it before any fill: never report a no-op as a fill.
    throw new Error('audit stream index: table audit_event_streams_state is missing (the schema step did not run)');
  }
  await client.query('INSERT INTO audit_event_streams_state (complete) VALUES (false) ON CONFLICT (id) DO NOTHING');
  for (let restarts = 0; ; restarts++) {
    const res = await fillRun(client, log, options);
    if (res != null) return res;
    if (restarts >= MAX_RESTARTS) {
      throw new Error('audit stream index: the state was reset by another process during each of ' + (MAX_RESTARTS + 1) + ' fills; left incomplete');
    }
    log.warn?.('audit stream index: the state was reset by another process during the fill (a trigger found missing); starting again from zero');
  }
}

// Compare-and-set on the state the run last read or wrote: `updated_at`
// changes with every write (the reset included), the cursor covers a reset
// by hand that leaves `updated_at` alone.
const STATE_GUARD = 'complete = false AND cursor_user_id IS NOT DISTINCT FROM $1 AND cursor_eventid IS NOT DISTINCT FROM $2 AND updated_at::text = $3';

/** One run from the saved state; null when the state was changed by someone else (start again). */
async function fillRun (client: StreamIndexClient, log: StreamIndexLog, options: FillOptions): Promise<FillResult | null> {
  const t0 = Date.now();
  const batchRows = Math.max(1, Math.floor(options.batchRows ?? DEFAULT_BATCH_ROWS));
  const state = (await client.query(
    'SELECT complete, cursor_user_id, cursor_eventid, updated_at::text AS stamp FROM audit_event_streams_state')).rows[0];
  if (state.complete === true) {
    return { alreadyComplete: true, fromZero: false, rows: 0, batches: 0, durationMs: Date.now() - t0 };
  }
  // No time spent on a fill that cannot end complete.
  await requireTriggersFiring(client, 'before the fill');
  let cursor: [string, string] | null = state.cursor_user_id == null ? null : [String(state.cursor_user_id), String(state.cursor_eventid)];
  let stamp = String(state.stamp);
  const fromZero = cursor == null;
  const estimate = Number((await client.query(
    'SELECT GREATEST(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = \'audit_events\'::regclass')).rows[0]?.n ?? 0);
  log.info?.(`audit stream index: ${fromZero ? 'building' : 'resuming'} the index of audit records by access ` +
    `(about ${estimate} audit records in all); the start waits until it is done`);
  if (fromZero) {
    // Rows of records deleted while a trigger was missing, or left by an
    // interrupted run that never recorded a position: start from nothing.
    await truncateTable(client, log);
  }
  let rows = 0;
  let batches = 0;
  let lastProgress = Date.now();
  for (;;) {
    await client.query('BEGIN');
    let last: Record<string, unknown> | undefined;
    let read = 0;
    try {
      // A statement of its own, before the batch's snapshot: the delete
      // trigger waits for this transaction (see the race note on top).
      await client.query('SELECT pg_advisory_xact_lock($1)', [BATCH_LOCK_KEY]);
      const res = await client.query(`
        WITH batch AS MATERIALIZED (
          SELECT user_id, eventid, time, stream_ids FROM audit_events
          ${cursor == null ? '' : 'WHERE (user_id, eventid) > ($2, $3)'}
          ORDER BY user_id, eventid LIMIT $1
        ), put AS (
          INSERT INTO audit_event_streams (user_id, stream_id, time, eventid)
          SELECT b.user_id, t, b.time, b.eventid
          FROM batch b, unnest(string_to_array(b.stream_ids, ' ')) AS t
          WHERE b.time IS NOT NULL AND left(t, ${COVERED_PREFIX.length}) = '${COVERED_PREFIX}'
          ON CONFLICT DO NOTHING
        )
        SELECT (SELECT count(*) FROM batch)::int AS n, l.user_id, l.eventid
        FROM (SELECT 1) one LEFT JOIN LATERAL (
          SELECT user_id, eventid FROM batch ORDER BY user_id DESC, eventid DESC LIMIT 1
        ) l ON true`,
      cursor == null ? [batchRows] : [batchRows, cursor[0], cursor[1]]);
      read = Number(res.rows[0]?.n ?? 0);
      last = read > 0 ? res.rows[0] : undefined;
      if (last != null) {
        const saved = await client.query(
          `UPDATE audit_event_streams_state SET cursor_user_id = $4, cursor_eventid = $5, updated_at = now() WHERE ${STATE_GUARD} ` +
          'RETURNING updated_at::text AS stamp',
          [cursor?.[0] ?? null, cursor?.[1] ?? null, stamp, last.user_id, last.eventid]);
        if (saved.rows.length !== 1) {
          await client.query('ROLLBACK');
          return null;
        }
        stamp = String(saved.rows[0].stamp);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    if (last == null) break;
    cursor = [String(last.user_id), String(last.eventid)];
    rows += read;
    batches++;
    if (options.afterBatch != null) await options.afterBatch(batches);
    if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = Date.now();
      log.info?.(`audit stream index: ${rows} audit records read (about ${estimate} in all), ${Date.now() - t0} ms`);
    }
    if (read < batchRows) break;
  }
  // Complete only with both triggers firing: a trigger that stopped during the
  // run missed writes behind the position, and without it a record written
  // or deleted from now on would be missed too; readers would hide them.
  await requireTriggersFiring(client, 'at the end of the fill');
  const done = await client.query(
    `UPDATE audit_event_streams_state SET complete = true, cursor_user_id = NULL, cursor_eventid = NULL, updated_at = now() WHERE ${STATE_GUARD}`,
    [cursor?.[0] ?? null, cursor?.[1] ?? null, stamp]);
  if (done.rowCount !== 1) return null;
  const durationMs = Date.now() - t0;
  log.info?.(`audit stream index: complete, ${rows} audit records read in ${durationMs} ms`);
  return { alreadyComplete: false, fromZero, rows, batches, durationMs };
}

// -- Readers' view of the state ---------------------------------------------

/** Delay after which a reader reads the state again (in the background). */
const STREAM_INDEX_RECHECK_MS = 60_000;

type StateQueryDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * Whether readers may use `audit_event_streams`. False until read, and on
 * any failure to read it (no table, no row, a lost connection): the readers
 * then keep the LIKE statement.
 */
class StreamIndexState {
  complete: boolean = false;
  checkedAt: number = 0;
  recheckMs: number;
  db: StateQueryDb | null;
  refreshing: Promise<boolean> | null = null;

  constructor (db: StateQueryDb | null, recheckMs: number = STREAM_INDEX_RECHECK_MS) {
    this.db = db;
    this.recheckMs = recheckMs;
  }

  /** Read the state now. Never throws. */
  async refresh (): Promise<boolean> {
    if (this.db == null) return false;
    try {
      const res = await this.db.query('SELECT complete FROM audit_event_streams_state');
      this.complete = res.rows[0]?.complete === true;
    } catch (err) {
      this.complete = false;
    }
    this.checkedAt = Date.now();
    return this.complete;
  }

  /** The last state read; starts a background read when it is too old. */
  isComplete (): boolean {
    if (this.db != null && this.refreshing == null && Date.now() - this.checkedAt >= this.recheckMs) {
      this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    }
    return this.complete;
  }
}

export {
  StreamIndexState, STREAM_INDEX_RECHECK_MS,
  installAuditStreamIndex, ensureAuditStreamIndex, COVERED_PREFIX, PUT_TRIGGER, DROP_TRIGGER, FILL_LOCK_KEY, BATCH_LOCK_KEY,
  PUT_FUNCTION_SQL, DROP_FUNCTION_SQL
};
export type { FillResult, InstallOutcome };
