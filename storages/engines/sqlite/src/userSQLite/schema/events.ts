/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

type SchemaCol = { type: string; index?: boolean; coerce: 'txt' | 'num' | 'bool' };
type DbSchemaMap = Record<string, SchemaCol>;
type Schema = {
  dbSchema: DbSchemaMap;
  ALL_EVENTS_TAG: string;
  toDB: (event: EventLike) => DbEvent;
  fromDB: (dbEvent: DbEvent) => EventLike;
  fromDBHistory: (event: DbEvent) => EventLike;
};
type EventLike = { id?: string; streamIds?: string[]; time?: number; endTime?: number | null; deleted?: number | null; integrity?: string | null; headId?: string | null; type?: string; content?: unknown; description?: string; created?: number; clientData?: unknown; attachments?: unknown; trashed?: boolean; createdBy?: string; modifiedBy?: string; modified?: number; [k: string]: unknown };
type DbEvent = { eventid?: string; streamIds?: string | string[]; trashed?: number | boolean; content?: string | null; attachments?: string | null; clientData?: string | null; [k: string]: unknown };

const schema: Schema = {
  dbSchema: {
    eventid: { type: 'TEXT UNIQUE', index: true, coerce: 'txt' },
    headId: { type: 'TEXT DEFAULT NULL', coerce: 'txt' },
    streamIds: { type: 'TEXT', coerce: 'txt' },
    time: { type: 'REAL', index: true, coerce: 'num' },
    deleted: { type: 'REAL DEFAULT NULL', index: true, coerce: 'num' },
    endTime: { type: 'REAL', index: true, coerce: 'num' },
    type: { type: 'TEXT', index: true, coerce: 'txt' },
    content: { type: 'TEXT', coerce: 'txt' },
    description: { type: 'TEXT', coerce: 'txt' },
    clientData: { type: 'TEXT', coerce: 'txt' },
    integrity: { type: 'TEXT', coerce: 'txt' },
    attachments: { type: 'TEXT', coerce: 'txt' },
    trashed: { type: 'INTEGER DEFAULT 0', index: true, coerce: 'bool' },
    created: { type: 'REAL', index: true, coerce: 'num' },
    createdBy: { type: 'TEXT', index: true, coerce: 'txt' },
    modified: { type: 'REAL', index: true, coerce: 'num' },
    modifiedBy: { type: 'TEXT', index: true, coerce: 'txt' }
  },

  ALL_EVENTS_TAG: '..',

  toDB,
  fromDB,
  fromDBHistory
};

const IDS_SEPARATOR = ' ';

/**
 * Thrown by `toDB` for a stream id the stored form cannot hold. Such a stream
 * can still exist: one created before stream ids were refused whitespace.
 * The store turns it into a 4xx naming the stream.
 */
class UnstorableStreamIdError extends Error {
  streamId: unknown;
  constructor (eventId: unknown, streamId: unknown) {
    super(`Event ${JSON.stringify(eventId)}: stream id ${JSON.stringify(streamId)} cannot be stored (empty, "${schema.ALL_EVENTS_TAG}", or holding a space or NUL)`);
    this.name = 'UnstorableStreamIdError';
    this.streamId = streamId;
  }
}

function toDB (event: EventLike): DbEvent {
  const dbEvent: DbEvent = {};
  dbEvent.eventid = event.id;

  // An empty list (`removeStreams` can empty one) is stored like no list: the
  // tag alone, read back without `streamIds`. Joined, it would read back as [''].
  if (event.streamIds == null || (Array.isArray(event.streamIds) && event.streamIds.length === 0)) {
    dbEvent.streamIds = schema.ALL_EVENTS_TAG;
  } else {
    if (!Array.isArray(event.streamIds)) throw new Error('streamIds must be an Array');
    // The stored form is the ids joined by a space plus the tag every event
    // carries: an id that is empty, the tag, or holds the separator (or NUL)
    // would be read back as other stream ids.
    for (const id of event.streamIds) {
      if (typeof id !== 'string' || id === '' || id === schema.ALL_EVENTS_TAG || id.includes(IDS_SEPARATOR) || id.includes('\u0000')) {
        throw new UnstorableStreamIdError(event.id, id);
      }
    }
    dbEvent.streamIds = event.streamIds.join(IDS_SEPARATOR) + IDS_SEPARATOR + schema.ALL_EVENTS_TAG;
  }

  dbEvent.time = nullIfUndefined(event.time);

  dbEvent.endTime = nullIfUndefined(event.endTime);
  dbEvent.deleted = nullIfUndefined(event.deleted);
  dbEvent.integrity = nullIfUndefined(event.integrity);
  dbEvent.headId = nullIfUndefined(event.headId);

  dbEvent.type = nullIfUndefined(event.type);

  dbEvent.content = nullOrJSON(event.content);

  dbEvent.description = nullIfUndefined(event.description);
  dbEvent.created = nullIfUndefined(event.created);
  dbEvent.clientData = nullOrJSON(event.clientData);
  dbEvent.attachments = nullOrJSON(event.attachments);
  dbEvent.trashed = (event.trashed) ? 1 : 0;
  dbEvent.createdBy = nullIfUndefined(event.createdBy);
  dbEvent.modifiedBy = nullIfUndefined(event.modifiedBy);
  dbEvent.modified = nullIfUndefined(event.modified);

  return dbEvent;
}

function nullIfUndefined<T> (value: T | undefined): T | null {
  return (typeof value !== 'undefined') ? value : null;
}

function nullOrJSON (value: unknown): string | null {
  if (typeof value === 'undefined' || value === null) return null;
  return JSON.stringify(value);
}

function fromDB (dbEvent: DbEvent): EventLike {
  if (dbEvent.streamIds != null) {
    dbEvent.streamIds = (dbEvent.streamIds as string).split(IDS_SEPARATOR);
    (dbEvent.streamIds as string[]).pop(); // pop removes the last element which is set on all events ALL_EVENTS_TAG
    if ((dbEvent.streamIds as string[]).length === 0) delete dbEvent.streamIds; // it was a "deleted" event
  }

  dbEvent.id = dbEvent.eventid;
  delete dbEvent.eventid;

  if (dbEvent.trashed === 1) {
    dbEvent.trashed = true;
  } else {
    delete dbEvent.trashed; // don't return to API if false
  }

  if (dbEvent.content != null) {
    dbEvent.content = JSON.parse(dbEvent.content as string);
  }

  if (dbEvent.attachments != null) {
    dbEvent.attachments = JSON.parse(dbEvent.attachments as string);
  }

  if (dbEvent.clientData != null) {
    dbEvent.clientData = JSON.parse(dbEvent.clientData as string);
  }

  for (const key of Object.keys(dbEvent)) {
    // delete all `null` fields except `endTime` (in which case `null` means "running")
    if (key !== 'endTime' && dbEvent[key] == null) delete dbEvent[key];
  }

  return dbEvent as EventLike;
}

function fromDBHistory (dbEvent: DbEvent): EventLike {
  const event = fromDB(dbEvent);
  event.id = event.headId ?? undefined;
  delete event.headId;
  return event;
}

const dbSchema = schema.dbSchema;
const ALL_EVENTS_TAG = schema.ALL_EVENTS_TAG;
export { dbSchema, ALL_EVENTS_TAG, toDB, fromDB, fromDBHistory, UnstorableStreamIdError };
