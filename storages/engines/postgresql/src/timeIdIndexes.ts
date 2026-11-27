/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The indexes serving the time sorts of `events` and `audit_events`.
 *
 * Both sorts end with the row id (`ORDER BY time, id` in the same direction)
 * so that rows sharing a time come back in one order whatever the plan. An
 * index on `(user_id, time)` alone serves `time` but not the id after it: the
 * planner then adds an incremental sort above the scan, measured 3 to 4 times
 * slower on a restricted page of 20. `(user_id, time, id)` serves the whole
 * order and every use of `(user_id, time)` (same leading columns), so it
 * replaces it.
 *
 * A fresh database gets the new index from the schema DDL. An existing one
 * gets it from a migration: built CONCURRENTLY (writes go on during the
 * build), then the previous index is dropped, CONCURRENTLY too. A failed
 * concurrent build leaves an INVALID index that `IF NOT EXISTS` would keep: it
 * is dropped and built again.
 */

type QueryResult = { rows: Array<Record<string, unknown>> };
type DbLike = { query: (sql: string, params?: unknown[]) => Promise<QueryResult> };

interface TimeIdIndex {
  table: string;
  name: string;
  columns: string;
  /** The `(user_id, time)` index it replaces. */
  replaces: string;
}

const TIME_ID_INDEXES: TimeIdIndex[] = [
  { table: 'events', name: 'idx_event_time_id', columns: '(user_id, time, id)', replaces: 'idx_event_time' },
  { table: 'audit_events', name: 'idx_audit_time_id', columns: '(user_id, time, eventid)', replaces: 'idx_audit_time' }
];

interface TimeIdIndexResult {
  name: string;
  /** False when the index was there and valid already. */
  built: boolean;
  /** Whether the replaced index was there (and is now dropped). */
  droppedPrevious: boolean;
  durationMs: number;
}

/** Whether the index `name` exists, and if so whether it is valid. */
async function indexState (db: DbLike, name: string): Promise<'missing' | 'valid' | 'invalid'> {
  const res = await db.query(
    'SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass($1)', [name]);
  if (res.rows.length === 0) return 'missing';
  return res.rows[0].valid === true ? 'valid' : 'invalid';
}

/**
 * Build the `(user_id, time, id)` indexes that are missing or invalid, then
 * drop the `(user_id, time)` ones they replace. Statements run one by one
 * outside any transaction (CONCURRENTLY requires it): `db` must not be a
 * client inside a transaction block. A table that does not exist is skipped.
 */
async function ensureTimeIdIndexes (db: DbLike): Promise<TimeIdIndexResult[]> {
  const results: TimeIdIndexResult[] = [];
  for (const spec of TIME_ID_INDEXES) {
    const table = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [spec.table]);
    if (table.rows[0]?.present !== true) continue;
    const t0 = Date.now();
    let state = await indexState(db, spec.name);
    let built = false;
    if (state === 'invalid') {
      await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${spec.name}`);
      state = 'missing';
    }
    if (state === 'missing') {
      await db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON ${spec.table} ${spec.columns}`);
      built = true;
      if (await indexState(db, spec.name) !== 'valid') {
        throw new Error(`index ${spec.name} on ${spec.table} is not valid after its build`);
      }
    }
    const previous = await indexState(db, spec.replaces);
    if (previous !== 'missing') await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${spec.replaces}`);
    results.push({ name: spec.name, built, droppedPrevious: previous !== 'missing', durationMs: Date.now() - t0 });
  }
  return results;
}

export { ensureTimeIdIndexes, TIME_ID_INDEXES };
export type { TimeIdIndexResult };
