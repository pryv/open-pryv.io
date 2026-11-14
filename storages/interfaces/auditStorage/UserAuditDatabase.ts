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

/** Parameters of {@link UserAuditDatabase.summarize}. */
export interface SummarizeParams {
  /** Inclusive lower bound of `time` (Unix seconds). */
  fromTime: number;
  /** Exclusive upper bound of `time` (Unix seconds). */
  toTime: number;
  /** Width of a slot in seconds: a row falls in slot `floor(time / slotSeconds)`. */
  slotSeconds: number;
  /**
   * Audit stream ids (`access-<id>`) a row must carry at least one of.
   * `undefined` means no stream filter. Any other value must be a non-empty
   * array of non-empty strings, none of them `*`; anything else (empty array,
   * `null`, a non-string item) DENIES and the result is empty, never "no filter".
   */
  accessStreamIds?: string[];
  /** `Date.now()` value after which the engine gives up with a {@link SUMMARY_BUDGET_ERROR_CODE} error. */
  deadline?: number;
}

/** One group of {@link UserAuditDatabase.summarize}: rows of a slot, method id and outcome. */
export interface SummaryGroup {
  slot: number;
  /** `content.action` of the rows (the method id), or null when absent. */
  action: string | null;
  /** True for rows of type `audit-log/pryv-api-error`. */
  error: boolean;
  count: number;
}

/** `code` of the error `summarize` throws when its deadline is reached. */
export const SUMMARY_BUDGET_ERROR_CODE = 'SUMMARY_BUDGET';

/** The error an engine throws when `summarize` runs past its deadline (match on `code`). */
export function summaryBudgetError (): Error & { code: string } {
  const err = new Error('Audit summary work budget exhausted') as Error & { code: string };
  err.code = SUMMARY_BUDGET_ERROR_CODE;
  return err;
}

/** Row type counted as an error by `summarize`. */
export const SUMMARY_ERROR_TYPE = 'audit-log/pryv-api-error';

/**
 * Validates `accessStreamIds` for `summarize`: `undefined` gives `null` (no
 * filter), a usable list is returned as is, and anything else gives `false`
 * (deny: the caller must answer with no groups).
 */
export function summaryAccessFilter (accessStreamIds: unknown): string[] | null | false {
  if (accessStreamIds === undefined) return null;
  if (!Array.isArray(accessStreamIds) || accessStreamIds.length === 0) return false;
  for (const id of accessStreamIds) {
    if (typeof id !== 'string' || id.length === 0 || id === '*') return false;
  }
  return accessStreamIds as string[];
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

  /**
   * Counts of head, non-deleted rows with `fromTime <= time < toTime`, grouped
   * by slot, `content.action` and outcome (error type or not). Raw groups only:
   * classes and calendar buckets are computed by the caller, once for every
   * engine. Throws a {@link SUMMARY_BUDGET_ERROR_CODE} error past `deadline`.
   */
  summarize (params: SummarizeParams): Promise<SummaryGroup[]>;

  // Migration methods — raw rows, converters bypassed
  exportAllEvents (): AuditExportRow[] | Promise<AuditExportRow[]>;
  /**
   * Optional streaming counterpart of exportAllEvents (bounded memory for
   * backup). When present, yields the same raw rows as exportAllEvents. Order
   * is NOT guaranteed: neither runs an ORDER BY, so consumers that care must
   * sort (the conformance check compares as sets). Not in REQUIRED_METHODS: engines may implement only the
   * array form, and consumers feature-detect this method.
   */
  exportAllEventsStreamed? (): AsyncIterable<AuditExportRow>;
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
  'summarize',
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
