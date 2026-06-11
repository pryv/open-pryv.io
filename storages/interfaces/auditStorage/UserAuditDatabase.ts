/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * UserAuditDatabase interface — contract for a single per-user audit database.
 * Covers event CRUD, history, streaming, and audit queries.
 *
 * Use {@link validateUserAuditDatabase} to verify prototype-based instances.
 */

import type { Readable } from 'stream';
import type { StoredEvent } from '../_shared/domain.ts';

type QueryClause = { type: string; content: unknown };
type StreamFilter = unknown;

/** Audit events share the stored-event field set; `id` may be absent on
 *  create (engines key audit rows by `eventid`). */
export type AuditEvent = Omit<StoredEvent, 'id'> & { id?: string };

/** Migration payload: raw engine rows — converters are bypassed, so the
 *  shape is engine-specific (snake_case columns on PG). */
export type AuditExportRow = Record<string, unknown>;

interface QueryParams {
  query: QueryClause[];
  options?: { sort?: Record<string, number>, limit?: number, skip?: number };
  streams?: StreamFilter;
}

interface DeleteParams {
  query: QueryClause[];
  streams?: StreamFilter;
  options?: { limit?: number };
}

// Several methods are sync in the SQLite engine and async in the PG engine —
// the unions below model both; consumers must await.
export interface UserAuditDatabase {
  init (): Promise<void>;
  close (): void;

  getEvents (params: QueryParams): AuditEvent[] | null | Promise<AuditEvent[] | null>;
  getEventsStreamed (params: QueryParams): Readable;
  getEventDeletionsStreamed (deletedSince: number): Readable;
  getOneEvent (eventId: string): AuditEvent | null | Promise<AuditEvent | null>;
  countEvents (): number | Promise<number>;

  getAllActions (): Array<{ term: string }> | Promise<Array<{ term: string }>>;
  getAllAccesses (): Array<{ term: string }> | Promise<Array<{ term: string }>>;

  createEvent (event: AuditEvent): Promise<void>;
  createEventSync (event: AuditEvent): void;
  updateEvent (eventId: string, eventData: AuditEvent): Promise<AuditEvent | null>;

  getEventHistory (eventId: string): AuditEvent[] | Promise<AuditEvent[]>;
  minimizeEventHistory (eventId: string, fieldsToRemove: string[]): Promise<void>;
  deleteEventHistory (eventId: string): Promise<void>;
  deleteEvents (params: DeleteParams): Promise<unknown>;

  // Migration methods — raw rows, converters bypassed
  exportAllEvents (): AuditExportRow[] | Promise<AuditExportRow[]>;
  importAllEvents (events: AuditExportRow[]): Promise<void>;
}

const REQUIRED_METHODS: string[] = [
  'init',
  'close',
  'getEvents',
  'getEventsStreamed',
  'getEventDeletionsStreamed',
  'getOneEvent',
  'countEvents',
  'getAllActions',
  'getAllAccesses',
  'createEvent',
  'createEventSync',
  'updateEvent',
  'getEventHistory',
  'minimizeEventHistory',
  'deleteEventHistory',
  'deleteEvents',
  // Migration methods
  'exportAllEvents',
  'importAllEvents'
];

function validateUserAuditDatabase (instance: unknown): UserAuditDatabase {
  for (const method of REQUIRED_METHODS) {
    if (typeof (instance as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`UserAuditDatabase implementation missing method: ${method}`);
    }
  }
  return instance as UserAuditDatabase;
}

export { validateUserAuditDatabase, REQUIRED_METHODS };