/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { Readable } from 'stream';

interface QueryParams {
  query: Array<{ type: string; content: any }>;
  options?: { sort?: Record<string, number>; limit?: number; skip?: number };
  streams?: any;
}

interface DeleteParams {
  query: Array<{ type: string; content: any }>;
  streams?: any;
  options?: { limit?: number };
}

/**
 * UserAuditDatabase interface — per-user audit database for audit events.
 * Mixed sync/async API matching the existing implementation.
 */
export interface UserAuditDatabase {
  init(): Promise<void>;
  close(): void;

  getEvents(params: QueryParams): any[] | null;
  getEventsStreamed(params: QueryParams): Readable;
  getEventDeletionsStreamed(deletedSince: number): Readable;
  getOneEvent(eventId: string): any | null;
  countEvents(): number;

  getAllActions(): any[];
  getAllAccesses(): any[];

  createEvent(event: any): Promise<void>;
  createEventSync(event: any): void;
  updateEvent(eventId: string, eventData: any): Promise<any>;

  getEventHistory(eventId: string): any[];
  minimizeEventHistory(eventId: string, fieldsToRemove: string[]): Promise<void>;
  deleteEventHistory(eventId: string): Promise<void>;
  deleteEvents(params: DeleteParams): Promise<any>;

  // Migration methods
  exportAllEvents(): any[];
  importAllEvents(events: any[]): Promise<void>;
}

export declare function validateUserAuditDatabase(instance: any): UserAuditDatabase;

export declare const REQUIRED_METHODS: string[];
