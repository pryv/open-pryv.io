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

// EventRow equals the canonical SqliteStmt's default row shape, so the
// shared statement type applies unparameterized.
import type { SqliteDb, SqliteStmt } from '../types.ts';
const require = createRequire(import.meta.url);

const SQLite3 = require('better-sqlite3');
const { Readable } = require('stream');

const concurrentSafeWrite = require('../concurrentSafeWrite.ts');
const eventsSchema = require('./schema/events.ts');
const fullTextSearch = require('./fullTextSearch.ts');
const { toSQLiteQuery } = require('./streamQueryUtils.ts');

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
  getById: SqliteStmt,
  getDeletedSince: SqliteStmt,
  getHistory: SqliteStmt,
  create: SqliteStmt,
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
  // A range on `term` narrows the vocabulary scan; `LIKE 'prefix%'` read every term.
  this.eventQueries.getTerms = this.db.prepare('SELECT * FROM events_fts_v WHERE term >= ? AND term < ?');

  // Head events only: a history version is a row of its own (headId set), never
  // addressed by its own id (same as the PostgreSQL engine's `head_id IS NULL`).
  this.eventQueries.getById = this.db.prepare('SELECT * FROM events WHERE eventid = ? AND headId IS NULL');
  this.eventQueries.getDeletedSince = this.db.prepare('SELECT * from events WHERE headId IS NULL AND deleted > ? ORDER BY deleted DESC');
  this.eventQueries.getHistory = this.db.prepare('SELECT * from events WHERE headId = ? ORDER BY modified ASC');

  this.eventQueries.create = prepareCreateQuery(this.db, 'events', Object.keys(tableSchemas.events));

  this.eventQueries.deleteByHeadId = this.db.prepare('DELETE FROM events WHERE headId = ?');
  this.eventQueries.deleteById = this.db.prepare('DELETE FROM events WHERE eventid = ?');
};

function prepareGetAllQuery (db: SqliteDb, tableName: string): SqliteStmt {
  return db.prepare(`SELECT * FROM ${tableName}`);
}

function prepareCreateQuery (db: SqliteDb, tableName: string, columnNames: string[]): SqliteStmt {
  return db.prepare(`INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (@${columnNames.join(', @')})`);
}

UserDatabase.prototype.close = function (this: UserDatabaseInstance): void {
  this.db.close();
};

UserDatabase.prototype.getEvents = function (this: UserDatabaseInstance, params: GetParams): DomainEvent[] | null {
  params.query.push({ type: 'equal', content: { field: 'deleted', value: null } });
  params.query.push({ type: 'equal', content: { field: 'headId', value: null } });
  const queryString = prepareEventsGetQuery(params);
  this.logger.debug(`GET events: ${queryString}`);
  const res = this.db.prepare(queryString).all();
  if (res != null) {
    return res.map(eventsSchema.fromDB);
  }
  return null;
};

UserDatabase.prototype.getEventsStreamed = function (this: UserDatabaseInstance, params: GetParams): NodeReadable {
  params.query.push({ type: 'equal', content: { field: 'deleted', value: null } });
  params.query.push({ type: 'equal', content: { field: 'headId', value: null } });
  const queryString = prepareEventsGetQuery(params);
  this.logger.debug(`GET events streamed: ${queryString}`);
  const query = this.db.prepare(queryString);
  return readableEventsStreamForIterator(query.iterate());
};

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
 *   0.1 ms on 500k rows); `NOT INDEXED` rules that plan out.
 */
function prepareEventsGetQuery (params: GetParams): string {
  const hasStreamFilter = (params.query || []).some((item) =>
    item.type === 'streamsQuery' && toSQLiteQuery(item.content as Parameters<typeof toSQLiteQuery>[0]) !== null);
  return 'SELECT * FROM events ' + (hasStreamFilter ? 'NOT INDEXED ' : '') + prepareQuery(params);
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

UserDatabase.prototype.getAllActions = function (this: UserDatabaseInstance): EventRow[] {
  return this.eventQueries.getTerms.all('action-', 'action.'); // '.' follows '-'
};

UserDatabase.prototype.getAllAccesses = function (this: UserDatabaseInstance): EventRow[] {
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
    this.eventQueries.create.run(dbEvent);
  });
};

/**
 * Use only in tests or migration
 * Not safe within a multi-process environement
 */
UserDatabase.prototype.createEventSync = function (this: UserDatabaseInstance, event: DomainEvent): void {
  const dbEvent = eventsSchema.toDB(event);
  this.logger.debug(`(sync) CREATE event: ${JSON.stringify(dbEvent)}`);
  this.eventQueries.create.run(dbEvent);
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
  const queryString = prepareEventsDeleteQuery(params);
  if (queryString.indexOf('MATCH') > 0) {
    this.logger.debug(`DELETE events one by one as query includes "MATCH": ${queryString}`);
    // HACK: SQLite does not know how to delete with "MATCH" statement,
    //       so we're getting events that match and deleting them one by one
    const selectEventsToBeDeleted = prepareEventsGetQuery(params);

    for (const event of this.db.prepare(selectEventsToBeDeleted).iterate() as Iterable<{ eventid: string }>) {
      this.logger.debug(`  > DELETE event: ${event.eventid}`);
      await concurrentSafeWrite.execute(() => {
        this.eventQueries.deleteById.run(event.eventid);
      });
    }
    return null;
  }
  // else
  let res: { changes: number } | null = null;
  this.logger.debug(`DELETE events: ${queryString}`);
  await concurrentSafeWrite.execute(() => {
    res = this.db.prepare(queryString).run();
  });
  return res;
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
 * Import raw event rows into the database.
 */
UserDatabase.prototype.importAllEvents = async function (this: UserDatabaseInstance, events: EventRow[]): Promise<void> {
  for (const event of events) {
    await concurrentSafeWrite.execute(() => {
      this.eventQueries.create.run(event);
    });
  }
};

function prepareEventsDeleteQuery (params: GetParams): string {
  if (params.streams) { throw new Error(`Events DELETE with stream query not supported yet: ${JSON.stringify(params)}`); }
  return 'DELETE FROM events ' + prepareQuery(params, true);
}

const converters: Record<string, (content: unknown) => string | null> = {
  equal: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    const realField = (c.field === 'id') ? 'eventid' : c.field;
    // Unary `+` keeps the planner off an index for conditions nearly every row
    // meets (not deleted, head version, not trashed). Without statistics it
    // picked those indexes, then scanned and sorted the whole table before
    // `LIMIT`, instead of walking the `time` index and stopping at the limit.
    // `trashed = 1` keeps its index: few rows are trashed, so it is selective.
    const nonSelective = (c.value === null && (realField === 'deleted' || realField === 'headId')) ||
      (realField === 'trashed' && c.value === false);
    const column = nonSelective ? '+' + realField : realField;
    if (c.value === null) return `${column} IS NULL`;
    const value = eventsSchema.coerceValueForColumn(realField, c.value);
    return `${column} = ${value}`;
  },
  greater: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    const value = eventsSchema.coerceValueForColumn(c.field, c.value);
    return `${c.field} > ${value}`;
  },
  greaterOrEqual: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    const value = eventsSchema.coerceValueForColumn(c.field, c.value);
    return `${c.field} >= ${value}`;
  },
  lowerOrEqual: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    const value = eventsSchema.coerceValueForColumn(c.field, c.value);
    return `${c.field} <= ${value}`;
  },
  greaterOrEqualOrNull: (content: unknown) => {
    const c = content as { field: string, value: unknown };
    const value = eventsSchema.coerceValueForColumn(c.field, c.value);
    return `(${c.field} >= ${value} OR ${c.field} IS NULL)`;
  },
  typesList: (content: unknown) => {
    const list = content as string[];
    if (list.length === 0) return null;
    const lt = list.map((type: string) => {
      const typeCorced = eventsSchema.coerceValueForColumn('type', type);
      // unsupported "*" query for types
      const starPos = typeCorced.indexOf('/*');
      if (starPos > 0) {
        // Keep the slash: `note/*` matches `note/...`, never `notebook/...`.
        const classWithSlash = typeCorced.substring(0, starPos + 1);
        return `type LIKE ${classWithSlash}%'`;
      }
      return `type = ${typeCorced}`;
    });
    return '(' + lt.join(' OR ') + ')';
  },
  streamsQuery: (content: unknown) => {
    const str = toSQLiteQuery(content);
    if (str === null) return null;
    // The expression is an SQL string literal: a single quote inside it is doubled.
    return 'rowid IN (SELECT rowid FROM events_fts WHERE streamIds MATCH \'' + str.replace(/'/g, "''") + '\')';
  },
  jsonCondition: (content: unknown) => {
    return jsonConditionToSql(content as NormalizedCondition);
  }
};

/**
 * Translate a normalized content/clientData condition to SQL.
 * Matching is strict on JSON types (semantics defined by the reference
 * matcher in storages/shared/contentQueryConditions.ts): `json_type()`
 * guards keep JSON `true` from matching `1` (json_extract maps both to 1)
 * and keep array/object values out of scalar comparisons.
 */
function jsonConditionToSql (condition: NormalizedCondition): string {
  const col = condition.field === 'clientData' ? 'clientData' : 'content';
  // Segments are grammar-validated ([a-zA-Z0-9_:-]) — always quote them so
  // ':' and '-' never need json-path escaping rules.
  const jsonPath = condition.path === null
    ? '$'
    : '$' + condition.path.map((segment) => `."${segment}"`).join('');
  const jx = `json_extract(${col}, '${jsonPath}')`;
  const jt = `json_type(${col}, '${jsonPath}')`;

  const eqSql = (value: ScalarValue): string => {
    if (typeof value === 'boolean') return `${jt} = '${value ? 'true' : 'false'}'`;
    if (typeof value === 'number') return `(${jt} IN ('integer', 'real') AND ${jx} = ${value})`;
    return `(${jt} = 'text' AND ${jx} = ${sqliteString(value)})`;
  };

  switch (condition.op) {
    case 'eq':
      return eqSql(condition.value as ScalarValue);
    case 'neq':
      return `(${jt} IS NOT NULL AND NOT ${eqSql(condition.value as ScalarValue)})`;
    case 'in': {
      const values = condition.value as ScalarValue[];
      const strings = values.filter((v): v is string => typeof v === 'string');
      const numbers = values.filter((v): v is number => typeof v === 'number');
      const booleans = values.filter((v): v is boolean => typeof v === 'boolean');
      const groups: string[] = [];
      if (strings.length > 0) groups.push(`(${jt} = 'text' AND ${jx} IN (${strings.map(sqliteString).join(', ')}))`);
      if (numbers.length > 0) groups.push(`(${jt} IN ('integer', 'real') AND ${jx} IN (${numbers.join(', ')}))`);
      if (booleans.includes(true) && booleans.includes(false)) groups.push(`${jt} IN ('true', 'false')`);
      else if (booleans.length > 0) groups.push(`${jt} = '${booleans[0] ? 'true' : 'false'}'`);
      return groups.length === 1 ? groups[0] : `(${groups.join(' OR ')})`;
    }
    case 'exists':
      return `${jt} IS ${condition.value === true ? 'NOT ' : ''}NULL`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const sqlOp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[condition.op];
      return `(${jt} IN ('integer', 'real') AND ${jx} ${sqlOp} ${condition.value as number})`;
    }
    case 'prefix': {
      const escaped = (condition.value as string).replace(/[!%_]/g, (m) => '!' + m);
      return `(${jt} = 'text' AND ${jx} LIKE ${sqliteString(escaped + '%')} ESCAPE '!')`;
    }
    default:
      throw new Error(`Unsupported JSON condition operator: ${(condition as { op: string }).op}`);
  }
}

/** Proper SQLite string literal ('' doubling — backslash is NOT an escape in SQL). */
function sqliteString (value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function prepareQuery (params: GetParams = { query: [] }, isDelete = false): string {
  const ands: string[] = [];
  for (const item of params.query) {
    const newCondition = converters[item.type](item.content);
    if (newCondition != null) {
      ands.push(newCondition);
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
        sorts.push(`${field} ${orderStr}`);
      }
      queryString += ' ORDER BY ' + sorts.join(', ');
    }
  }

  queryString += pagingClause(params.options?.limit, params.options?.skip);
  return queryString;
}

/**
 * `LIMIT` / `OFFSET` as the PostgreSQL engine applies them: a given limit
 * (0 included) caps the rows, and an offset alone needs `LIMIT -1` (no limit),
 * since SQLite has no `OFFSET` without `LIMIT`. Only non-negative integers
 * reach the SQL text.
 */
function pagingClause (limit: unknown, skip: unknown): string {
  const hasLimit = Number.isInteger(limit) && (limit as number) >= 0;
  const hasSkip = Number.isInteger(skip) && (skip as number) > 0;
  let clause = '';
  if (hasLimit) clause += ' LIMIT ' + limit;
  else if (hasSkip) clause += ' LIMIT -1';
  if (hasSkip) clause += ' OFFSET ' + skip;
  return clause;
}

export { UserDatabase, jsonConditionToSql };
