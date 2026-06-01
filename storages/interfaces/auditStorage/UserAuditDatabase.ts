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

interface QueryParams {
  query: Array<{ type: string, content: any }>;
  options?: { sort?: Record<string, number>, limit?: number, skip?: number };
  streams?: any;
}

interface DeleteParams {
  query: Array<{ type: string, content: any }>;
  streams?: any;
  options?: { limit?: number };
}

export interface UserAuditDatabase {
  init (): Promise<void>;
  close (): void;

  getEvents (params: QueryParams): Promise<any[] | null>;
  getEventsStreamed (params: QueryParams): Readable;
  getEventDeletionsStreamed (deletedSince: number): Readable;
  getOneEvent (eventId: string): Promise<any | null>;
  countEvents (): Promise<number>;

  getAllActions (): Promise<any[]>;
  getAllAccesses (): Promise<any[]>;

  createEvent (event: any): Promise<void>;
  updateEvent (eventId: string, eventData: any): Promise<any>;

  getEventHistory (eventId: string): Promise<any[]>;
  minimizeEventHistory (eventId: string, fieldsToRemove: string[]): Promise<void>;
  deleteEventHistory (eventId: string): Promise<void>;
  deleteEvents (params: DeleteParams): Promise<any>;

  // Migration methods
  exportAllEvents (): Promise<any[]>;
  importAllEvents (events: any[]): Promise<void>;
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
  'updateEvent',
  'getEventHistory',
  'minimizeEventHistory',
  'deleteEventHistory',
  'deleteEvents',
  // Migration methods
  'exportAllEvents',
  'importAllEvents'
];

function validateUserAuditDatabase (instance: any): UserAuditDatabase {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UserAuditDatabase implementation missing method: ${method}`);
    }
  }
  return instance;
}

export { validateUserAuditDatabase, REQUIRED_METHODS };