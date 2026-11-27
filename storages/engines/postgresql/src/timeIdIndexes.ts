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
 * concurrent build leaves an INVALID index: it is dropped and built again.
 *
 * Everything runs on one connection holding an advisory lock of its own:
 * an index being built CONCURRENTLY by another session also reads as
 * invalid, so two runners at once (a booting core and `bin/migrate.js up`)
 * would otherwise drop each other's build and leave the table without any
 * time index for the length of a build.
 */

import { acquireAdvisoryLock, releaseAdvisoryLock } from './advisoryLock.ts';

type IndexQueryResult = { rows: Array<Record<string, unknown>> };
type IndexQueryFn = (sql: string, params?: unknown[]) => Promise<IndexQueryResult>;
interface IndexDbClient { query: IndexQueryFn }
interface IndexDedicatedClient extends IndexDbClient { end: () => Promise<void> }
/** The part of DatabasePG used here: a connection outside its pools. */
interface IndexDb { connectDedicated: (applicationName: string) => Promise<IndexDedicatedClient> }
interface IndexLogLike { info?: (msg: string) => void; warn?: (msg: string) => void }

// Advisory-lock key of this migration ('prti' in hex). Distinct from the
// schema DDL key: a booting process must not wait for an index build.
const TIME_ID_INDEXES_LOCK_KEY = 0x70727469;

interface TimeIdIndex {
  table: string;
  name: string;
  columns: string;
  /** The column list as `pg_get_indexdef` prints it. */
  indexdefColumns: string;
  /** The `(user_id, time)` index it replaces. */
  replaces: string;
}

const TIME_ID_INDEXES: TimeIdIndex[] = [
  { table: 'events', name: 'idx_event_time_id', columns: '(user_id, time, id)', indexdefColumns: '(user_id, "time", id)', replaces: 'idx_event_time' },
  { table: 'audit_events', name: 'idx_audit_time_id', columns: '(user_id, time, eventid)', indexdefColumns: '(user_id, "time", eventid)', replaces: 'idx_audit_time' }
];

interface TimeIdIndexResult {
  name: string;
  /** False when the index was there and valid already. */
  built: boolean;
  /** Whether the replaced index was there (and is now dropped). */
  droppedPrevious: boolean;
  durationMs: number;
}

type IndexState = 'missing' | 'valid' | 'invalid' | 'other-definition';

/**
 * Whether the index `name` exists, and if so whether it is valid and has the
 * expected definition (a plain btree index on the expected columns). Without
 * `spec`, only presence and validity.
 */
async function indexState (client: IndexDbClient, name: string, spec?: TimeIdIndex): Promise<IndexState> {
  const res = await client.query(
    'SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = to_regclass($1)', [name]);
  if (res.rows.length === 0) return 'missing';
  if (res.rows[0].valid !== true) return 'invalid';
  if (spec == null) return 'valid';
  const def = String(res.rows[0].def);
  const expected = new RegExp(`^CREATE INDEX ${spec.name} ON (\\S+\\.)?${spec.table} USING btree ${escapeRegExp(spec.indexdefColumns)}$`);
  return expected.test(def) ? 'valid' : 'other-definition';
}

function escapeRegExp (s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LOCK_LABEL = 'time sort indexes';

/**
 * Build the `(user_id, time, id)` indexes that are missing, invalid or
 * defined otherwise, then drop the `(user_id, time)` ones they replace.
 * Statements run one by one on a connection of its own outside the pools (a
 * small pool `max` cannot starve it), outside any transaction (CONCURRENTLY
 * requires it), with no statement or lock time limit (a server default would
 * cancel the build at every start); the connection is ended afterwards, which
 * releases the lock and the settings whatever happened. The lock is polled
 * (see `advisoryLock.ts`), with no maximum wait. A table that does not exist
 * is skipped.
 */
async function ensureTimeIdIndexes (db: IndexDb, { logger }: { logger?: IndexLogLike } = {}): Promise<TimeIdIndexResult[]> {
  const log: IndexLogLike = logger ?? {};
  const client = await db.connectDedicated('open-pryv.io time sort indexes');
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SET lock_timeout = 0');
    await acquireAdvisoryLock(client, TIME_ID_INDEXES_LOCK_KEY, log, { label: LOCK_LABEL, holderDoing: 'building them' });
    let failed = false;
    try {
      return await ensureLocked(client, log);
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      // After a failed statement the connection may be gone: the failure is
      // the news then, and ending the connection releases the lock.
      if (!failed) await releaseAdvisoryLock(client, TIME_ID_INDEXES_LOCK_KEY, log, LOCK_LABEL);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function ensureLocked (client: IndexDbClient, log: IndexLogLike): Promise<TimeIdIndexResult[]> {
  const results: TimeIdIndexResult[] = [];
  for (const spec of TIME_ID_INDEXES) {
    const table = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [spec.table]);
    if (table.rows[0]?.present !== true) continue;
    const t0 = Date.now();
    let state = await indexState(client, spec.name, spec);
    let built = false;
    if (state === 'invalid' || state === 'other-definition') {
      const building = await client.query(
        'SELECT 1 FROM pg_stat_progress_create_index WHERE index_relid = to_regclass($1)', [spec.name]);
      if (building.rows.length > 0) {
        throw new Error(`index ${spec.name} is being built by another session: start again once it is done`);
      }
      log.warn?.(`time sort index ${spec.name}: ${state === 'invalid' ? 'invalid (a build that failed)' : 'defined otherwise than ' + spec.columns}; dropping it`);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${spec.name}`);
      state = 'missing';
    }
    if (state === 'missing') {
      log.info?.(`building ${spec.name} on ${spec.table} ${spec.columns} CONCURRENTLY: the start waits until it is done, ` +
        'and the build waits for the open transactions of this database');
      await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON ${spec.table} ${spec.columns}`);
      built = true;
      if (await indexState(client, spec.name, spec) !== 'valid') {
        throw new Error(`index ${spec.name} on ${spec.table} is not valid after its build`);
      }
      log.info?.(`${spec.name} built in ${Date.now() - t0} ms`);
    }
    const previous = await indexState(client, spec.replaces);
    if (previous !== 'missing') await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${spec.replaces}`);
    results.push({ name: spec.name, built, droppedPrevious: previous !== 'missing', durationMs: Date.now() - t0 });
  }
  return results;
}

export { ensureTimeIdIndexes, TIME_ID_INDEXES };
export type { TimeIdIndexResult };
