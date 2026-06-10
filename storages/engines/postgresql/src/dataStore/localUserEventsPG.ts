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

type Event = {
  id: string;
  type?: string;
  streamIds?: string[];
  time?: number;
  duration?: number | null;
  content?: unknown;
  attachments?: Array<{ id?: string }>;
  deleted?: number;
  headId?: string;
  trashed?: boolean;
  [k: string]: unknown;
};
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
  setIntegrityOnEvent: (event: Event) => void;
  accountStreamIds: string[];
  deletionSettings: DeletionSettings;
  keepHistory: boolean;
  // own helper methods of the store literal, so `this.<helper>()` typechecks
  _generateVersionIfNeeded (userId: string, eventId: string, originalEvent: Event | null, queryFn: QueryFn): Promise<void>;
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

function rowToEvent (row: Record<string, unknown> | null | undefined): Event | null {
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
  return event as Event;
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

  init (this: Store, db: DbLike, eventsFileStorage: EventsFileStorageLike, settings: Settings, setIntegrityOnEventFn: (event: Event) => void, systemStreams: SystemStreams): void {
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

  async getOne (this: Store, userId: string, eventId: string): Promise<Event | null> {
    // Return the event regardless of deletion status (matching MongoDB behavior).
    // Only exclude versioned copies (head_id IS NULL = current head).
    const res = await this.db.query(
      'SELECT * FROM events WHERE user_id = $1 AND id = $2 AND head_id IS NULL',
      [userId, eventId]
    );
    return res.rows.length > 0 ? rowToEvent(res.rows[0]) : null;
  },

  async get (this: Store, userId: string, query: unknown, options: unknown): Promise<Event[]> {
    const localQuery = localStoreEventQueries.localStorePrepareQuery(query);
    const localOptions = localStoreEventQueries.localStorePrepareOptions(options);
    const { sql, params } = buildEventQuery(userId, localQuery, localOptions);
    const res = await this.db.query(sql, params);
    return res.rows.map(rowToEvent).filter((e): e is Event => e !== null);
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

  async getHistory (this: Store, userId: string, eventId: string): Promise<Event[]> {
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

  async create (this: Store, userId: string, event: Event, transaction: Transaction): Promise<Event> {
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

  async update (this: Store, userId: string, eventData: Event, transaction: Transaction): Promise<boolean> {
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

      const sql = `UPDATE events SET ${setClauses.join(', ')} WHERE user_id = $1 AND id = $2`;
      const res = await queryFn(sql, params);

      // Sync event_streams if streamIds changed
      if (eventData.streamIds) {
        await this._syncEventStreams(userId, eventData.id, eventData.streamIds, queryFn);
      }

      return res.rowCount === 1;
    } catch (err: unknown) {
      throw errors.unexpectedError(err);
    }
  },

  async delete (this: Store, userId: string, originalEvent: Event): Promise<void> {
    await this._generateVersionIfNeeded(userId, originalEvent.id, originalEvent, this.db.query.bind(this.db));
    const deletedEventContent: Event = structuredClone(originalEvent);
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

  async _generateVersionIfNeeded (this: Store, userId: string, eventId: string, originalEvent: Event | null, queryFn: QueryFn): Promise<void> {
    if (!this.keepHistory) return;
    let versionItem: Event;
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
    delete (versionItem as Partial<Event>).id;

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

export { userEventsWithRow as userEvents, rowToEvent };

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
    default:
      return null;
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
