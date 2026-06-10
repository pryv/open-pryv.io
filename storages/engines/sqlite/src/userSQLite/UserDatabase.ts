/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
import type { Readable as NodeReadable } from 'node:stream';
const require = createRequire(import.meta.url);

const SQLite3 = require('better-sqlite3');
const { Readable } = require('stream');

const concurrentSafeWrite = require('../concurrentSafeWrite.ts');
const eventsSchema = require('./schema/events.ts');
const fullTextSearch = require('./fullTextSearch.ts');
const { toSQLiteQuery } = require('./streamQueryUtils.ts');

// ---- Types ----

/** A raw events-table row (and the fromDB-converted event). The precise
 *  domain Event type is the strongly-typed-interface-IO follow-up; here both
 *  sides of the eventsSchema boundary are arbitrary records. */
type EventRow = Record<string, unknown>;
type DomainEvent = Record<string, unknown>;

type ColumnDef = { type: string, index?: boolean };
type TableSchema = Record<string, ColumnDef>;

type SqliteStmt = {
  all: (...params: unknown[]) => EventRow[],
  get: (...params: unknown[]) => EventRow | undefined,
  run: (...params: unknown[]) => { changes: number },
  iterate: (...params: unknown[]) => IterableIterator<EventRow>
};
type SqliteDb = { prepare: (sql: string) => SqliteStmt, close: () => void };

type EventQueries = {
  getAll: SqliteStmt, getTerms: SqliteStmt, getById: SqliteStmt,
  getDeletedSince: SqliteStmt, getHistory: SqliteStmt, create: SqliteStmt,
  deleteByHeadId: SqliteStmt, deleteById: SqliteStmt
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

  fullTextSearch.setupForTable(this.db, 'events', tableSchemas.events, ['streamIds']);
  this.eventQueries.getTerms = this.db.prepare('SELECT * FROM events_fts_v WHERE term like ?');

  this.eventQueries.getById = this.db.prepare('SELECT * FROM events WHERE eventid = ?');
  this.eventQueries.getDeletedSince = this.db.prepare('SELECT * from events WHERE deleted >= ? ORDER BY deleted DESC');
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

function prepareEventsGetQuery (params: GetParams): string {
  return 'SELECT * FROM events_fts ' + prepareQuery(params);
}

UserDatabase.prototype.getEventDeletionsStreamed = function (this: UserDatabaseInstance, deletedSince: number): NodeReadable {
  this.logger.debug(`GET events deletions since: ${deletedSince}`);
  return readableEventsStreamForIterator(this.eventQueries.getDeletedSince.iterate(deletedSince));
};

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
    [Symbol.iterator]: function (): IterableIterator<DomainEvent> {
      return iterateTransform;
    }
  };

  return Readable.from(iterateTransform);
}

UserDatabase.prototype.getAllActions = function (this: UserDatabaseInstance): EventRow[] {
  return this.eventQueries.getTerms.all('action-%');
};

UserDatabase.prototype.getAllAccesses = function (this: UserDatabaseInstance): EventRow[] {
  return this.eventQueries.getTerms.all('access-%');
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

UserDatabase.prototype.updateEvent = async function (this: UserDatabaseInstance, eventId: string, eventData: DomainEvent): Promise<DomainEvent | null> {
  const dbEvent = eventsSchema.toDB(eventData);
  if (dbEvent.streamIds == null) { dbEvent.streamIds = eventsSchema.ALL_EVENTS_TAG; }

  delete dbEvent.eventid;
  const queryString = `UPDATE events SET ${Object.keys(dbEvent).map(field => `${field} = @${field}`).join(', ')} WHERE eventid = @eventid`;
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

UserDatabase.prototype.getEventHistory = function (this: UserDatabaseInstance, eventId: string): DomainEvent[] {
  this.logger.debug(`GET event history for: ${eventId}`);
  return this.eventQueries.getHistory.all(eventId).map(eventsSchema.fromDBHistory);
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
    if (c.value === null) return `${realField} IS NULL`;
    const value = eventsSchema.coerceValueForColumn(realField, c.value);
    return `${realField} = ${value}`;
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
        const classOnly = typeCorced.substring(0, starPos);
        return `type LIKE ${classOnly}%'`;
      }
      return `type = ${typeCorced}`;
    });
    return '(' + lt.join(' OR ') + ')';
  },
  streamsQuery: (content: unknown) => {
    const str = toSQLiteQuery(content);
    if (str === null) return null;
    return 'streamIds MATCH \'' + str + '\'';
  }
};

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

  const limit = params.options?.limit;
  if (limit) {
    queryString += ' LIMIT ' + limit;
  }

  const skip = params.options?.skip;
  if (skip) {
    queryString += ' OFFSET ' + skip;
  }
  return queryString;
}

export { UserDatabase };
