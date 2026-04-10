/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { Readable } = require('stream');
const cuid = require('cuid');
const ds = require('@pryv/datastore');
const errors = ds.errors;
const DatabasePG = require('../DatabasePG');
const timestamp = require('unix-timestamp');
const DeletionModesFields = require('../../../../shared/DeletionModesFields');
const localStoreEventQueries = require('../../../../shared/localStoreEventQueries');

/**
 * Column mapping: camelCase → snake_case for events table.
 */
const COL_MAP = {
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

function toCol (prop) {
  return COL_MAP[prop] || prop;
}

function toPGValue (col, val) {
  if (val === undefined) return null;
  // JSONB columns need all non-null values serialized (strings, numbers, arrays, objects)
  if (JSONB_COLS.has(col) && val != null) {
    return JSON.stringify(val);
  }
  return val;
}

/**
 * Convert a PG row to an event object (camelCase, no user_id).
 */
function rowToEvent (row) {
  if (!row) return null;
  const event = {};
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
  return event;
}

/**
 * PostgreSQL data store: events implementation.
 * Implements the @pryv/datastore UserEvents interface.
 */
module.exports = ds.createUserEvents({
  /** @type {import('../DatabasePG')} */
  db: null,
  eventsFileStorage: null,
  deletionSettings: null,
  keepHistory: false,
  setIntegrityOnEvent: null,

  init (db, eventsFileStorage, settings, setIntegrityOnEventFn, systemStreams) {
    this.db = db;
    this.eventsFileStorage = eventsFileStorage;
    this.settings = settings;
    this.setIntegrityOnEvent = setIntegrityOnEventFn;
    this.accountStreamIds = systemStreams?.accountStreamIds || [];
    this.deletionSettings = {
      mode: settings.versioning?.deletionMode || 'keep-nothing'
    };
    this.deletionSettings.fields = DeletionModesFields[this.deletionSettings.mode] || ['integrity'];
    this.deletionSettings.removeAttachments = this.deletionSettings.fields.includes('attachments');
    this.keepHistory = settings.versioning?.forceKeepHistory || false;
  },

  async getOne (userId, eventId) {
    // Return the event regardless of deletion status (matching MongoDB behavior).
    // Only exclude versioned copies (head_id IS NULL = current head).
    const res = await this.db.query(
      'SELECT * FROM events WHERE user_id = $1 AND id = $2 AND head_id IS NULL',
      [userId, eventId]
    );
    return res.rows.length > 0 ? rowToEvent(res.rows[0]) : null;
  },

  async get (userId, query, options) {
    const localQuery = localStoreEventQueries.localStorePrepareQuery(query);
    const localOptions = localStoreEventQueries.localStorePrepareOptions(options);
    const { sql, params } = buildEventQuery(userId, localQuery, localOptions);
    const res = await this.db.query(sql, params);
    return res.rows.map(rowToEvent);
  },

  async getStreamed (userId, query, options) {
    const localQuery = localStoreEventQueries.localStorePrepareQuery(query);
    const localOptions = localStoreEventQueries.localStorePrepareOptions(options);
    const { sql, params } = buildEventQuery(userId, localQuery, localOptions);
    const res = await this.db.query(sql, params);
    return readableStreamFromRows(res.rows);
  },

  async getDeletionsStreamed (userId, query, options) {
    const conditions = ['user_id = $1', 'deleted > $2'];
    const params = [userId, query.deletedSince];
    let idx = 3;
    let sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY deleted ${options?.sortAscending ? 'ASC' : 'DESC'}`;
    if (options?.limit != null) { sql += ` LIMIT $${idx}`; params.push(options.limit); idx++; }
    if (options?.skip != null) { sql += ` OFFSET $${idx}`; params.push(options.skip); }
    const res = await this.db.query(sql, params);
    return readableStreamFromRows(res.rows);
  },

  async getHistory (userId, eventId) {
    const res = await this.db.query(
      'SELECT * FROM events WHERE user_id = $1 AND head_id = $2 ORDER BY modified ASC',
      [userId, eventId]
    );
    return res.rows.map((row) => {
      const item = rowToEvent(row);
      item.id = item.headId;
      delete item.headId;
      return item;
    });
  },

  async create (userId, event, transaction) {
    try {
      const queryFn = transaction ? transaction.query.bind(transaction) : this.db.query.bind(this.db);
      const cols = ['user_id'];
      const vals = [userId];
      const placeholders = ['$1'];
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
    } catch (err) {
      DatabasePG.handleDuplicateError(err);
      if (err.isDuplicateIndex != null && err.isDuplicate) {
        throw errors.itemAlreadyExists('event', { id: event.id }, err);
      }
      throw errors.unexpectedError(err);
    }
  },

  async update (userId, eventData, transaction) {
    const queryFn = transaction ? transaction.query.bind(transaction) : this.db.query.bind(this.db);
    await this._generateVersionIfNeeded(userId, eventData.id, null, queryFn);

    try {
      // Build a full replacement (like MongoDB replaceOne)
      const setClauses = [];
      const params = [userId, eventData.id];
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
    } catch (err) {
      throw errors.unexpectedError(err);
    }
  },

  async delete (userId, originalEvent) {
    await this._generateVersionIfNeeded(userId, originalEvent.id, originalEvent, this.db.query.bind(this.db));
    const deletedEventContent = structuredClone(originalEvent);
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
      // Remove specified fields from history events
      const unsetCols = this.deletionSettings.fields
        .map((f) => `${toCol(f)} = NULL`)
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
    const fieldsToUnset = new Set(this.deletionSettings.fields);
    for (const field of fieldsToUnset) {
      delete deletedEventContent[field];
    }
    this.setIntegrityOnEvent(deletedEventContent);

    // Build replacement update: set remaining fields AND null out deleted fields.
    // MongoDB uses replaceOne (whole-document replacement), so missing fields are
    // implicitly removed.  PG UPDATE only touches listed columns, so we must
    // explicitly NULL out the ones that were deleted.
    const setClauses = [];
    const params = [userId, eventId];
    let idx = 3;
    const columnsAlreadySet = new Set();

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

  async _generateVersionIfNeeded (userId, eventId, originalEvent, queryFn) {
    if (!this.keepHistory) return;
    let versionItem;
    if (originalEvent != null) {
      versionItem = structuredClone(originalEvent);
    } else {
      const res = await queryFn(
        'SELECT * FROM events WHERE user_id = $1 AND id = $2',
        [userId, eventId]
      );
      if (res.rows.length === 0) return;
      versionItem = rowToEvent(res.rows[0]);
    }
    versionItem.headId = eventId;
    const versionId = cuid();
    delete versionItem.id;

    // Insert version record
    const cols = ['user_id', 'id'];
    const vals = [userId, versionId];
    const placeholders = ['$1', '$2'];
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
  async _syncEventStreams (userId, eventId, streamIds, queryFn) {
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

  async _deleteUser (userId) {
    await this.db.query('DELETE FROM event_streams WHERE user_id = $1', [userId]);
    await this.db.query('DELETE FROM events WHERE user_id = $1', [userId]);
    await this.eventsFileStorage.removeAllForUser(userId);
  },

  async _getStorageInfos (userId) {
    const res = await this.db.query(
      'SELECT COUNT(*)::int AS cnt FROM events WHERE user_id = $1',
      [userId]
    );
    return { count: res.rows[0].cnt };
  },

  async _getFilesStorageInfos (userId) {
    const sizeKb = await this.eventsFileStorage.getFileStorageInfos(userId);
    return { sizeKb };
  },

  /**
   * Local stores only — as long as SystemStreams are embedded.
   */
  async removeAllNonAccountEventsForUser (userId) {
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
module.exports.rowToEvent = rowToEvent;

// ---- Query building helpers ----

/**
 * Build a PG query from the intermediate query format produced by localStorePrepareQuery.
 * @param {string} userId
 * @param {Array} localQuery - array of {type, content} items
 * @param {Object} localOptions - {sort, skip, limit}
 * @returns {{ sql: string, params: Array }}
 */
function buildEventQuery (userId, localQuery, localOptions) {
  const conditions = ['e.user_id = $1', 'e.deleted IS NULL', 'e.head_id IS NULL'];
  const params = [userId];
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
    const sortParts = Object.entries(localOptions.sort).map(([k, v]) =>
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

/**
 * Convert a single query item to a SQL condition.
 */
function convertQueryItem (item, idx, params) {
  switch (item.type) {
    case 'equal': {
      const col = 'e.' + toCol(item.content.field);
      if (item.content.value === null) {
        return { condition: `${col} IS NULL`, nextIdx: idx };
      }
      if (item.content.value === true) {
        return { condition: `${col} = TRUE`, nextIdx: idx };
      }
      if (item.content.value === false) {
        // trashed=false means trashed IS NULL or trashed = false
        return { condition: `(${col} IS NULL OR ${col} = FALSE)`, nextIdx: idx };
      }
      params.push(item.content.value);
      return { condition: `${col} = $${idx}`, nextIdx: idx + 1 };
    }
    case 'greater': {
      const col = 'e.' + toCol(item.content.field);
      params.push(item.content.value);
      return { condition: `${col} > $${idx}`, nextIdx: idx + 1 };
    }
    case 'greaterOrEqual': {
      const col = 'e.' + toCol(item.content.field);
      params.push(item.content.value);
      return { condition: `${col} >= $${idx}`, nextIdx: idx + 1 };
    }
    case 'lowerOrEqual': {
      const col = 'e.' + toCol(item.content.field);
      params.push(item.content.value);
      return { condition: `${col} <= $${idx}`, nextIdx: idx + 1 };
    }
    case 'greaterOrEqualOrNull': {
      const col = 'e.' + toCol(item.content.field);
      params.push(item.content.value);
      return {
        condition: `(${col} >= $${idx} OR ${col} IS NULL)`,
        nextIdx: idx + 1
      };
    }
    case 'typesList': {
      if (item.content.length === 0) return null;
      const typeConditions = [];
      for (const requestedType of item.content) {
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
      return convertStreamsQuery(item.content, idx, params);
    }
    default:
      return null;
  }
}

/**
 * Convert a streamsQuery (array of expanded stream query items) to SQL.
 * Uses the event_streams junction table via EXISTS subqueries.
 *
 * The stream query format after expansion is an array of items, each with:
 * - any: [streamId, ...] — event must be in at least one of these streams
 * - not: [streamId, ...] — event must not be in any of these streams
 * - and: [{any: [...]}, {not: [...]}] — combined conditions
 *
 * Multiple items in the top array are ORed together (different stream query clauses).
 */
function convertStreamsQuery (streamQueriesArray, idx, params) {
  if (!streamQueriesArray || streamQueriesArray.length === 0) return null;

  const orParts = [];

  for (const streamQuery of streamQueriesArray) {
    if (streamQuery == null) continue;

    const andParts = [];

    // Process each item in the stream query
    for (const item of streamQuery) {
      if (item.any && item.any.length > 0 && !item.any.includes('*')) {
        // Event must be in at least one of these streams
        const placeholders = item.any.map((sid) => {
          params.push(sid);
          return `$${idx++}`;
        });
        andParts.push(
          `EXISTS (SELECT 1 FROM event_streams es WHERE es.user_id = e.user_id AND es.event_id = e.id AND es.stream_id IN (${placeholders.join(', ')}))`
        );
      }
      if (item.not && item.not.length > 0) {
        // Event must NOT be in any of these streams
        const placeholders = item.not.map((sid) => {
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

/**
 * Create a Readable stream from an array of PG rows.
 */
function readableStreamFromRows (rows) {
  let index = 0;
  const readable = new Readable({
    objectMode: true,
    highWaterMark: 4000,
    read () {
      while (index < rows.length) {
        const event = rowToEvent(rows[index++]);
        if (!this.push(event)) return; // back-pressure
      }
      this.push(null); // end of stream
    }
  });
  return readable;
}
