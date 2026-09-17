/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Readable as ReadableType } from 'node:stream';
import type { DatabasePG } from './DatabasePG.ts';
const require = createRequire(import.meta.url);

const { Readable } = require('stream');

const ALL_EVENTS_TAG = '..';
const IDS_SEPARATOR = ' ';
// Rows fetched per cursor round-trip by the streamed reads. Bounds memory
// without making a large read chatty; not configurable on purpose.
const STREAM_BATCH_SIZE = 1000;

import type { AuditEvent } from '../../../interfaces/auditStorage/UserAuditDatabase.ts';
type AuditRow = Record<string, unknown> & { eventid?: string | null; stream_ids?: string | null };
// Query condition — `content` is polymorphic on `type`.
type StreamsQuery = { any?: string[], not?: string[], all?: string[] };
type ComparisonContent = { field?: string; value?: unknown };
type QueryItem =
  | { type: 'equal' | 'greater' | 'greaterOrEqual' | 'lowerOrEqual' | 'greaterOrEqualOrNull'; content: ComparisonContent }
  | { type: 'typesList'; content: string[] }
  // The NORMALISED shape every store receives: an OR of AND-blocks.
  | { type: 'streamsQuery'; content: StreamsQuery[][] };
type Params = { query: QueryItem[]; options?: { sort?: Record<string, number>; limit?: number | string; skip?: number | string }; streams?: unknown };

type LoggerLike = { getLogger (name: string): unknown };

type DbLike = DatabasePG;

class UserAuditDatabasePG {
  db: DbLike; // DatabasePG — not yet typed externally
  /**
   * The STREAMED-read pool, for every read that holds a connection for longer
   * than a query: `_streamRows` (the audit read path) and
   * `exportAllEventsStreamed` (backup). Everything else here returns in
   * milliseconds and belongs on the write pool with the writes. See the note in
   * the engine's `createAuditStorage` for why the two are kept apart.
   */
  readDb: DbLike;
  userId: string;
  logger: unknown;

  constructor (db: DbLike, userId: string, logger: LoggerLike, readDb?: DbLike) {
    this.db = db;
    this.readDb = readDb ?? db;
    this.userId = userId;
    this.logger = logger.getLogger('audit-user-pg');
  }

  async init (): Promise<void> {
    // No-op: schema created by DatabasePG.initSchema()
  }

  close (): void {
    // No-op: connection pool is shared
  }

  async getEvents (params: Params): Promise<AuditEvent[]> {
    params.query.push({ type: 'equal', content: { field: 'deleted', value: null } });
    params.query.push({ type: 'equal', content: { field: 'head_id', value: null } });
    const { sql, values } = buildSelectQuery(this.userId, params);
    const res = await this.db.query(sql, values);
    return res.rows.map(fromDB);
  }

  getEventsStreamed (params: Params): ReadableType {
    params.query.push({ type: 'equal', content: { field: 'deleted', value: null } });
    params.query.push({ type: 'equal', content: { field: 'head_id', value: null } });
    const { sql, values } = buildSelectQuery(this.userId, params);
    return this._streamRows(sql, values);
  }

  getEventDeletionsStreamed (deletedSince: number): ReadableType {
    return this._streamRows(
      'SELECT * FROM audit_events WHERE user_id = $1 AND deleted >= $2 ORDER BY deleted DESC',
      [this.userId, deletedSince]
    );
  }

  /**
   * Rows of a query as a real stream: a batch in memory at a time rather than
   * the whole matching set.
   *
   * ⚑ The returned stream OWNS a pooled client until it ends or is destroyed,
   * so whatever consumes it must propagate destroy. On the `events.get` path
   * that is what the `pipeThrough` plumbing guarantees; abandon this stream and
   * the client never comes back, and the audit pool is small.
   */
  _streamRows (sql: string, values: unknown[]): ReadableType {
    const db = this.readDb;
    async function * rows (): AsyncGenerator<AuditEvent> {
      for await (const row of db.queryIterable(sql, values, STREAM_BATCH_SIZE)) {
        yield fromDB(row as AuditRow);
      }
    }
    return Readable.from(rows(), { objectMode: true });
  }

  async getOneEvent (eventId: string): Promise<AuditEvent | null> {
    const res = await this.db.query(
      'SELECT * FROM audit_events WHERE user_id = $1 AND eventid = $2',
      [this.userId, eventId]
    );
    if (res.rows.length === 0) return null;
    return fromDB(res.rows[0]);
  }

  async countEvents (): Promise<number> {
    const res = await this.db.query(
      'SELECT count(*)::int AS count FROM audit_events WHERE user_id = $1 AND deleted IS NULL AND head_id IS NULL',
      [this.userId]
    );
    return res.rows[0].count as number;
  }

  async getAllActions (): Promise<Array<{ term: string }>> {
    return this._getTermsByPrefix('action-');
  }

  async getAllAccesses (): Promise<Array<{ term: string }>> {
    return this._getTermsByPrefix('access-');
  }

  async _getTermsByPrefix (prefix: string): Promise<Array<{ term: string }>> {
    const res = await this.db.query(
      'SELECT DISTINCT unnest(string_to_array(stream_ids, $2)) AS term FROM audit_events WHERE user_id = $1',
      [this.userId, IDS_SEPARATOR]
    );
    return res.rows
      .filter((r): r is { term: string } => typeof r.term === 'string' && r.term.startsWith(prefix))
      .map((r) => ({ term: r.term }));
  }

  async createEvent (event: AuditEvent): Promise<void> {
    const row = toDB(event);
    await this.db.query(
      `INSERT INTO audit_events (user_id, eventid, head_id, stream_ids, time, deleted, end_time, type, content, description, client_data, integrity, attachments, trashed, created, created_by, modified, modified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [this.userId, row.eventid, row.head_id, row.stream_ids, row.time, row.deleted, row.end_time, row.type, row.content, row.description, row.client_data, row.integrity, row.attachments, row.trashed, row.created, row.created_by, row.modified, row.modified_by]
    );
  }

  async createEventSync (event: AuditEvent): Promise<void> {
    return this.createEvent(event);
  }

  async updateEvent (eventId: string, eventData: AuditEvent): Promise<AuditEvent | null> {
    const row = toDB(eventData);
    delete row.eventid;
    if (row.stream_ids == null) row.stream_ids = ALL_EVENTS_TAG;

    const fields = Object.keys(row).filter(k => row[k] !== undefined);
    if (fields.length === 0) return null;

    let idx = 3;
    const setClauses: string[] = [];
    const values: unknown[] = [this.userId, eventId];
    for (const field of fields) {
      setClauses.push(`${field} = $${idx}`);
      values.push(row[field]);
      idx++;
    }

    await this.db.query(
      `UPDATE audit_events SET ${setClauses.join(', ')} WHERE user_id = $1 AND eventid = $2`,
      values
    );

    return fromDB(Object.assign({}, row, { eventid: eventId }));
  }

  async getEventHistory (eventId: string): Promise<AuditEvent[]> {
    const res = await this.db.query(
      'SELECT * FROM audit_events WHERE user_id = $1 AND head_id = $2 ORDER BY modified ASC',
      [this.userId, eventId]
    );
    return res.rows.map(fromDBHistory);
  }

  async minimizeEventHistory (eventId: string, fieldsToRemove: string[]): Promise<void> {
    const setClauses = fieldsToRemove.map((field: string) => {
      const dbField = toDBFieldName(field);
      return dbField === 'stream_ids' ? `${dbField} = '${ALL_EVENTS_TAG}'` : `${dbField} = NULL`;
    });
    if (setClauses.length === 0) return;
    await this.db.query(
      `UPDATE audit_events SET ${setClauses.join(', ')} WHERE user_id = $1 AND head_id = $2`,
      [this.userId, eventId]
    );
  }

  async deleteEventHistory (eventId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM audit_events WHERE user_id = $1 AND head_id = $2',
      [this.userId, eventId]
    );
  }

  async deleteEvents (params: Params): Promise<{ changes: number }> {
    if (params.streams) {
      throw new Error('Events DELETE with stream query not supported yet');
    }
    const { sql, values } = buildDeleteQuery(this.userId, params);
    const res = await this.db.query(sql, values);
    // pg always reports rowCount for DELETE statements.
    return { changes: res.rowCount as number };
  }

  async exportAllEvents (): Promise<AuditRow[]> {
    const res = await this.db.query(
      'SELECT * FROM audit_events WHERE user_id = $1',
      [this.userId]
    );
    return res.rows;
  }

  /**
   * Streaming counterpart of exportAllEvents for bounded-memory backup: yields
   * the same raw rows (converters bypassed), one at a time. Same SELECT, and
   * like it no ORDER BY, so the order is whatever the scan gives.
   *
   * ⚑ On `readDb`, the streamed-read pool, not `db`. Exporting one user's audit
   * set holds a cursor open for the whole collection, which is exactly the
   * long-hold shape the pool split exists for. `bin/backup` is the only caller
   * today and runs as its own process, so nothing can be starved right now;
   * putting it here costs one identifier and keeps "the write pool never holds
   * a long-lived client" true by construction, so an in-process trigger added
   * later cannot regress it.
   */
  async * exportAllEventsStreamed (): AsyncGenerator<AuditRow> {
    yield * this.readDb.queryIterable(
      'SELECT * FROM audit_events WHERE user_id = $1',
      [this.userId],
      STREAM_BATCH_SIZE
    ) as AsyncIterable<AuditRow>;
  }

  async importAllEvents (events: AuditRow[]): Promise<void> {
    for (const event of events) {
      const userId = event.user_id || this.userId;
      await this.db.query(
        `INSERT INTO audit_events (user_id, eventid, head_id, stream_ids, time, deleted, end_time, type, content, description, client_data, integrity, attachments, trashed, created, created_by, modified, modified_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (user_id, eventid) DO NOTHING`,
        [userId, event.eventid, event.head_id, event.stream_ids, event.time, event.deleted, event.end_time, event.type, event.content, event.description, event.client_data, event.integrity, event.attachments, event.trashed, event.created, event.created_by, event.modified, event.modified_by]
      );
    }
  }
}

// -- Schema conversion --

function nullIfUndefined<T> (value: T | undefined): T | null {
  return (typeof value !== 'undefined') ? value : null;
}

function toDB (event: AuditEvent): AuditRow {
  const row: AuditRow = {};
  row.eventid = event.id || null;
  if (event.streamIds == null) {
    row.stream_ids = ALL_EVENTS_TAG;
  } else {
    if (!Array.isArray(event.streamIds)) throw new Error('streamIds must be an Array');
    row.stream_ids = event.streamIds.join(IDS_SEPARATOR) + IDS_SEPARATOR + ALL_EVENTS_TAG;
  }
  row.time = nullIfUndefined(event.time);
  row.end_time = nullIfUndefined(event.endTime);
  row.deleted = nullIfUndefined(event.deleted);
  row.head_id = nullIfUndefined(event.headId);
  row.type = nullIfUndefined(event.type);
  row.content = event.content != null ? JSON.stringify(event.content) : null;
  row.description = nullIfUndefined(event.description);
  row.client_data = event.clientData != null ? JSON.stringify(event.clientData) : null;
  row.integrity = nullIfUndefined(event.integrity);
  row.attachments = event.attachments != null ? JSON.stringify(event.attachments) : null;
  row.trashed = !!event.trashed;
  row.created = nullIfUndefined(event.created);
  row.created_by = nullIfUndefined(event.createdBy);
  row.modified = nullIfUndefined(event.modified);
  row.modified_by = nullIfUndefined(event.modifiedBy);
  return row;
}

function fromDB (row: AuditRow): AuditEvent {
  const event: AuditEvent = {};
  event.id = row.eventid as string;
  if (row.stream_ids != null) {
    const parts = (row.stream_ids as string).split(IDS_SEPARATOR);
    parts.pop(); // remove trailing ALL_EVENTS_TAG
    if (parts.length > 0) event.streamIds = parts;
  }
  if (row.time != null) event.time = row.time as number;
  if (row.end_time !== undefined) event.endTime = row.end_time as number | null;
  if (row.deleted != null) event.deleted = row.deleted as number;
  if (row.head_id != null) event.headId = row.head_id as string;
  if (row.type != null) event.type = row.type as string;
  if (row.content != null) {
    event.content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
  }
  if (row.description != null) event.description = row.description as string;
  if (row.client_data != null) {
    event.clientData = typeof row.client_data === 'string' ? JSON.parse(row.client_data as string) : row.client_data;
  }
  if (row.integrity != null) event.integrity = row.integrity as string;
  if (row.attachments != null) {
    event.attachments = typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments;
  }
  if (row.trashed === true) event.trashed = true;
  if (row.created != null) event.created = row.created as number;
  if (row.created_by != null) event.createdBy = row.created_by as string;
  if (row.modified != null) event.modified = row.modified as number;
  if (row.modified_by != null) event.modifiedBy = row.modified_by as string;
  return event;
}

function fromDBHistory (row: AuditRow): AuditEvent {
  const event = fromDB(row);
  event.id = event.headId!;
  delete event.headId;
  return event;
}

// Map API field names to DB column names
const FIELD_MAP: Record<string, string> = {
  id: 'eventid',
  headId: 'head_id',
  streamIds: 'stream_ids',
  endTime: 'end_time',
  clientData: 'client_data',
  createdBy: 'created_by',
  modifiedBy: 'modified_by'
};

function toDBFieldName (field: string): string {
  return FIELD_MAP[field] || field;
}

// -- Query builders --

function buildSelectQuery (userId: string, params: Params): { sql: string, values: unknown[] } {
  const values: unknown[] = [userId];
  let idx = 2;
  const conditions: string[] = ['user_id = $1'];

  for (const item of params.query) {
    const result = convertCondition(item, idx, values);
    if (result) {
      conditions.push(result.condition);
      idx = result.nextIdx;
    }
  }

  let sql = 'SELECT * FROM audit_events WHERE ' + conditions.join(' AND ');

  if (params.options?.sort) {
    const sorts: string[] = [];
    for (const [field, order] of Object.entries(params.options.sort) as Array<[string, number]>) {
      sorts.push(`${toDBFieldName(field)} ${order > 0 ? 'ASC' : 'DESC'}`);
    }
    sql += ' ORDER BY ' + sorts.join(', ');
  }
  if (params.options?.limit) sql += ' LIMIT ' + parseInt(String(params.options.limit));
  if (params.options?.skip) sql += ' OFFSET ' + parseInt(String(params.options.skip));

  return { sql, values };
}

function buildDeleteQuery (userId: string, params: Params): { sql: string, values: unknown[] } {
  const values: unknown[] = [userId];
  let idx = 2;
  const conditions: string[] = ['user_id = $1'];

  for (const item of params.query) {
    const result = convertCondition(item, idx, values);
    if (result) {
      conditions.push(result.condition);
      idx = result.nextIdx;
    }
  }

  return { sql: 'DELETE FROM audit_events WHERE ' + conditions.join(' AND '), values };
}

function convertCondition (item: QueryItem, idx: number, values: unknown[]): { condition: string, nextIdx: number } | null {
  // `field` only exists on comparison items; array-content items resolve to ''.
  const field = toDBFieldName((item.content as ComparisonContent)?.field || '');
  switch (item.type) {
    case 'equal':
      if (item.content.value === null) {
        return { condition: `${field} IS NULL`, nextIdx: idx };
      }
      values.push(item.content.value);
      return { condition: `${field} = $${idx}`, nextIdx: idx + 1 };
    case 'greater':
      values.push(item.content.value);
      return { condition: `${field} > $${idx}`, nextIdx: idx + 1 };
    case 'greaterOrEqual':
      values.push(item.content.value);
      return { condition: `${field} >= $${idx}`, nextIdx: idx + 1 };
    case 'lowerOrEqual':
      values.push(item.content.value);
      return { condition: `${field} <= $${idx}`, nextIdx: idx + 1 };
    case 'greaterOrEqualOrNull':
      values.push(item.content.value);
      return { condition: `(${field} >= $${idx} OR ${field} IS NULL)`, nextIdx: idx + 1 };
    case 'typesList': {
      if (!item.content || item.content.length === 0) return null;
      const parts = item.content.map((type: string) => {
        const starPos = type.indexOf('/*');
        if (starPos > 0) {
          values.push(type.substring(0, starPos + 1) + '%');
          return `type LIKE $${idx++}`;
        }
        values.push(type);
        return `type = $${idx++}`;
      });
      return { condition: `(${parts.join(' OR ')})`, nextIdx: idx };
    }
    case 'streamsQuery': {
      // ⚑ This is an AUTHORIZATION boundary: it is what keeps one access from
      // reading another access's audit trail. Two rules follow from that.
      //
      // 1. The shape is the NORMALISED one every store receives: an OR of
      //    AND-blocks, `[[{any:[…]},{not:[…]}], …]` — not a flat `{any,not}[]`.
      //    Reading it as flat made `any` undefined, produced no conditions, and
      //    returned null, which here means NO FILTER: the caller got every
      //    audit row of the user.
      // 2. Anything not understood must DENY, never fall through to "no
      //    filter". A filter that degrades to "return everything" is the wrong
      //    failure mode for this code.
      // Denying part-way through has to undo the placeholders bound so far:
      // parameters are positional, so a value left in the array with no $n
      // referencing it would shift every later condition onto the wrong value.
      const valuesAtEntry = values.length;
      const idxAtEntry = idx;
      const deny = (): { condition: string, nextIdx: number } => {
        values.length = valuesAtEntry;
        return { condition: 'FALSE', nextIdx: idxAtEntry };
      };

      const blocks = item.content as unknown;
      if (!Array.isArray(blocks) || blocks.length === 0) return deny();

      // Terms are stored space-separated (`a b ..`), so both sides are padded
      // before matching: that anchors each id between separators and stops
      // `access-1` from matching a row holding `other-access-1`, and it matches
      // the first and last terms, which have no separator on one side.
      const likeTerm = (sid: string, negated: boolean): string => {
        // `%` and `_` inside a stream id are LIKE wildcards. Unescaped, asking
        // for `access-%` matches every access — the same disclosure by another
        // route. Escaped the way the events store does it.
        values.push('% ' + sid.replace(/[\\%_]/g, (m) => '\\' + m) + ' %');
        return `(' ' || stream_ids || ' ') ${negated ? 'NOT LIKE' : 'LIKE'} $${idx++} ESCAPE '\\'`;
      };

      const orParts: string[] = [];
      for (const block of blocks) {
        // A bare object (the pre-normalisation shape) is treated as a
        // single-item block rather than rejected.
        const andItems = Array.isArray(block) ? block : [block];
        const andParts: string[] = [];

        for (const entry of andItems) {
          if (typeof entry === 'string') { // a plain stream id
            andParts.push(likeTerm(entry, false));
            continue;
          }
          if (entry == null || typeof entry !== 'object') return deny();

          const any = (entry as StreamsQuery).any;
          const not = (entry as StreamsQuery).not;

          if (Array.isArray(any) && any.length > 0) {
            // '*' means every stream: no constraint from this item.
            if (!any.includes('*')) {
              andParts.push('(' + any.map((sid) => likeTerm(sid, false)).join(' OR ') + ')');
            }
          } else if (Array.isArray(not) && not.length > 0) {
            for (const sid of not) andParts.push(likeTerm(sid, true));
          } else {
            return deny(); // an item shape we do not understand
          }
        }

        // A block with NO items at all is not "match everything", it is input
        // we cannot read — deny, per the rule above.
        if (andItems.length === 0) return deny();

        // A block whose items are all unconstrained (e.g. `any: ['*']`) does
        // mean everything, so the whole OR means everything and no filter is
        // needed. Rewind first: earlier blocks may already have bound values,
        // and returning null leaves them in the array with no $n referencing
        // them, which shifts every later condition onto the wrong value.
        if (andParts.length === 0) {
          values.length = valuesAtEntry;
          return null;
        }
        orParts.push(andParts.join(' AND '));
      }

      if (orParts.length === 0) return deny();
      // ⚑ The WHOLE disjunction must be parenthesised, not just its members.
      // The caller AND-joins this with `user_id = $1`, and AND binds tighter
      // than OR: `user_id = $1 AND (X) OR (Y)` parses as
      // `(user_id = $1 AND X) OR (Y)`, so the second branch matches rows of
      // EVERY user. That is a cross-user disclosure, worse than the
      // cross-access one this function exists to prevent.
      const disjunction = orParts.map((part) => '(' + part + ')').join(' OR ');
      return { condition: '(' + disjunction + ')', nextIdx: idx };
    }
    default:
      return null;
  }
}

export { UserAuditDatabasePG };