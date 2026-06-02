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

type QueryClause = { type: string; content: unknown };
type StreamFilter = unknown;
type AuditEvent = { id?: string; [k: string]: unknown };

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

export interface UserAuditDatabase {
  init (): Promise<void>;
  close (): void;

  getEvents (params: QueryParams): AuditEvent[] | null;
  getEventsStreamed (params: QueryParams): Readable;
  getEventDeletionsStreamed (deletedSince: number): Readable;
  getOneEvent (eventId: string): AuditEvent | null;
  countEvents (): number;

  getAllActions (): unknown[];
  getAllAccesses (): unknown[];

  createEvent (event: AuditEvent): Promise<void>;
  createEventSync (event: AuditEvent): void;
  updateEvent (eventId: string, eventData: AuditEvent): Promise<AuditEvent>;

  getEventHistory (eventId: string): AuditEvent[];
  minimizeEventHistory (eventId: string, fieldsToRemove: string[]): Promise<void>;
  deleteEventHistory (eventId: string): Promise<void>;
  deleteEvents (params: DeleteParams): Promise<unknown>;

  // Migration methods
  exportAllEvents (): AuditEvent[];
  importAllEvents (events: AuditEvent[]): Promise<void>;
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