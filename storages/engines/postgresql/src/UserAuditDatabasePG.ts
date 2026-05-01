/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const { Readable } = require('stream');

const ALL_EVENTS_TAG = '..';
const IDS_SEPARATOR = ' ';

class UserAuditDatabasePG {
  db: any;
  userId: string;
  logger: any;

  constructor (db: any, userId: string, logger: any) {
    this.db = db;
    this.userId = userId;
    this.logger = logger.getLogger('audit-user-pg');
  }

  async init (): Promise<void> {
    // No-op: schema created by DatabasePG.initSchema()
  }

  close (): void {
    // No-op: connection pool is shared
  }

  async getEvents (params: any): Promise<any[]> {
    params.query.push({ type: 'equal', content: { field: 'deleted', value: null } });
    params.query.push({ type: 'equal', content: { field: 'head_id', value: null } });
    const { sql, values } = buildSelectQuery(this.userId, params);
    const res = await this.db.query(sql, values);
    return res.rows.map(fromDB);
  }

  getEventsStreamed (params: any): any {
    params.query.push({ type: 'equal', content: { field: 'deleted', value: null } });
    params.query.push({ type: 'equal', content: { field: 'head_id', value: null } });
    const { sql, values } = buildSelectQuery(this.userId, params);
    const db = this.db;
    let rows: any[] | null = null;
    let idx = 0;
    return new Readable({
      objectMode: true,
      async read (this: any) {
        if (rows === null) {
          const res = await db.query(sql, values);
          rows = res.rows;
        }
        if (idx < rows!.length) {
          this.push(fromDB(rows![idx++]));
        } else {
          this.push(null);
        }
      }
    });
  }

  getEventDeletionsStreamed (deletedSince: number): any {
    const db = this.db;
    const userId = this.userId;
    let rows: any[] | null = null;
    let idx = 0;
    return new Readable({
      objectMode: true,
      async read (this: any) {
        if (rows === null) {
          const res = await db.query(
            'SELECT * FROM audit_events WHERE user_id = $1 AND deleted >= $2 ORDER BY deleted DESC',
            [userId, deletedSince]
          );
          rows = res.rows;
        }
        if (idx < rows!.length) {
          this.push(fromDB(rows![idx++]));
        } else {
          this.push(null);
        }
      }
    });
  }

  async getOneEvent (eventId: string): Promise<any | null> {
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
    return res.rows[0].count;
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
      .filter((r: any) => r.term && r.term.startsWith(prefix))
      .map((r: any) => ({ term: r.term }));
  }

  async createEvent (event: any): Promise<void> {
    const row = toDB(event);
    await this.db.query(
      `INSERT INTO audit_events (user_id, eventid, head_id, stream_ids, time, deleted, end_time, type, content, description, client_data, integrity, attachments, trashed, created, created_by, modified, modified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [this.userId, row.eventid, row.head_id, row.stream_ids, row.time, row.deleted, row.end_time, row.type, row.content, row.description, row.client_data, row.integrity, row.attachments, row.trashed, row.created, row.created_by, row.modified, row.modified_by]
    );
  }

  async createEventSync (event: any): Promise<void> {
    return this.createEvent(event);
  }

  async updateEvent (eventId: string, eventData: any): Promise<any | null> {
    const row = toDB(eventData);
    delete row.eventid;
    if (row.stream_ids == null) row.stream_ids = ALL_EVENTS_TAG;

    const fields = Object.keys(row).filter(k => row[k] !== undefined);
    if (fields.length === 0) return null;

    let idx = 3;
    const setClauses: string[] = [];
    const values: any[] = [this.userId, eventId];
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

  async getEventHistory (eventId: string): Promise<any[]> {
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

  async deleteEvents (params: any): Promise<{ changes: number }> {
    if (params.streams) {
      throw new Error('Events DELETE with stream query not supported yet');
    }
    const { sql, values } = buildDeleteQuery(this.userId, params);
    const res = await this.db.query(sql, values);
    return { changes: res.rowCount };
  }

  async exportAllEvents (): Promise<any[]> {
    const res = await this.db.query(
      'SELECT * FROM audit_events WHERE user_id = $1',
      [this.userId]
    );
    return res.rows;
  }

  async importAllEvents (events: any[]): Promise<void> {
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

function nullIfUndefined (value: any): any {
  return (typeof value !== 'undefined') ? value : null;
}

function toDB (event: any): any {
  const row: any = {};
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

function fromDB (row: any): any {
  const event: any = {};
  event.id = row.eventid;
  if (row.stream_ids != null) {
    const parts = row.stream_ids.split(IDS_SEPARATOR);
    parts.pop(); // remove trailing ALL_EVENTS_TAG
    if (parts.length > 0) event.streamIds = parts;
  }
  if (row.time != null) event.time = row.time;
  if (row.end_time !== undefined) event.endTime = row.end_time;
  if (row.deleted != null) event.deleted = row.deleted;
  if (row.head_id != null) event.headId = row.head_id;
  if (row.type != null) event.type = row.type;
  if (row.content != null) {
    event.content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
  }
  if (row.description != null) event.description = row.description;
  if (row.client_data != null) {
    event.clientData = typeof row.client_data === 'string' ? JSON.parse(row.client_data) : row.client_data;
  }
  if (row.integrity != null) event.integrity = row.integrity;
  if (row.attachments != null) {
    event.attachments = typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments;
  }
  if (row.trashed === true) event.trashed = true;
  if (row.created != null) event.created = row.created;
  if (row.created_by != null) event.createdBy = row.created_by;
  if (row.modified != null) event.modified = row.modified;
  if (row.modified_by != null) event.modifiedBy = row.modified_by;
  return event;
}

function fromDBHistory (row: any): any {
  const event = fromDB(row);
  event.id = event.headId;
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

function buildSelectQuery (userId: string, params: any): { sql: string, values: any[] } {
  const values: any[] = [userId];
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
  if (params.options?.limit) sql += ' LIMIT ' + parseInt(params.options.limit);
  if (params.options?.skip) sql += ' OFFSET ' + parseInt(params.options.skip);

  return { sql, values };
}

function buildDeleteQuery (userId: string, params: any): { sql: string, values: any[] } {
  const values: any[] = [userId];
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

function convertCondition (item: any, idx: number, values: any[]): { condition: string, nextIdx: number } | null {
  const field = toDBFieldName(item.content?.field || '');
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
      const parts: string[] = [];
      for (const sq of item.content as any[]) {
        if (sq.any && sq.any.length > 0) {
          const anyParts = sq.any.map((sid: string) => {
            values.push('%' + sid + ' %');
            return `stream_ids LIKE $${idx++}`;
          });
          parts.push('(' + anyParts.join(' OR ') + ')');
        }
        if (sq.not && sq.not.length > 0) {
          for (const sid of sq.not as string[]) {
            values.push('%' + sid + ' %');
            parts.push(`stream_ids NOT LIKE $${idx++}`);
          }
        }
      }
      if (parts.length === 0) return null;
      return { condition: parts.join(' AND '), nextIdx: idx };
    }
    default:
      return null;
  }
}

module.exports = UserAuditDatabasePG;
