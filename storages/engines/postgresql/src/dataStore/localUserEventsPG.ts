/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Readable as ReadableType } from 'node:stream';
const require = createRequire(import.meta.url);

const { Readable } = require('stream');
const { createId: cuid } = require('@paralleldrive/cuid2');
const ds = require('@pryv/datastore');
const errors = ds.errors;
const { DatabasePG } = require('../DatabasePG.ts');
const timestamp = require('unix-timestamp');
const { DeletionModesFields } = require('../../../../shared/DeletionModesFields.ts');
const { localStoreEventQueries } = require('../../../../shared/localStoreEventQueries.ts');
import type { NormalizedCondition } from '../../../../shared/contentQueryConditions.ts';

import type { StoredEvent } from '../../../../interfaces/_shared/domain.ts';
/** Datastore-level event: the canonical stored shape plus the open tail the
 *  deletion-mode field scrubbing indexes dynamically. */
type EventLike = StoredEvent & { [k: string]: unknown };
type DeletionSettings = {
  mode: 'keep-nothing' | 'keep-authors' | 'keep-everything' | string;
  fields: string[];
  removeAttachments: boolean;
};
type Settings = { versioning?: { deletionMode?: string; forceKeepHistory?: boolean } };
type SystemStreams = { accountStreamIds?: string[] };
type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number };
type QueryFn = (sql: string, params: unknown[]) => Promise<QueryResult>;
type Transaction = { query: QueryFn } | null | undefined;
interface DbLike { query: QueryFn }
interface EventsFileStorageLike {
  removeAllForEvent: (userId: string, eventId: string) => Promise<void>;
  removeAllForUser: (userId: string) => Promise<void>;
  getFileStorageInfos: (userId: string) => Promise<number>;
}
type Store = {
  db: DbLike;
  eventsFileStorage: EventsFileStorageLike;
  settings: Settings;
  setIntegrityOnEvent: (event: EventLike) => void;
  accountStreamIds: string[];
  deletionSettings: DeletionSettings;
  keepHistory: boolean;
  // own helper methods of the store literal, so `this.<helper>()` typechecks
  _generateVersionIfNeeded (userId: string, eventId: string, originalEvent: EventLike | null, queryFn: QueryFn): Promise<void>;
  _syncEventStreams (userId: string, eventId: string, streamIds: string[], queryFn: QueryFn): Promise<void>;
};

interface LocalQueryItem {
  type: string;
  content: unknown;
  [k: string]: unknown;
}
interface LocalOptions {
  sort?: Record<string, number>;
  skip?: number;
  limit?: number;
  [k: string]: unknown;
}
interface StreamFilterItem {
  any?: string[];
  not?: string[];
  [k: string]: unknown;
}

const COL_MAP: Record<string, string> = {
  headId: 'head_id',
  streamIds: 'stream_ids',
  endTime: 'end_time',
  clientData: 'client_data',
  createdBy: 'created_by',
  modifiedBy: 'modified_by'
};

const JSONB_COLS = new Set([
  'stream_ids', 'tags', 'content', 'client_data', 'attachments'
]);

function toCol (prop: string): string {
  return COL_MAP[prop] || prop;
}

function toPGValue (col: string, val: unknown): unknown {
  if (val === undefined) return null;
  if (JSONB_COLS.has(col) && val != null) {
    return JSON.stringify(val);
  }
  return val;
}

function rowToEvent (row: Record<string, unknown> | null | undefined): EventLike | null {
  if (!row) return null;
  const event: Record<string, unknown> = {};
  for (const [col, val] of Object.entries(row)) {
    if (col === 'user_id') continue;
    // Reverse map snake_case → camelCase
    let prop = col;
    for (const [k, v] of Object.entries(COL_MAP)) {
      if (v === col) { prop = k; break; }
    }
    // Preserve end_time null for non-deleted events (running periods need endTime: null → duration: null).
    // For deleted events, null end_time should be stripped like other null fields.
    if (col === 'end_time' && row.deleted == null) {
      if (val !== undefined) event[prop] = val;
      continue;
    }
    if (val !== null && val !== undefined) {
      event[prop] = val;
    }
  }
  // Remove trashed=false (matches MongoDB behaviour)
  if (event.trashed === false) delete event.trashed;
  // Remove deleted if null (matches MongoDB behaviour)
  if (event.deleted == null) delete event.deleted;
  // Remove headId if null
  if (event.headId == null) delete event.headId;
  return event as EventLike;
}

/**
 * PostgreSQL data store: events implementation.
 * Implements the @pryv/datastore UserEvents interface.
 */
const userEvents = ds.createUserEvents({
  db: null,
  eventsFileStorage: null,
  deletionSettings: null,
  keepHistory: false,
  setIntegrityOnEvent: null,

  init (this: Store, db: DbLike, eventsFileStorage: EventsFileStorageLike, settings: Settings, setIntegrityOnEventFn: (event: EventLike) => void, systemStreams: SystemStreams): void {
    this.db = db;
    this.eventsFileStorage = eventsFileStorage;
    this.settings = settings;
    this.setIntegrityOnEvent = setIntegrityOnEventFn;
    this.accountStreamIds = systemStreams?.accountStreamIds || [];
    const mode = settings.versioning?.deletionMode || 'keep-nothing';
    const fields = DeletionModesFields[mode] || ['integrity'];
    this.deletionSettings = {
      mode,
      fields,
      removeAttachments: fields.includes('attachments')
    };
    this.keepHistory = settings.versioning?.forceKeepHistory || false;
  },

  async getOne (this: Store, userId: string, eventId: string): Promise<EventLike | null> {
    // Return the event regardless of deletion status (matching MongoDB behavior).
    // Only exclude versioned copies (head_id IS NULL = current head).
    const res = await this.db.query(
      'SELECT * FROM events WHERE user_id = $1 AND id = $2 AND head_id IS NULL',
      [userId, eventId]
    );
    return res.rows.length > 0 ? rowToEvent(res.rows[0]) : null;
  },

  async get (this: Store, userId: string, query: unknown, options: unknown): Promise<EventLike[]> {
    const localQuery = localStoreEventQueries.localStorePrepareQuery(query);
    const localOptions = localStoreEventQueries.localStorePrepareOptions(options);
    const { sql, params } = buildEventQuery(userId, localQuery, localOptions);
    const res = await this.db.query(sql, params);
    return res.rows.map(rowToEvent).filter((e): e is EventLike => e !== null);
  },

  async getStreamed (this: Store, userId: string, query: unknown, options: unknown): Promise<ReadableType> {
    const localQuery = localStoreEventQueries.localStorePrepareQuery(query);
    const localOptions = localStoreEventQueries.localStorePrepareOptions(options);
    const { sql, params } = buildEventQuery(userId, localQuery, localOptions);
    const res = await this.db.query(sql, params);
    return readableStreamFromRows(res.rows);
  },

  async getDeletionsStreamed (this: Store, userId: string, query: { deletedSince: number }, options: { sortAscending?: boolean; limit?: number; skip?: number } | null): Promise<ReadableType> {
    const conditions: string[] = ['user_id = $1', 'deleted > $2'];
    const params: unknown[] = [userId, query.deletedSince];
    let idx = 3;
    let sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY deleted ${options?.sortAscending ? 'ASC' : 'DESC'}`;
    if (options?.limit != null) { sql += ` LIMIT $${idx}`; params.push(options.limit); idx++; }
    if (options?.skip != null) { sql += ` OFFSET $${idx}`; params.push(options.skip); }
    const res = await this.db.query(sql, params);
    return readableStreamFromRows(res.rows);
  },

  async getHistory (this: Store, userId: string, eventId: string): Promise<EventLike[]> {
    const res = await this.db.query(
      'SELECT * FROM events WHERE user_id = $1 AND head_id = $2 ORDER BY modified ASC',
      [userId, eventId]
    );
    return res.rows.map((row: Record<string, unknown>) => {
      const item = rowToEvent(row)!;
      item.id = item.headId!;
      delete item.headId;
      return item;
    });
  },

  async create (this: Store, userId: string, event: EventLike, transaction: Transaction): Promise<EventLike> {
    try {
      const queryFn: QueryFn = transaction ? transaction.query.bind(transaction) : this.db.query.bind(this.db);
      const cols: string[] = ['user_id'];
      const vals: unknown[] = [userId];
      const placeholders: string[] = ['$1'];
      let idx = 2;

      for (const [prop, val] of Object.entries(event)) {
        if (prop === 'id') {
          cols.push('id');
        } else {
          cols.push(toCol(prop));
        }
        const colName = prop === 'id' ? 'id' : toCol(prop);
        vals.push(toPGValue(colName, val));
        placeholders.push(`$${idx}`);
        idx++;
      }

      const sql = `INSERT INTO events (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
      await queryFn(sql, vals);

      // Populate event_streams junction table
      if (event.streamIds && event.streamIds.length > 0) {
        await this._syncEventStreams(userId, event.id, event.streamIds, queryFn);
      }

      return event;
    } catch (err: unknown) {
      DatabasePG.handleDuplicateError(err);
      const e = err as { isDuplicateIndex?: unknown; isDuplicate?: boolean };
      if (e.isDuplicateIndex != null && e.isDuplicate) {
        throw errors.itemAlreadyExists('event', { id: event.id }, err);
      }
      throw errors.unexpectedError(err);
    }
  },

  /**
   * @param onlyIfNotTrashed compare-and-set: apply only while the event is
   *   still untrashed, so exactly one of N concurrent callers can flip it.
   *   Returns false for the losers instead of overwriting each other.
   */
  async update (this: Store, userId: string, eventData: EventLike, transaction: Transaction, onlyIfNotTrashed?: boolean): Promise<boolean> {
    const queryFn: QueryFn = transaction ? transaction.query.bind(transaction) : this.db.query.bind(this.db);
    await this._generateVersionIfNeeded(userId, eventData.id, null, queryFn);

    try {
      const setClauses: string[] = [];
      const params: unknown[] = [userId, eventData.id];
      let idx = 3;

      for (const [prop, val] of Object.entries(eventData)) {
        if (prop === 'id') continue;
        const col = toCol(prop);
        setClauses.push(`${col} = $${idx}`);
        params.push(toPGValue(col, val));
        idx++;
      }

      if (setClauses.length === 0) return false;

      const casClause = onlyIfNotTrashed ? ' AND (trashed IS NULL OR trashed = FALSE)' : '';
      const sql = `UPDATE events SET ${setClauses.join(', ')} WHERE user_id = $1 AND id = $2${casClause}`;
      const res = await queryFn(sql, params);
      // A CAS miss is a normal outcome (someone else got there first), not a
      // reason to touch event_streams.
      if (onlyIfNotTrashed && res.rowCount !== 1) return false;

      // Sync event_streams if streamIds changed
      if (eventData.streamIds) {
        await this._syncEventStreams(userId, eventData.id, eventData.streamIds, queryFn);
      }

      return res.rowCount === 1;
    } catch (err: unknown) {
      throw errors.unexpectedError(err);
    }
  },

  async delete (this: Store, userId: string, originalEvent: EventLike): Promise<void> {
    await this._generateVersionIfNeeded(userId, originalEvent.id, originalEvent, this.db.query.bind(this.db));
    const deletedEventContent: EventLike = structuredClone(originalEvent);
    const eventId = deletedEventContent.id;

    // Remove attachments if configured
    if (this.deletionSettings.removeAttachments &&
        deletedEventContent.attachments != null &&
        deletedEventContent.attachments.length > 0) {
      await this.eventsFileStorage.removeAllForEvent(userId, eventId);
    }

    // Handle history based on deletion mode
    if (this.deletionSettings.mode === 'keep-nothing') {
      await this.db.query(
        'DELETE FROM events WHERE user_id = $1 AND head_id = $2',
        [userId, eventId]
      );
    }
    if (this.deletionSettings.mode === 'keep-authors') {
      const unsetCols = this.deletionSettings.fields
        .map((f: string) => `${toCol(f)} = NULL`)
        .join(', ');
      if (unsetCols) {
        await this.db.query(
          `UPDATE events SET ${unsetCols} WHERE user_id = $1 AND head_id = $2`,
          [userId, eventId]
        );
      }
    }

    // Prepare deleted event content
    deletedEventContent.deleted = timestamp.now();
    const fieldsToUnset: Set<string> = new Set(this.deletionSettings.fields);
    for (const field of fieldsToUnset) {
      delete deletedEventContent[field];
    }
    this.setIntegrityOnEvent(deletedEventContent);

    // Build replacement update: set remaining fields AND null out deleted fields.
    const setClauses: string[] = [];
    const params: unknown[] = [userId, eventId];
    let idx = 3;
    const columnsAlreadySet = new Set<string>();

    for (const [prop, val] of Object.entries(deletedEventContent)) {
      if (prop === 'id') continue;
      const col = toCol(prop);
      columnsAlreadySet.add(col);
      setClauses.push(`${col} = $${idx}`);
      params.push(toPGValue(col, val));
      idx++;
    }
    // Explicitly NULL out fields that were deleted (skip any already set above,
    // e.g. integrity which setIntegrityOnEvent may have re-added).
    for (const field of fieldsToUnset) {
      const col = toCol(field);
      if (!columnsAlreadySet.has(col)) {
        setClauses.push(`${col} = NULL`);
      }
    }

    await this.db.query(
      `UPDATE events SET ${setClauses.join(', ')} WHERE user_id = $1 AND id = $2`,
      params
    );

    // Clean up event_streams junction
    await this.db.query(
      'DELETE FROM event_streams WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );
  },

  async _generateVersionIfNeeded (this: Store, userId: string, eventId: string, originalEvent: EventLike | null, queryFn: QueryFn): Promise<void> {
    if (!this.keepHistory) return;
    let versionItem: EventLike;
    if (originalEvent != null) {
      versionItem = structuredClone(originalEvent);
    } else {
      const res = await queryFn(
        'SELECT * FROM events WHERE user_id = $1 AND id = $2',
        [userId, eventId]
      );
      if (res.rows.length === 0) return;
      versionItem = rowToEvent(res.rows[0])!;
    }
    versionItem.headId = eventId;
    const versionId = cuid();
    delete (versionItem as Partial<EventLike>).id;

    const cols: string[] = ['user_id', 'id'];
    const vals: unknown[] = [userId, versionId];
    const placeholders: string[] = ['$1', '$2'];
    let idx = 3;

    for (const [prop, val] of Object.entries(versionItem)) {
      const col = toCol(prop);
      cols.push(col);
      vals.push(toPGValue(col, val));
      placeholders.push(`$${idx}`);
      idx++;
    }

    await queryFn(
      `INSERT INTO events (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
      vals
    );
  },

  /**
   * Sync the event_streams junction table for an event.
   * Replaces all entries for the given event.
   */
  async _syncEventStreams (this: Store, userId: string, eventId: string, streamIds: string[], queryFn: QueryFn): Promise<void> {
    // Delete existing entries
    await queryFn(
      'DELETE FROM event_streams WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );
    // Insert new entries
    if (!streamIds || streamIds.length === 0) return;
    for (const streamId of streamIds) {
      // Look up stream path (or use streamId as fallback)
      const pathRes = await queryFn(
        'SELECT path FROM streams WHERE user_id = $1 AND id = $2',
        [userId, streamId]
      );
      const streamPath = pathRes.rows.length > 0 ? pathRes.rows[0].path : streamId + '/';
      await queryFn(
        'INSERT INTO event_streams (user_id, event_id, stream_id, stream_path) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [userId, eventId, streamId, streamPath]
      );
    }
  },

  async _deleteUser (this: Store, userId: string): Promise<void> {
    await this.db.query('DELETE FROM event_streams WHERE user_id = $1', [userId]);
    await this.db.query('DELETE FROM events WHERE user_id = $1', [userId]);
    await this.eventsFileStorage.removeAllForUser(userId);
  },

  async _getStorageInfos (this: Store, userId: string): Promise<{ count: number }> {
    const res = await this.db.query(
      'SELECT COUNT(*)::int AS cnt FROM events WHERE user_id = $1',
      [userId]
    );
    return { count: res.rows[0].cnt as number };
  },

  async _getFilesStorageInfos (this: Store, userId: string): Promise<{ sizeKb: number }> {
    const sizeKb = await this.eventsFileStorage.getFileStorageInfos(userId);
    return { sizeKb };
  },

  async removeAllNonAccountEventsForUser (this: Store, userId: string): Promise<void> {
    const allAccountStreamIds = this.accountStreamIds;
    if (allAccountStreamIds.length === 0) {
      await this.db.query('DELETE FROM event_streams WHERE user_id = $1', [userId]);
      await this.db.query('DELETE FROM events WHERE user_id = $1', [userId]);
    } else {
      // Delete events that do NOT have any account stream in their streamIds
      const placeholders = allAccountStreamIds.map((_, i) => `$${i + 2}`).join(', ');
      // Use the junction table to find events with account streams, then delete the rest
      await this.db.query(
        `DELETE FROM event_streams WHERE user_id = $1
         AND event_id NOT IN (
           SELECT DISTINCT event_id FROM event_streams
           WHERE user_id = $1 AND stream_id IN (${placeholders})
         )`,
        [userId, ...allAccountStreamIds]
      );
      await this.db.query(
        `DELETE FROM events WHERE user_id = $1
         AND id NOT IN (
           SELECT DISTINCT event_id FROM event_streams
           WHERE user_id = $1 AND stream_id IN (${placeholders})
         )`,
        [userId, ...allAccountStreamIds]
      );
    }
    await this.eventsFileStorage.removeAllForUser(userId);
  }
});

// Expose rowToEvent for use by StorageLayer.iterateAllEvents
// (also exported below as a named binding, but consumers reach for it via the userEvents namespace).
const userEventsWithRow = Object.assign(userEvents, { rowToEvent });

export { userEventsWithRow as userEvents, rowToEvent, convertJsonCondition };

// ---- Query building helpers ----

function buildEventQuery (userId: string, localQuery: LocalQueryItem[], localOptions: LocalOptions): { sql: string, params: unknown[] } {
  const conditions: string[] = ['e.user_id = $1', 'e.deleted IS NULL', 'e.head_id IS NULL'];
  const params: unknown[] = [userId];
  let idx = 2;

  for (const item of localQuery) {
    const result = convertQueryItem(item, idx, params);
    if (result) {
      conditions.push(result.condition);
      idx = result.nextIdx;
    }
  }

  let sql = `SELECT e.* FROM events e WHERE ${conditions.join(' AND ')}`;

  // Sort
  if (localOptions.sort) {
    const sortParts = (Object.entries(localOptions.sort) as Array<[string, number]>).map(([k, v]) =>
      `e.${toCol(k)} ${v === 1 ? 'ASC' : 'DESC'}`
    );
    sql += ' ORDER BY ' + sortParts.join(', ');
  }

  // Limit / Skip
  if (localOptions.skip != null) {
    sql += ` OFFSET $${idx}`;
    params.push(localOptions.skip);
    idx++;
  }
  if (localOptions.limit != null) {
    sql += ` LIMIT $${idx}`;
    params.push(localOptions.limit);
    idx++;
  }

  return { sql, params };
}

function convertQueryItem (item: LocalQueryItem, idx: number, params: unknown[]): { condition: string, nextIdx: number } | null {
  const content = item.content as { field: string; value: unknown };
  switch (item.type) {
    case 'equal': {
      const col = 'e.' + toCol(content.field);
      if (content.value === null) {
        return { condition: `${col} IS NULL`, nextIdx: idx };
      }
      if (content.value === true) {
        return { condition: `${col} = TRUE`, nextIdx: idx };
      }
      if (content.value === false) {
        // trashed=false means trashed IS NULL or trashed = false
        return { condition: `(${col} IS NULL OR ${col} = FALSE)`, nextIdx: idx };
      }
      params.push(content.value);
      return { condition: `${col} = $${idx}`, nextIdx: idx + 1 };
    }
    case 'greater': {
      const col = 'e.' + toCol(content.field);
      params.push(content.value);
      return { condition: `${col} > $${idx}`, nextIdx: idx + 1 };
    }
    case 'greaterOrEqual': {
      const col = 'e.' + toCol(content.field);
      params.push(content.value);
      return { condition: `${col} >= $${idx}`, nextIdx: idx + 1 };
    }
    case 'lowerOrEqual': {
      const col = 'e.' + toCol(content.field);
      params.push(content.value);
      return { condition: `${col} <= $${idx}`, nextIdx: idx + 1 };
    }
    case 'greaterOrEqualOrNull': {
      const col = 'e.' + toCol(content.field);
      params.push(content.value);
      return {
        condition: `(${col} >= $${idx} OR ${col} IS NULL)`,
        nextIdx: idx + 1
      };
    }
    case 'typesList': {
      const typesContent = item.content as string[];
      if (typesContent.length === 0) return null;
      const typeConditions: string[] = [];
      for (const requestedType of typesContent) {
        const wildcardIndex = requestedType.indexOf('/*');
        if (wildcardIndex > 0) {
          // Wildcard: note/* → type LIKE 'note/%'
          params.push(requestedType.substr(0, wildcardIndex + 1) + '%');
          typeConditions.push(`e.type LIKE $${idx}`);
        } else {
          params.push(requestedType);
          typeConditions.push(`e.type = $${idx}`);
        }
        idx++;
      }
      return {
        condition: `(${typeConditions.join(' OR ')})`,
        nextIdx: idx
      };
    }
    case 'streamsQuery': {
      return convertStreamsQuery(item.content as StreamFilterItem[][], idx, params);
    }
    case 'jsonCondition': {
      return convertJsonCondition(item.content as NormalizedCondition, idx, params);
    }
    default:
      return null;
  }
}

/**
 * Translate a normalized content/clientData condition to SQL.
 * Matching is strict on JSON types (semantics defined by the reference
 * matcher in storages/shared/contentQueryConditions.ts): comparisons stay
 * in the jsonb domain (`to_jsonb`) so no text→numeric cast can fail and
 * `true` never equals `1` nor `'true'`.
 */
function convertJsonCondition (condition: NormalizedCondition, idx: number, params: unknown[]): { condition: string, nextIdx: number } {
  const col = condition.field === 'clientData' ? 'e.client_data' : 'e.content';
  let jsonbExpr: string, textExpr: string, typeExpr: string;
  if (condition.path === null) { // root value ($)
    jsonbExpr = col;
    textExpr = `(${col} #>> '{}')`;
    typeExpr = `jsonb_typeof(${col})`;
  } else {
    params.push(condition.path);
    const pathParam = `$${idx++}::text[]`;
    jsonbExpr = `(${col} #> ${pathParam})`;
    textExpr = `(${col} #>> ${pathParam})`;
    typeExpr = `jsonb_typeof(${col} #> ${pathParam})`;
  }

  const eqExpr = (value: string | number | boolean): string => {
    params.push(value);
    const cast = typeof value === 'number' ? 'numeric' : typeof value === 'boolean' ? 'boolean' : 'text';
    return `${jsonbExpr} = to_jsonb($${idx++}::${cast})`;
  };

  switch (condition.op) {
    case 'eq':
      return { condition: eqExpr(condition.value as string | number | boolean), nextIdx: idx };
    case 'neq':
      return { condition: `(${typeExpr} IS NOT NULL AND NOT ${eqExpr(condition.value as string | number | boolean)})`, nextIdx: idx };
    case 'in': {
      // `= ANY(jsonb[])` keeps exact jsonb equality (strict types, scalars
      // can never equal arrays/objects) and is B-tree-servable, unlike
      // jsonb containment.
      params.push((condition.value as Array<string | number | boolean>).map((v) => JSON.stringify(v)));
      return {
        condition: `${jsonbExpr} = ANY($${idx++}::jsonb[])`,
        nextIdx: idx
      };
    }
    case 'exists': {
      const presence = condition.path === null ? col : jsonbExpr;
      return { condition: `${presence} IS ${condition.value === true ? 'NOT ' : ''}NULL`, nextIdx: idx };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const sqlOp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[condition.op];
      params.push(condition.value);
      return {
        condition: `(${typeExpr} = 'number' AND ${jsonbExpr} ${sqlOp} to_jsonb($${idx++}::numeric))`,
        nextIdx: idx
      };
    }
    case 'prefix': {
      params.push((condition.value as string).replace(/[\\%_]/g, (m) => '\\' + m) + '%');
      return {
        condition: `(${typeExpr} = 'string' AND ${textExpr} LIKE $${idx++} ESCAPE '\\')`,
        nextIdx: idx
      };
    }
    default:
      throw new Error(`Unsupported JSON condition operator: ${(condition as { op: string }).op}`);
  }
}

function convertStreamsQuery (streamQueriesArray: StreamFilterItem[][], idx: number, params: unknown[]): { condition: string, nextIdx: number } | null {
  if (!streamQueriesArray || streamQueriesArray.length === 0) return null;

  const orParts: string[] = [];

  for (const streamQuery of streamQueriesArray) {
    if (streamQuery == null) continue;

    const andParts: string[] = [];

    for (const item of streamQuery) {
      if (item.any && item.any.length > 0 && !item.any.includes('*')) {
        const placeholders = item.any.map((sid: string) => {
          params.push(sid);
          return `$${idx++}`;
        });
        andParts.push(
          `EXISTS (SELECT 1 FROM event_streams es WHERE es.user_id = e.user_id AND es.event_id = e.id AND es.stream_id IN (${placeholders.join(', ')}))`
        );
      }
      if (item.not && item.not.length > 0) {
        const placeholders = item.not.map((sid: string) => {
          params.push(sid);
          return `$${idx++}`;
        });
        andParts.push(
          `NOT EXISTS (SELECT 1 FROM event_streams es WHERE es.user_id = e.user_id AND es.event_id = e.id AND es.stream_id IN (${placeholders.join(', ')}))`
        );
      }
    }

    if (andParts.length > 0) {
      orParts.push('(' + andParts.join(' AND ') + ')');
    }
  }

  if (orParts.length === 0) return null;

  const condition = orParts.length === 1
    ? orParts[0]
    : '(' + orParts.join(' OR ') + ')';

  return { condition, nextIdx: idx };
}

function readableStreamFromRows (rows: Array<Record<string, unknown>>): ReadableType {
  let index = 0;
  const readable = new Readable({
    objectMode: true,
    highWaterMark: 4000,
    read (this: ReadableType) {
      while (index < rows.length) {
        const event = rowToEvent(rows[index++]);
        if (!this.push(event)) return; // back-pressure
      }
      this.push(null);
    }
  });
  return readable;
}
