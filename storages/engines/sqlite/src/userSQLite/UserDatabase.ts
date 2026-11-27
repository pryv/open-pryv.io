/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
import type { Readable as NodeReadable } from 'node:stream';
import type { NormalizedCondition, ScalarValue } from '../../../../shared/contentQueryConditions.ts';

// ---- Types ----

import type { StoredEvent } from '../../../../interfaces/_shared/domain.ts';
import type { SummarizeParams, SummaryGroup } from '../../../../interfaces/auditStorage/UserAuditDatabase.ts';

// EventRow equals the canonical SqliteStmt's default row shape, so the
// shared statement type applies unparameterized.
import type { SqliteDb, SqliteStmt } from '../types.ts';
import type { SqlPart } from './streamQueryUtils.ts';
const require = createRequire(import.meta.url);

const SQLite3 = require('better-sqlite3');
const { Readable } = require('stream');

const concurrentSafeWrite = require('../concurrentSafeWrite.ts');
const eventsSchema = require('./schema/events.ts');
const fullTextSearch = require('./fullTextSearch.ts');
const { toSQLiteStreamFilter } = require('./streamQueryUtils.ts');
const { summaryBudgetError, summaryInterruptedError, summaryAccessFilter, SUMMARY_ERROR_TYPE } = require('../../../../interfaces/auditStorage/UserAuditDatabase.ts');

/** A raw events-table row: arbitrary columns per eventsSchema. */
type EventRow = Record<string, unknown>;
/** The fromDB-converted event: stored-event fields where present, plus the
 *  open tail the eventsSchema converters read/write dynamically. */
type DomainEvent = Partial<StoredEvent> & Record<string, unknown>;

type ColumnDef = { type: string, index?: boolean };
type TableSchema = Record<string, ColumnDef>;

type EventQueries = {
  getAll: SqliteStmt,
  getTerms: SqliteStmt,
  addTerm: SqliteStmt,
  getById: SqliteStmt,
  getDeletedSince: SqliteStmt,
  getHistory: SqliteStmt,
  create: SqliteStmt,
  /** Prepared on first use (imports only). */
  createIfAbsent?: SqliteStmt,
  deleteByHeadId: SqliteStmt,
  deleteById: SqliteStmt
};

type LoggerFactory = { getLogger: (name: string) => Logger };

/** One mongo-style query clause as pushed by the mall layer. `content` shape
 *  depends on `type` (see `converters`), so it is opaque at this level. */
type QueryItem = { type: string, content: unknown };
type GetParams = {
  query: QueryItem[],
  options?: { sort?: Record<string, number>, limit?: number, skip?: number },
  streams?: unknown
};

interface UserDatabaseInstance {
  db: SqliteDb;
  logger: Logger;
  eventQueries: EventQueries;
}

const DB_OPTIONS = {};

const tableSchemas: Record<string, TableSchema> = {
  events: eventsSchema.dbSchema
};

/**
 * Per-user SQLite database wrapper.
 */
function UserDatabase (this: UserDatabaseInstance, logger: LoggerFactory, params: { dbPath: string }): void {
  this.logger = logger.getLogger('user-database');
  this.db = new SQLite3(params.dbPath, DB_OPTIONS);
}

UserDatabase.prototype.init = async function (this: UserDatabaseInstance): Promise<void> {
  await concurrentSafeWrite.initWALAndConcurrentSafeWriteCapabilities(this.db);
  // here we might want to skip DB initialization if version is not null

  // Populated incrementally below before any read; the cast names the shape.
  this.eventQueries = {} as EventQueries;

  // create all tables
  for (const tableName of Object.keys(tableSchemas)) {
    const columnNames = Object.keys(tableSchemas[tableName]);
    const columnTypes: string[] = [];
    const indexes: string[] = [];
    columnNames.forEach((columnName) => {
      const column = tableSchemas[tableName][columnName];
      columnTypes.push(`${columnName} ${column.type}`);
      if (column.index) { indexes.push(columnName); }
    });

    await concurrentSafeWrite.execute(() => {
      this.db.prepare(`CREATE TABLE IF NOT EXISTS ${tableName} (${columnTypes.join(', ')});`).run();
    });

    for (const columnName of indexes) {
      await concurrentSafeWrite.execute(() => {
        this.db.prepare(`CREATE INDEX IF NOT EXISTS ${tableName}_${columnName} ON ${tableName}(${columnName})`).run();
      });
    }
  }

  // setup events queries

  this.eventQueries.getAll = prepareGetAllQuery(this.db, 'events');

  // Every statement is IF NOT EXISTS: re-running the whole setup after SQLITE_BUSY is safe.
  await concurrentSafeWrite.execute(() => {
    fullTextSearch.setupForTable(this.db, 'events', tableSchemas.events, ['streamIds']);
  });
  // The access / action stream ids, listed by the audit store as streams (and
  // expanded by every events.get that names their parents). Read from the
  // full-text vocabulary, a listing decoded every posting of those terms: two
  // per audit row, ~50-130 ms per call on 2M rows. Kept here instead, filled
  // on insert, and from the vocabulary when the table is new. Exact for rows
  // inserted and deleted (an audit log); not maintained on updates. Terms keep
  // the stored case (stream ids are case-sensitive). `events_terms` is the
  // lower-cased table of earlier releases: when present (first open after the
  // upgrade, or after a rollback wrote to it again) it is dropped and this
  // table rebuilt. Created and filled in one transaction: a stop in between
  // must not leave it existing and empty for good.
  const t0 = Date.now();
  let filled = false;
  await concurrentSafeWrite.execute(() => {
    this.db.transaction(() => {
      const hasTable = (name: string): boolean => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
      if (!hasTable('events_terms') && hasTable(TERMS_TABLE)) return;
      this.db.prepare('DROP TABLE IF EXISTS events_terms').run();
      this.db.prepare(`CREATE TABLE IF NOT EXISTS ${TERMS_TABLE} (term TEXT PRIMARY KEY) WITHOUT ROWID`).run();
      this.db.prepare(`DELETE FROM ${TERMS_TABLE}`).run();
      fillTerms(this);
      filled = true;
    }).immediate();
  });
  const elapsed = Date.now() - t0;
  if (filled && elapsed > 1000) this.logger.info(`listed the access / action terms in ${elapsed} ms (once per database)`);
  this.eventQueries.getTerms = this.db.prepare(`SELECT term FROM ${TERMS_TABLE} WHERE term >= ? AND term < ? ORDER BY term`);
  this.eventQueries.addTerm = this.db.prepare(`INSERT OR IGNORE INTO ${TERMS_TABLE} (term) VALUES (?)`);

  // Head events only: a history version is a row of its own (headId set), never
  // addressed by its own id (same as the PostgreSQL engine's `head_id IS NULL`).
  this.eventQueries.getById = this.db.prepare('SELECT * FROM events WHERE eventid = ? AND headId IS NULL');
  this.eventQueries.getDeletedSince = this.db.prepare('SELECT * from events WHERE headId IS NULL AND deleted > ? ORDER BY deleted DESC');
  this.eventQueries.getHistory = this.db.prepare('SELECT * from events WHERE headId = ? ORDER BY modified ASC');

  this.eventQueries.create = prepareCreateQuery(this.db, 'events', Object.keys(tableSchemas.events));

  this.eventQueries.deleteByHeadId = this.db.prepare('DELETE FROM events WHERE headId = ?');
  this.eventQueries.deleteById = this.db.prepare('DELETE FROM events WHERE eventid = ?');
};

const TERMS_TABLE = 'events_stream_terms';
// `[from, to)` ranges of the kept terms; '.' follows '-'.
const TERM_RANGES: Array<[string, string]> = [['access-', 'access.'], ['action-', 'action.']];

/**
 * The kept terms of a row's stream ids (an array, or the stored
 * space-separated string), in stored case.
 */
function termsOf (streamIds: unknown): string[] {
  const ids = Array.isArray(streamIds) ? streamIds : (typeof streamIds === 'string' ? streamIds.split(' ') : []);
  return ids.filter((id): id is string => typeof id === 'string' && TERM_RANGES.some(([from, to]) => id >= from && id < to));
}

/**
 * Fill the terms table from the full-text vocabulary, which is lower-cased:
 * for each vocabulary term, the rows holding it are read (through the
 * full-text table, streamed) until one holds a stored id equal to it once
 * lower-cased, and every in-range stored id of the rows read is kept. A term
 * no stored id equals (`foo/access-x` tokenises to `access-x`) lists nothing.
 * Known limit: of several stored ids differing only by ASCII case, the first
 * found is listed (inserts list each); audit ids have one spelling (method
 * ids, lower-case access ids), and the user events store never reads this
 * table. Cost: about one row per term; a stream id that folds into a range
 * without being in it (`Action-items`) has all its rows read at each fill.
 */
function fillTerms (udb: UserDatabaseInstance): void {
  const vocabulary = udb.db.prepare('SELECT term FROM events_fts_v WHERE term >= ? AND term < ?');
  const rowsWith = udb.db.prepare('SELECT streamIds FROM events_fts WHERE streamIds MATCH ?');
  const add = udb.db.prepare(`INSERT OR IGNORE INTO ${TERMS_TABLE} (term) VALUES (?)`);
  for (const [from, to] of TERM_RANGES) {
    for (const { term } of vocabulary.all(from, to) as Array<{ term: string }>) {
      const found = new Set<string>();
      for (const row of rowsWith.iterate('"' + term.replace(/"/g, '""') + '"') as Iterable<{ streamIds: string | null }>) {
        const ids = termsOf(row.streamIds);
        for (const id of ids) found.add(id);
        if (ids.some((id) => id.toLowerCase() === term)) break;
      }
      for (const id of found) add.run(id);
    }
  }
}

/** Refill the terms table (terms with no row left drop out). */
async function rebuildTerms (udb: UserDatabaseInstance): Promise<void> {
  await concurrentSafeWrite.execute(() => {
    udb.db.transaction(() => {
      udb.db.prepare(`DELETE FROM ${TERMS_TABLE}`).run();
      fillTerms(udb);
    })();
  });
}

function prepareGetAllQuery (db: SqliteDb, tableName: string): SqliteStmt {
  return db.prepare(`SELECT * FROM ${tableName}`);
}

function prepareCreateQuery (db: SqliteDb, tableName: string, columnNames: string[], onConflict: string = ''): SqliteStmt {
  return db.prepare(`INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (@${columnNames.join(', @')})${onConflict !== '' ? ' ' + onConflict : ''}`);
}

UserDatabase.prototype.close = function (this: UserDatabaseInstance): void {
  this.db.close();
};

UserDatabase.prototype.getEvents = function (this: UserDatabaseInstance, params: GetParams): DomainEvent[] | null {
  params.query.push({ type: 'equal', content: { field: 'deleted', value: null } });
  params.query.push({ type: 'equal', content: { field: 'headId', value: null } });
  const query = prepareEventsGetQuery(this.db, params);
  const page = boundedWalkPage(this, query);
  if (page != null) return page.map(eventsSchema.fromDB);
  const plan = query.bounded?.fallback ?? query;
  this.logger.debug(`GET events: ${plan.sql}`);
  const res = this.db.prepare(plan.sql).all(...plan.params);
  if (res != null) {
    return res.map(eventsSchema.fromDB);
  }
  return null;
};

UserDatabase.prototype.getEventsStreamed = function (this: UserDatabaseInstance, params: GetParams): NodeReadable {
  params.query.push({ type: 'equal', content: { field: 'deleted', value: null } });
  params.query.push({ type: 'equal', content: { field: 'headId', value: null } });
  const query = prepareEventsGetQuery(this.db, params);
  const page = boundedWalkPage(this, query);
  if (page != null) return readableEventsStreamForIterator(page[Symbol.iterator]());
  const plan = query.bounded?.fallback ?? query;
  this.logger.debug(`GET events streamed: ${plan.sql}`);
  return readableEventsStreamForIterator(this.db.prepare(plan.sql).iterate(...plan.params));
};

/**
 * Runs the bounded walk of `query` (see `walksTimeIndex`): its rows when the
 * page is full, which makes it the exact answer; null when there is no
 * bounded walk, or when it fell short (the caller then runs the fallback).
 * The page holds at most `limit` rows, read at once.
 */
function boundedWalkPage (udb: UserDatabaseInstance, query: EventsGetQuery): EventRow[] | null {
  if (query.bounded == null) return null;
  udb.logger.debug(`GET events (bounded walk): ${query.sql}`);
  const rows = udb.db.prepare(query.sql).all(...query.params);
  return rows.length >= query.bounded.limit ? rows : null;
}

/**
 * Reads the base table, where the column indexes apply. Reading `events_fts`
 * directly could use no index at all: every matching row was loaded and sorted
 * before `LIMIT`, synchronously, which blocked the worker for minutes on a
 * multi-GB audit file.
 *
 * - No stream filter: the planner walks the `time` index and stops at `LIMIT`.
 * - Stream filter: a rowid set from the full-text index (see `streamsQuery`),
 *   and `NOT INDEXED` so the rows are always read from that set (cost follows
 *   the matches). When the planner walks the `time` index instead, a stream
 *   holding few events costs a scan of the whole index (measured 128 ms vs
 *   0.1 ms on 500k rows); `NOT INDEXED` rules that plan out. Except for a
 *   small page of a filter many rows meet: see `walksTimeIndex`.
 * - `modifiedSince` with no stream filter: see `modifiedSincePlan`.
 *
 * `bounded`: the statement is a walk limited to the newest rows; it answers
 * only when it fills the page (`limit` rows), else `fallback` (the rowid set)
 * is run.
 */
function prepareEventsGetQuery (db: SqliteDb, params: GetParams): EventsGetQuery {
  let tail = prepareQuery(params);
  let fallback: SqlPart | null = null;
  if (tail.usesFullText) {
    const set = { ...tail, sql: 'SELECT * FROM events NOT INDEXED ' + tail.sql };
    const walk = walksTimeIndex(db, params);
    if (walk === false) return set;
    const query = params.query.map((q) => q.type === 'streamsQuery' ? { type: 'streamsQueryExact', content: q.content } : q);
    if (walk.from != null) {
      query.push({ type: 'greaterOrEqual', content: { field: 'time', value: walk.from } });
      fallback = set;
    }
    params = { ...params, query };
    tail = prepareQuery(params);
  }
  const plan = modifiedSincePlan(db, params);
  const planned = plan.params === params ? tail : prepareQuery(plan.params);
  // A bounded walk stays on the `time` index (not, say, a `type` index read
  // whole and sorted), unless the few rows modified since a bound are read.
  const indexedBy = fallback != null && plan.indexedBy === '' ? 'INDEXED BY events_time ' : plan.indexedBy;
  const statement = { ...planned, sql: 'SELECT * FROM events ' + indexedBy + planned.sql };
  if (fallback == null) return statement;
  return { ...statement, bounded: { fallback, limit: params.options?.limit as number } };
}

type EventsGetQuery = SqlPart & { usesFullText: boolean, bounded?: { fallback: SqlPart, limit: number } };

// Full-text candidates counted at most, to choose the plan of a stream filter.
let candidateProbeCap = 20_000;

/**
 * The rowid set reads every row the full-text index selects before `LIMIT`. A
 * filter most rows meet (an expanded `:_audit:accesses` on an audit log of
 * millions of rows) then reads them all for a page of 20: seconds, while the
 * worker waits (better-sqlite3 is synchronous). Walking the `time` index with
 * the exact condition reads about `page * rows / candidates` rows before it
 * stops when the matches are spread over time, but every newer row when they
 * are all old. Same rows either way (the full-text set only narrows the exact
 * condition). So, for a page sorted by time, count the candidates (capped):
 *
 * - At the cap the rowid set reads at least the cap: the walk is taken, whole
 *   (`from` null), when its estimate is not above the cap.
 * - Under the cap (newest first only), the rowid set reads `candidates` rows,
 *   growing with the stream (measured 4 ms at 2 400 candidates, 30 ms at
 *   18 000, against 0.3 ms for the walk when the matches are recent or spread).
 *   When the estimate is at most half the candidates, the walk is taken over
 *   the newest `budget` rows only (`from`: the time of the last of them, read
 *   on the `time` index alone); the caller falls back to the rowid set when
 *   that walk does not fill the page. A stream holding only old rows then
 *   costs the rowid set plus that bounded walk, not a scan of every newer row.
 *
 * @returns false for the rowid set, else the walk and its lower time bound
 */
function walksTimeIndex (db: SqliteDb, params: GetParams): false | { from: number | null } {
  const options = params.options ?? {};
  const limit = options.limit;
  if (!Number.isInteger(limit) || (limit as number) < 0) return false;
  const sort = Object.keys(options.sort ?? {});
  if (sort.length !== 1 || sort[0] !== 'time') return false;
  const items = params.query.filter((q) => q.type === 'streamsQuery');
  if (items.length !== 1) return false;
  const filter = toSQLiteStreamFilter(items[0].content as Parameters<typeof toSQLiteStreamFilter>[0]);
  if (filter?.fts == null) return false;
  const candidates = (db.prepare('SELECT count(*) AS n FROM (SELECT 1 FROM events_fts WHERE streamIds MATCH ? LIMIT ?)')
    .get(filter.fts, candidateProbeCap) as { n: number }).n;
  const rows = (db.prepare('SELECT max(rowid) AS n FROM events').get() as { n: number | null }).n ?? 0;
  const skip = Number.isInteger(options.skip) && (options.skip as number) > 0 ? options.skip as number : 0;
  const page = (limit as number) + skip;
  if (candidates >= candidateProbeCap) return page * rows <= candidates * candidateProbeCap ? { from: null } : false;
  if (!boundedWalk || candidates === 0 || (options.sort as Record<string, number>).time >= 0) return false;
  const estimate = Math.ceil(page * rows / candidates);
  const budget = Math.min(Math.floor(candidates / 2), 4 * estimate);
  if (budget < 1 || estimate > budget) return false;
  // The newest `budget` rows at or before `toTime`, any state: index only.
  const toTime = params.query.find((q) => q.type === 'lowerOrEqual' && (q.content as { field?: string })?.field === 'time');
  const bound = toTime == null
    ? db.prepare('SELECT time FROM events ORDER BY time DESC LIMIT 1 OFFSET ?').get(budget - 1)
    : db.prepare('SELECT time FROM events WHERE time <= ? ORDER BY time DESC LIMIT 1 OFFSET ?')
      .get(bindValue('time', (toTime.content as { value: unknown }).value), budget - 1);
  const from = (bound as { time: number | null } | undefined)?.time;
  return typeof from === 'number' ? { from } : false;
}

function _setCandidateProbeCap (cap: number): number {
  const previous = candidateProbeCap;
  candidateProbeCap = cap;
  return previous;
}

// Test hook: false keeps the rowid set under the cap (no bounded walk).
let boundedWalk = true;

function _setBoundedWalk (enabled: boolean): boolean {
  const previous = boundedWalk;
  boundedWalk = enabled;
  return previous;
}

// Above this many rows modified since the bound, the time index is walked.
let modifiedProbeCap = 20_000;

/**
 * Walking the `time` index stops at `LIMIT` only when the rows it meets pass
 * the filters. With `modified > X` where few rows are that recent (an
 * incremental export, its cursor below them), the walk read the whole index
 * and found nothing: 5 s on 1M rows from a cold file, once per page.
 *
 * So count the rows modified since the bound on the `modified` index (covering,
 * capped at `modifiedProbeCap` entries): under the cap they are read through
 * that index and sorted, which costs at most the cap; otherwise the condition
 * gets a unary `+` and the time index is walked as without `modifiedSince`.
 * Past the cap a page whose cursor lies below every recent row still walks the
 * index (the plan before this one); the cap bounds the sort of the other plan.
 * The caller's query is not changed.
 */
function modifiedSincePlan (db: SqliteDb, params: GetParams): { indexedBy: string, params: GetParams } {
  const item = (params.query || []).find((q) =>
    q.type === 'greater' && (q.content as { field?: string })?.field === 'modified');
  if (item == null) return { indexedBy: '', params };
  const content = item.content as { field: string, value: unknown };
  const row = db.prepare('SELECT count(*) AS n FROM (SELECT 1 FROM events WHERE modified > ? LIMIT ?)')
    .get(bindValue('modified', content.value), modifiedProbeCap) as { n: number };
  if (row.n < modifiedProbeCap) return { indexedBy: 'INDEXED BY events_modified ', params };
  const query = params.query.map((q) => q === item ? { type: 'greater', content: { ...content, noIndex: true } } : q);
  return { indexedBy: '', params: { ...params, query } };
}

function _setModifiedProbeCap (cap: number): number {
  const previous = modifiedProbeCap;
  modifiedProbeCap = cap;
  return previous;
}

UserDatabase.prototype.getEventDeletionsStreamed = function (this: UserDatabaseInstance, deletedSince: number, options?: DeletionsOptions | null): NodeReadable {
  this.logger.debug(`GET events deletions since: ${deletedSince}`);
  if (options?.sortAscending !== true && options?.limit == null && options?.skip == null) {
    return readableEventsStreamForIterator(this.eventQueries.getDeletedSince.iterate(deletedSince));
  }
  // Same bound (strict), order, limit and skip as the PostgreSQL engine; head
  // events only (history versions are never deletion records).
  let sql = `SELECT * from events WHERE headId IS NULL AND deleted > ? ORDER BY deleted ${options?.sortAscending === true ? 'ASC' : 'DESC'}`;
  const params: number[] = [deletedSince];
  if (options?.limit != null || options?.skip != null) { sql += ' LIMIT ?'; params.push(options?.limit ?? -1); }
  if (options?.skip != null) { sql += ' OFFSET ?'; params.push(options.skip); }
  return readableEventsStreamForIterator(this.db.prepare(sql).iterate(...params));
};

type DeletionsOptions = { sortAscending?: boolean; limit?: number | null; skip?: number | null };

// also see: https://nodejs.org/api/stream.html#stream_stream_readable_from_iterable_options
function readableEventsStreamForIterator (iterateSource: Iterator<EventRow>): NodeReadable {
  const iterateTransform: IterableIterator<DomainEvent> = {
    next: function (): IteratorResult<DomainEvent> {
      const res = iterateSource.next();
      if (res && res.value) {
        res.value = eventsSchema.fromDB(res.value);
      }
      return res;
    },
    /**
     * ⚑ Without this, destroying the readable never closes the underlying
     * statement iterator: `Readable.from` closes its iterator through
     * `return()` when one exists and does nothing otherwise, so an aborted read
     * left the iterator open forever.
     *
     * What that cost is worth being precise about. Writes were NOT blocked:
     * better-sqlite3 refuses them while an iterator is open, but user databases
     * run in `unsafeMode` (see `concurrentSafeWrite.ts`), which disables that
     * guard. `close()` however keeps the check whatever the mode, so a leaked
     * iterator made this user's handle unclosable, which is what account
     * deletion and the handle cache's eviction both need. The un-reset
     * statement also pins the WAL read mark, holding back checkpointing.
     */
    return: function (): IteratorResult<DomainEvent> {
      if (typeof iterateSource.return === 'function') iterateSource.return();
      return { value: undefined, done: true };
    },
    [Symbol.iterator]: function (): IterableIterator<DomainEvent> {
      return iterateTransform;
    }
  };

  return Readable.from(iterateTransform);
}

/**
 * The database of a user's audit trail: adds what only the audit lists, the
 * actions and accesses its records name. The user's own events use
 * `UserDatabase`, without them.
 */
function AuditUserDatabase (this: UserDatabaseInstance, logger: LoggerFactory, params: { dbPath: string }): void {
  UserDatabase.call(this, logger, params);
}
AuditUserDatabase.prototype = Object.create(UserDatabase.prototype);
AuditUserDatabase.prototype.constructor = AuditUserDatabase;

AuditUserDatabase.prototype.getAllActions = function (this: UserDatabaseInstance): EventRow[] {
  return this.eventQueries.getTerms.all('action-', 'action.'); // '.' follows '-'
};

AuditUserDatabase.prototype.getAllAccesses = function (this: UserDatabaseInstance): EventRow[] {
  return this.eventQueries.getTerms.all('access-', 'access.');
};

UserDatabase.prototype.getOneEvent = function (this: UserDatabaseInstance, eventId: string): DomainEvent | null {
  this.logger.debug(`GET one event: ${eventId}`);
  const event = this.eventQueries.getById.get(eventId);
  if (event == null) return null;
  return eventsSchema.fromDB(event);
};

UserDatabase.prototype.countEvents = function (this: UserDatabaseInstance): number {
  const res = this.db.prepare('SELECT count(*) as count FROM events').get();
  return (res?.count as number) || 0;
};

UserDatabase.prototype.createEvent = async function (this: UserDatabaseInstance, event: DomainEvent): Promise<void> {
  const dbEvent = eventsSchema.toDB(event);
  this.logger.debug(`(async) CREATE event: ${JSON.stringify(dbEvent)}`);
  await concurrentSafeWrite.execute(() => {
    insertRow(this, dbEvent, event.streamIds);
  });
};

// The row and its kept terms in one transaction: a retry after SQLITE_BUSY
// cannot insert the row twice.
function insertRow (udb: UserDatabaseInstance, row: EventRow, streamIds: unknown): void {
  const terms = termsOf(streamIds);
  if (terms.length === 0) {
    udb.eventQueries.create.run(row);
    return;
  }
  udb.db.transaction(() => {
    udb.eventQueries.create.run(row);
    for (const term of terms) udb.eventQueries.addTerm.run(term);
  })();
}

/** `insertRow`, except that a row whose id is already stored is skipped (only that conflict: any other constraint still throws). */
function insertRowIfAbsent (udb: UserDatabaseInstance, row: EventRow, streamIds: unknown): void {
  const terms = termsOf(streamIds);
  const create = udb.eventQueries.createIfAbsent ??= prepareCreateQuery(udb.db, 'events', Object.keys(tableSchemas.events), 'ON CONFLICT (eventid) DO NOTHING');
  udb.db.transaction(() => {
    if (create.run(row).changes === 0) return;
    for (const term of terms) udb.eventQueries.addTerm.run(term);
  })();
}

/**
 * Use only in tests or migration
 * Not safe within a multi-process environement
 */
UserDatabase.prototype.createEventSync = function (this: UserDatabaseInstance, event: DomainEvent): void {
  const dbEvent = eventsSchema.toDB(event);
  this.logger.debug(`(sync) CREATE event: ${JSON.stringify(dbEvent)}`);
  insertRow(this, dbEvent, event.streamIds);
};

/**
 * @param onlyIfNotTrashed compare-and-set: apply only while the event is still
 *   untrashed, so exactly one of N concurrent callers can flip it. Returns null
 *   for the losers.
 */
UserDatabase.prototype.updateEvent = async function (this: UserDatabaseInstance, eventId: string, eventData: DomainEvent, onlyIfNotTrashed?: boolean): Promise<DomainEvent | null> {
  const dbEvent = eventsSchema.toDB(eventData);
  if (dbEvent.streamIds == null) { dbEvent.streamIds = eventsSchema.ALL_EVENTS_TAG; }

  delete dbEvent.eventid;
  const casClause = onlyIfNotTrashed ? ' AND (trashed IS NULL OR trashed = 0)' : '';
  const queryString = `UPDATE events SET ${Object.keys(dbEvent).map(field => `${field} = @${field}`).join(', ')} WHERE eventid = @eventid${casClause}`;
  dbEvent.eventid = eventId;
  const update = this.db.prepare(queryString);

  let updated = false;
  await concurrentSafeWrite.execute(() => {
    const res = update.run(dbEvent);
    this.logger.debug(`UPDATE events changes: ${res.changes} eventId: ${eventId} event: ${JSON.stringify(dbEvent)}`);
    updated = res.changes === 1;
  });

  // PG's localUserEventsPG.update returns `res.rowCount === 1` (boolean,
  // never throws on 0 rows). Match that semantics so cleanup paths that
  // chain update-after-delete don't get spurious "Event not found" 500s.
  if (!updated) return null;
  return eventsSchema.fromDB(dbEvent);
};

/**
 * Read-merge-write in one immediate transaction: `fn` receives the event as
 * stored now and returns the event to write (plus an optional history item),
 * or null to write nothing. The body never yields, so no other writer of this
 * file, in this process or another, can land between the read and the write.
 * @returns the written event, null when `fn` returned null, false when the
 *   event does not exist
 */
UserDatabase.prototype.updateEventAtomic = async function (this: UserDatabaseInstance, eventId: string, fn: (stored: DomainEvent) => { next: DomainEvent, versionItem?: DomainEvent } | null): Promise<DomainEvent | null | false> {
  let out: DomainEvent | null | false = null;
  const run = this.db.transaction(() => {
    const row = this.eventQueries.getById.get(eventId);
    if (row == null) { out = false; return; }
    const res = fn(eventsSchema.fromDB(row));
    if (res == null) { out = null; return; }
    if (res.versionItem != null) this.eventQueries.create.run(eventsSchema.toDB(res.versionItem));
    const dbEvent = eventsSchema.toDB(res.next);
    if (dbEvent.streamIds == null) { dbEvent.streamIds = eventsSchema.ALL_EVENTS_TAG; }
    delete dbEvent.eventid;
    const queryString = `UPDATE events SET ${Object.keys(dbEvent).map(field => `${field} = @${field}`).join(', ')} WHERE eventid = @eventid`;
    dbEvent.eventid = eventId;
    this.db.prepare(queryString).run(dbEvent);
    out = eventsSchema.fromDB(dbEvent);
  });
  // A retry after SQLITE_BUSY re-runs the whole (rolled back) transaction.
  await concurrentSafeWrite.execute(() => { run.immediate(); });
  return out;
};

UserDatabase.prototype.getEventHistory = function (this: UserDatabaseInstance, eventId: string): DomainEvent[] {
  this.logger.debug(`GET event history for: ${eventId}`);
  return this.eventQueries.getHistory.all(eventId).map(eventsSchema.fromDBHistory);
};

/**
 * Up to `limit` event rows in any state (trashed and deleted included, version
 * rows excluded) whose id sorts after `afterId`, in id order (keyset paging).
 * Read with `.all()`, so no statement stays open between pages.
 */
UserDatabase.prototype.getAllStatesPage = function (this: UserDatabaseInstance, afterId: string | null, limit: number): DomainEvent[] {
  return this.db.prepare('SELECT * FROM events WHERE headId IS NULL AND eventid > ? ORDER BY eventid ASC LIMIT ?')
    .all(afterId ?? '', limit)
    .map(eventsSchema.fromDB);
};

const UNSTAMPED = '(created IS NULL OR createdBy IS NULL OR modified IS NULL OR modifiedBy IS NULL)';

/**
 * Up to `limit` event rows missing any tracking property, whose id sorts after
 * `afterId`, in id order (keyset paging). Deleted rows are excluded (the
 * deletion modes clear these columns on purpose), and so are version rows (no
 * supported write path addresses one; see `countUnstampedVersionRows`).
 */
UserDatabase.prototype.getUnstampedPage = function (this: UserDatabaseInstance, afterId: string | null, limit: number): DomainEvent[] {
  return this.db.prepare(`SELECT * FROM events WHERE headId IS NULL AND deleted IS NULL AND ${UNSTAMPED} AND eventid > ? ORDER BY eventid ASC LIMIT ?`)
    .all(afterId ?? '', limit)
    .map(eventsSchema.fromDB);
};

/** Number of version rows (history) missing any tracking property. */
UserDatabase.prototype.countUnstampedVersionRows = function (this: UserDatabaseInstance): number {
  const row = this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE headId IS NOT NULL AND ${UNSTAMPED}`).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
};

UserDatabase.prototype.minimizeEventHistory = async function (this: UserDatabaseInstance, eventId: string, fieldsToRemove: string[]): Promise<void> {
  const minimizeHistoryStatement = `UPDATE events SET ${fieldsToRemove.map(field => `${field} = ${field === 'streamIds' ? '\'' + eventsSchema.ALL_EVENTS_TAG + '\'' : 'NULL'}`).join(', ')} WHERE headId = ?`;
  this.logger.debug(`(async) Minimize event history: ${minimizeHistoryStatement}`);
  await concurrentSafeWrite.execute(() => {
    this.db.prepare(minimizeHistoryStatement).run(eventId);
  });
};

UserDatabase.prototype.deleteEventHistory = async function (this: UserDatabaseInstance, eventId: string): Promise<void> {
  this.logger.debug(`(async) DELETE event history for event id: ${eventId}`);
  await concurrentSafeWrite.execute(() => {
    return this.eventQueries.deleteByHeadId.run(eventId);
  });
};

UserDatabase.prototype.deleteEvents = async function (this: UserDatabaseInstance, params: GetParams): Promise<{ changes: number } | null> {
  const query = prepareEventsDeleteQuery(params);
  if (query.usesFullText) {
    this.logger.debug(`DELETE events one by one as the query reads the full-text index: ${query.sql}`);
    // HACK: SQLite does not know how to delete with "MATCH" statement,
    //       so we're getting events that match and deleting them one by one
    const selected = prepareEventsGetQuery(this.db, params);
    const selectEventsToBeDeleted = selected.bounded?.fallback ?? selected;

    for (const event of this.db.prepare(selectEventsToBeDeleted.sql).iterate(...selectEventsToBeDeleted.params) as Iterable<{ eventid: string }>) {
      this.logger.debug(`  > DELETE event: ${event.eventid}`);
      await concurrentSafeWrite.execute(() => {
        this.eventQueries.deleteById.run(event.eventid);
      });
    }
    await rebuildTerms(this);
    return null;
  }
  // else
  let res: { changes: number } | null = null;
  this.logger.debug(`DELETE events: ${query.sql}`);
  await concurrentSafeWrite.execute(() => {
    res = this.db.prepare(query.sql).run(...query.params);
  });
  if ((res as { changes: number } | null)?.changes) await rebuildTerms(this);
  return res;
};

// -- Audit summary --

// At most this many rows of the range are aggregated per synchronous window by `summarize`.
let summaryChunkRows = 10_000;

/** Test hook: sets the window size of `summarize`, returns the previous one. */
function _setSummaryChunkRows (rows: number): number {
  const previous = summaryChunkRows;
  summaryChunkRows = rows;
  return previous;
}

/** Test hook: windows run by `summarize` since the module was loaded. */
const _summaryCounters = { windows: 0 };

// `floor(time / slot)`: CAST truncates toward zero, the comparison corrects
// negative non-integral quotients, so the slots are the PostgreSQL engine's.
const SUMMARY_SLOT = 'CAST(time / @slot AS INTEGER) - (CAST(time / @slot AS INTEGER) * @slot > time)';
const SUMMARY_SELECT = `SELECT ${SUMMARY_SLOT} AS slot, json_extract(content, '$.action') AS action, (type = @errorType) AS error`;
// The window's rows, head and non-deleted; the unary `+` keeps the planner on
// the `time` index.
const SUMMARY_WINDOW = ' FROM events WHERE time >= @start AND time < @end AND +headId IS NULL AND +deleted IS NULL';

type SummaryRow = { slot: number, action: unknown, error: number | null, count: number, terms?: string | null };

/**
 * Grouped counts for the audit summary (see the audit storage contract).
 *
 * Never one statement over the whole range: better-sqlite3 is synchronous, so
 * a statement over millions of rows would block the worker. The rows of the
 * range are aggregated in windows of about `summaryChunkRows` on the `time`
 * index, yielding to the event loop between windows and checking the
 * deadline before each one; the groups of successive windows are merged here.
 * A probe (index only) finds the window end strictly above the cursor, so
 * equal times cannot stall it. The work follows the rows of the range, with or
 * without a stream filter. After each yield the handle is checked: a store
 * closed meanwhile (cache eviction, account deletion, restore) gives the
 * interruption error, never a statement on a closed handle.
 *
 * Stream filter: the full-text index is not read. The aggregate also groups
 * by the row's stored stream ids, and a group is kept when one of its
 * space-separated terms equals a requested id, letter case included. The ids
 * never reach SQLite. This is the exact, case-sensitive match `events.get`
 * applies on this engine (stored ids compared whole; the validator admits
 * printable ASCII ids only, holding a letter or a digit), so the summary
 * counts exactly the rows `events.get` lists for the same ids. A filter
 * that is missing or unreadable answers no groups.
 */
UserDatabase.prototype.summarize = async function (this: UserDatabaseInstance, params: SummarizeParams): Promise<SummaryGroup[]> {
  const filter: string[] | null | false = summaryAccessFilter(params.accessStreamIds);
  if (filter === false) return [];
  const wanted = filter === null ? null : new Set(filter);
  const binds = { slot: params.slotSeconds, errorType: SUMMARY_ERROR_TYPE };
  const groups = new Map<string, SummaryGroup>();
  const merge = (rows: SummaryRow[]): void => {
    for (const row of rows) {
      if (wanted !== null && !(row.terms != null && row.terms.split(' ').some((term) => wanted.has(term)))) continue;
      const action = row.action == null ? null : String(row.action);
      const error = row.error === 1;
      const key = row.slot + '|' + error + '|' + (action === null ? '' : '=' + action);
      const group = groups.get(key);
      if (group != null) group.count += Number(row.count);
      else groups.set(key, { slot: Number(row.slot), action, error, count: Number(row.count) });
    }
  };
  const checkDeadline = (): void => {
    if (params.deadline != null && Date.now() >= params.deadline) throw summaryBudgetError();
  };
  const offset = Math.max(summaryChunkRows - 1, 0);
  const db = this.db;
  // The handle may already be closed when it is handed out (evicted or the
  // account deleted while it was being resolved).
  if (!db.open) throw summaryInterruptedError();

  const probe = db.prepare('SELECT time FROM events WHERE time > @cursor AND time < @to ORDER BY time LIMIT 1 OFFSET @offset');
  const aggregate = db.prepare(wanted === null
    ? SUMMARY_SELECT + ', count(*) AS count' + SUMMARY_WINDOW + ' GROUP BY 1, 2, 3'
    : SUMMARY_SELECT + ', streamIds AS terms, count(*) AS count' + SUMMARY_WINDOW + ' GROUP BY 1, 2, 3, 4');
  let cursor = params.fromTime;
  for (;;) {
    checkDeadline();
    _summaryCounters.windows++;
    const next = probe.get({ cursor, to: params.toTime, offset }) as { time: number } | undefined;
    const end = next == null ? params.toTime : next.time;
    merge(aggregate.all({ ...binds, start: cursor, end }) as SummaryRow[]);
    if (next == null) break;
    cursor = end;
    await new Promise(setImmediate);
    if (!db.open) throw summaryInterruptedError();
  }
  return [...groups.values()];
};

// -- Migration methods --

/**
 * Export all raw event rows from the database.
 */
UserDatabase.prototype.exportAllEvents = function (this: UserDatabaseInstance): EventRow[] {
  return this.eventQueries.getAll.all();
};

/**
 * Stream all raw event rows from the database, one at a time, for backup.
 * Async generator so every export producer presents a uniform AsyncIterable;
 * it wraps better-sqlite3's `.iterate()`, whose read lock is released when the
 * consumer exhausts or breaks out of the iteration (the generator forwards
 * `return()` to the inner iterator). Memory stays O(1) in the row count.
 */
UserDatabase.prototype.exportAllEventsStreamed = async function * (this: UserDatabaseInstance): AsyncGenerator<EventRow> {
  for (const row of this.eventQueries.getAll.iterate()) {
    yield row;
  }
};

/**
 * Import raw event rows into the database. A row whose id is already there
 * makes the import throw (the restore of the account then fails and is
 * cleaned up).
 */
UserDatabase.prototype.importAllEvents = async function (this: UserDatabaseInstance, events: EventRow[]): Promise<void> {
  await importRows(this, events, false);
};

/**
 * Import raw audit rows. A row whose id is already there is skipped, the
 * stored one kept (as the PostgreSQL engine does): a restore onto a trail
 * kept after an erasure adds the backup's rows it lacks.
 */
AuditUserDatabase.prototype.importAllEvents = async function (this: UserDatabaseInstance, events: EventRow[]): Promise<void> {
  await importRows(this, events, true);
};

async function importRows (udb: UserDatabaseInstance, events: EventRow[], skipExisting: boolean): Promise<void> {
  for (const event of events) {
    await concurrentSafeWrite.execute(() => {
      if (skipExisting) insertRowIfAbsent(udb, event, event.streamIds);
      else insertRow(udb, event, event.streamIds);
    });
  }
}

function prepareEventsDeleteQuery (params: GetParams): SqlPart & { usesFullText: boolean } {
  if (params.streams) { throw new Error(`Events DELETE with stream query not supported yet: ${JSON.stringify(params)}`); }
  const tail = prepareQuery(params, true);
  return { ...tail, sql: 'DELETE FROM events ' + tail.sql };
}

/**
 * A column of the events table, for the SQL text: never a value. Anything
 * else is refused (column names cannot be bound).
 */
function column (field: string): string {
  if (!Object.hasOwn(eventsSchema.dbSchema, field)) throw new Error(`Unknown events column: ${JSON.stringify(field)}`);
  return field;
}

/** The value bound for `field`: text, a number, or 0 / 1. */
function bindValue (field: string, value: unknown): unknown {
  switch (eventsSchema.dbSchema[column(field)].coerce) {
    case 'num': {
      const n = typeof value === 'number' ? value : parseFloat(value as string);
      if (Number.isNaN(n)) throw new Error(`Not a number for events column ${field}: ${JSON.stringify(value)}`);
      return n;
    }
    case 'bool': return value ? 1 : 0;
    default: return String(value);
  }
}

// Every value is a bound parameter (`?`); the SQL text holds column names
// (checked by `column`), operators and constants only.
// `usesFullText`: the condition selects its rows through the full-text index
// (the statement then reads the rows of that set, see `prepareEventsGetQuery`).
const converters: Record<string, (content: unknown) => (SqlPart & { usesFullText?: boolean }) | null> = {
  equal: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    const realField = column((c.field === 'id') ? 'eventid' : c.field);
    // Unary `+` keeps the planner off an index for conditions nearly every row
    // meets (not deleted, head version, not trashed). Without statistics it
    // picked those indexes, then scanned and sorted the whole table before
    // `LIMIT`, instead of walking the `time` index and stopping at the limit.
    // `trashed = 1` keeps its index: few rows are trashed, so it is selective.
    const nonSelective = (c.value === null && (realField === 'deleted' || realField === 'headId')) ||
      (realField === 'trashed' && c.value === false);
    const col = nonSelective ? '+' + realField : realField;
    if (c.value === null) return { sql: `${col} IS NULL`, params: [] };
    return { sql: `${col} = ?`, params: [bindValue(realField, c.value)] };
  },
  greater: (content: unknown) => {
    const c = content as { field: string, value: unknown, noIndex?: boolean };
    return { sql: `${c.noIndex === true ? '+' : ''}${column(c.field)} > ?`, params: [bindValue(c.field, c.value)] };
  },
  greaterOrEqual: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    return { sql: `${column(c.field)} >= ?`, params: [bindValue(c.field, c.value)] };
  },
  lowerOrEqual: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    return { sql: `${column(c.field)} <= ?`, params: [bindValue(c.field, c.value)] };
  },
  greaterOrEqualOrNull: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    const col = column(c.field);
    return { sql: `(${col} >= ? OR ${col} IS NULL)`, params: [bindValue(c.field, c.value)] };
  },
  typesList: (content: unknown) => {
    const list = content as string[];
    if (list.length === 0) return null;
    const params: unknown[] = [];
    const lt = list.map((type: string) => {
      const text = String(type);
      // unsupported "*" query for types
      const starPos = text.indexOf('/*');
      if (starPos > 0) {
        // Keep the slash: `note/*` matches `note/...`, never `notebook/...`.
        params.push(escapeLike(text.substring(0, starPos + 1)) + '%');
        return "type LIKE ? ESCAPE '!'";
      }
      params.push(text);
      return 'type = ?';
    });
    return { sql: '(' + lt.join(' OR ') + ')', params };
  },
  streamsQuery: (content: unknown) => {
    const filter = toSQLiteStreamFilter(content as Parameters<typeof toSQLiteStreamFilter>[0]);
    if (filter === null) return null;
    if (filter.fts === null) return filter.exact;
    return {
      sql: `rowid IN (SELECT rowid FROM events_fts WHERE streamIds MATCH ?) AND ${filter.exact.sql}`,
      params: [filter.fts, ...filter.exact.params],
      usesFullText: true
    };
  },
  // The same condition without the full-text set (see `walksTimeIndex`).
  streamsQueryExact: (content: unknown) => {
    const filter = toSQLiteStreamFilter(content as Parameters<typeof toSQLiteStreamFilter>[0]);
    return filter === null ? null : filter.exact;
  },
  jsonCondition: (content: unknown) => {
    return jsonConditionToSql(content as NormalizedCondition);
  }
};

/** `%`, `_` and the escape character `!` match themselves in a `LIKE … ESCAPE '!'` pattern. */
function escapeLike (text: string): string {
  return text.replace(/[!%_]/g, (m) => '!' + m);
}

/**
 * Translate a normalized content/clientData condition to SQL.
 * Matching is strict on JSON types (semantics defined by the reference
 * matcher in storages/shared/contentQueryConditions.ts): `json_type()`
 * guards keep JSON `true` from matching `1` (json_extract maps both to 1)
 * and keep array/object values out of scalar comparisons. The JSON path and
 * every value are bound parameters.
 */
function jsonConditionToSql (condition: NormalizedCondition): SqlPart {
  const col = condition.field === 'clientData' ? 'clientData' : 'content';
  // Segments are grammar-validated ([a-zA-Z0-9_:-]); quoted in the path so
  // ':' and '-' never need json-path escaping rules.
  const jsonPath = condition.path === null
    ? '$'
    : '$' + condition.path.map((segment) => `."${segment}"`).join('');
  const params: unknown[] = [];
  // Each call writes one placeholder and binds its value, in text order.
  const jx = (): string => { params.push(jsonPath); return `json_extract(${col}, ?)`; };
  const jt = (): string => { params.push(jsonPath); return `json_type(${col}, ?)`; };
  const bind = (value: unknown): string => { params.push(value); return '?'; };
  const list = (values: unknown[]): string => values.map(bind).join(', ');

  const eqSql = (value: ScalarValue): string => {
    if (typeof value === 'boolean') return `${jt()} = '${value ? 'true' : 'false'}'`;
    if (typeof value === 'number') return `(${jt()} IN ('integer', 'real') AND ${jx()} = ${bind(value)})`;
    return `(${jt()} = 'text' AND ${jx()} = ${bind(value)})`;
  };

  const sql = ((): string => {
    switch (condition.op) {
      case 'eq':
        return eqSql(condition.value as ScalarValue);
      case 'neq': {
        const present = `${jt()} IS NOT NULL`;
        return `(${present} AND NOT ${eqSql(condition.value as ScalarValue)})`;
      }
      case 'in': {
        const values = condition.value as ScalarValue[];
        const strings = values.filter((v): v is string => typeof v === 'string');
        const numbers = values.filter((v): v is number => typeof v === 'number');
        const booleans = values.filter((v): v is boolean => typeof v === 'boolean');
        const groups: string[] = [];
        if (strings.length > 0) groups.push(`(${jt()} = 'text' AND ${jx()} IN (${list(strings)}))`);
        if (numbers.length > 0) groups.push(`(${jt()} IN ('integer', 'real') AND ${jx()} IN (${list(numbers)}))`);
        if (booleans.includes(true) && booleans.includes(false)) groups.push(`${jt()} IN ('true', 'false')`);
        else if (booleans.length > 0) groups.push(`${jt()} = '${booleans[0] ? 'true' : 'false'}'`);
        return groups.length === 1 ? groups[0] : `(${groups.join(' OR ')})`;
      }
      case 'exists':
        return `${jt()} IS ${condition.value === true ? 'NOT ' : ''}NULL`;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const sqlOp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[condition.op];
        return `(${jt()} IN ('integer', 'real') AND ${jx()} ${sqlOp} ${bind(condition.value as number)})`;
      }
      case 'prefix':
        return `(${jt()} = 'text' AND ${jx()} LIKE ${bind(escapeLike(condition.value as string) + '%')} ESCAPE '!')`;
      default:
        throw new Error(`Unsupported JSON condition operator: ${(condition as { op: string }).op}`);
    }
  })();
  return { sql, params };
}

/**
 * The `WHERE` / `ORDER BY` / `LIMIT` / `OFFSET` tail of an events statement
 * and its bound values. `usesFullText`: the condition reads `events_fts`.
 */
function prepareQuery (params: GetParams = { query: [] }, isDelete = false): SqlPart & { usesFullText: boolean } {
  const ands: string[] = [];
  const values: unknown[] = [];
  let usesFullText = false;
  for (const item of params.query) {
    const newCondition = converters[item.type](item.content);
    if (newCondition != null) {
      ands.push(newCondition.sql);
      values.push(...newCondition.params);
      if (newCondition.usesFullText === true) usesFullText = true;
    }
  }

  let queryString = '';
  if (ands.length > 0) {
    queryString += ' WHERE ' + ands.join(' AND ');
  }

  if (!isDelete) {
    const sort = params.options?.sort;
    if (sort) {
      const sorts: string[] = [];
      for (const [field, order] of Object.entries(sort)) {
        const orderStr = order > 0 ? 'ASC' : 'DESC';
        sorts.push(`${column(field)} ${orderStr}`);
      }
      queryString += ' ORDER BY ' + sorts.join(', ');
    }
  }

  const paging = pagingClause(params.options?.limit, params.options?.skip);
  return { sql: queryString + paging.sql, params: [...values, ...paging.params], usesFullText };
}

/**
 * `LIMIT` / `OFFSET` as the PostgreSQL engine applies them: a given limit
 * (0 included) caps the rows, and an offset alone needs `LIMIT -1` (no limit),
 * since SQLite has no `OFFSET` without `LIMIT`. Only non-negative integers
 * are applied, bound.
 */
function pagingClause (limit: unknown, skip: unknown): SqlPart {
  const hasLimit = Number.isInteger(limit) && (limit as number) >= 0;
  const hasSkip = Number.isInteger(skip) && (skip as number) > 0;
  const part: SqlPart = { sql: '', params: [] };
  if (hasLimit || hasSkip) { part.sql += ' LIMIT ?'; part.params.push(hasLimit ? limit : -1); }
  if (hasSkip) { part.sql += ' OFFSET ?'; part.params.push(skip); }
  return part;
}

export { UserDatabase, AuditUserDatabase, jsonConditionToSql, _setModifiedProbeCap, _setCandidateProbeCap, _setBoundedWalk, _setSummaryChunkRows, _summaryCounters };
