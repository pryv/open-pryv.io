/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Public types of the mall component.
 *
 * `Mall` / `MallEvents` / `MallStreams` are the canonical contracts of the
 * data-access layer — import these instead of declaring local `MallLike`
 * views. The implementing classes live in Mall.ts / MallUserEvents.ts /
 * MallUserStreams.ts and declare `implements` against them.
 *
 * Events and streams flow as the stored domain shapes
 * (`StoredEvent` / `StoredStream`), re-exported here for convenience.
 */

import type { Readable } from 'node:stream';
import type { StoredEvent, StoredStream } from '../../../storages/interfaces/_shared/domain.ts';
import type { StoreSupports } from '../../../storages/shared/contentQueryConditions.ts';

export type { StoredEvent, StoredStream, StoreSupports };

// ───────────────────────── Store registration ─────────────────────────

/** Mall's view of a registered data store (built-in or custom). */
export type DataStore = {
  init: (params: Record<string, unknown>) => Promise<unknown>;
  deleteUser: (userId: string) => Promise<unknown>;
  getUserStorageInfos?: (userId: string) => Promise<{ streams?: { count: number }; events?: { count: number }; files?: { sizeKb: number } }>;
  /** Capability announcement (content-query support, …) — see
   *  pryv-datastore's DataStore.supports. */
  supports?: () => StoreSupports;
  [k: string]: unknown;
};

export type StoreDescription = { id: string; includeInStarPermission?: boolean; [k: string]: unknown };

// ───────────────────────── Transactions ─────────────────────────

export type StoreTransaction = { exec: (func: () => unknown | Promise<unknown>) => Promise<unknown> };

/** Structural view of MallTransaction (the class adds caching per store). */
export type MallTransactionLike = {
  getStoreTransaction: (storeId: string) => Promise<StoreTransaction | undefined>;
};

// ───────────────────────── Events surface ─────────────────────────

/** events.get-shaped query (see API reference); opaque to the mall, parsed
 *  per store by eventsQueryUtils. */
export type EventQuery = Record<string, unknown>;
export type EventOptions = Record<string, unknown>;
export type StoreSettings = Record<string, unknown>;
export type ParamsByStore = Record<string, { query?: EventQuery; options?: EventOptions } | undefined>;

export type AttachmentItem = { id?: string; fileName?: string; size?: number; [k: string]: unknown };

export type UpdateManySpec = {
  fieldsToSet?: Partial<StoredEvent>;
  fieldsToDelete?: string[];
  addStreams?: string[];
  removeStreams?: string[];
  filter?: (event: StoredEvent) => boolean;
};

export interface MallEvents {
  getContentQuerySupportError (storeId: string, params: unknown): string | null;
  getOne (userId: string, fullEventId: string): Promise<StoredEvent | null>;
  getHistory (userId: string, fullEventId: string): Promise<StoredEvent[]>;
  get (userId: string, params: EventQuery): Promise<StoredEvent[]>;
  getWithParamsByStore (userId: string, paramsByStore: ParamsByStore): Promise<StoredEvent[]>;
  getStreamedWithParamsByStore (userId: string, paramsByStore: ParamsByStore): Promise<Readable | Error>;
  generateStreamsWithParamsByStore (userId: string, paramsByStore: ParamsByStore, addEventsStreamCallback: (settings: StoreSettings | undefined, stream: Readable | Error) => void): Promise<void>;
  getDeletionsStreamed (storeId: string, userId: string, query: EventQuery, options?: EventOptions): Promise<AsyncIterable<StoredEvent>>;
  getDeletions (storeId: string, userId: string, query: EventQuery, options?: EventOptions): Promise<StoredEvent[]>;
  create (userId: string, eventData: Partial<StoredEvent>, mallTransaction?: MallTransactionLike | null, doNotOverrideIntegrity?: boolean): Promise<StoredEvent>;
  addAttachment (userId: string, eventId: string, attachmentItem: AttachmentItem, mallTransaction?: MallTransactionLike | null): Promise<StoredEvent>;
  getAttachment (userId: string, eventData: StoredEvent, fileId: string): Promise<unknown>;
  deleteAttachment (userId: string, eventId: string, fileId: string, mallTransaction?: MallTransactionLike | null): Promise<StoredEvent>;
  createWithAttachments (userId: string, eventDataWithoutAttachments: Partial<StoredEvent>, attachmentsItems: AttachmentItem[], mallTransaction?: MallTransactionLike | null): Promise<StoredEvent>;
  update (userId: string, newEventData: Partial<StoredEvent>, mallTransaction?: MallTransactionLike | null): Promise<StoredEvent>;
  updateMany (userId: string, query: EventQuery, update: UpdateManySpec, forEachEvent: ((e: StoredEvent | null) => unknown) | null, mallTransaction?: MallTransactionLike | null): Promise<StoredEvent[] | null>;
  updateStreamedMany (userId: string, query: EventQuery, update?: UpdateManySpec, mallTransaction?: MallTransactionLike | null): Promise<Readable>;
  delete (userId: string, originalEvent: StoredEvent, mallTransaction?: MallTransactionLike | null): Promise<void>;
  localRemoveAllNonAccountEventsForUser (userId: string): Promise<unknown>;
}

// ───────────────────────── Streams surface ─────────────────────────

export type StreamsGetParams = {
  id?: string;
  storeId?: string;
  childrenDepth?: number;
  excludedIds?: string[];
  hideStoreRoots?: boolean;
  includeTrashed?: boolean;
};

export interface MallStreams {
  getOneWithNoChildren (userId: string, streamId: string, storeId?: string | null): Promise<StoredStream | null>;
  get (userId: string, params: StreamsGetParams): Promise<StoredStream[]>;
  getDeletions (userId: string, deletedSince?: number | null, storeIds?: string[]): Promise<StoredStream[]>;
  createDeleted (userId: string, streamData: StoredStream): Promise<StoredStream>;
  create (userId: string, streamData: StoredStream): Promise<StoredStream>;
  update (userId: string, streamData: StoredStream): Promise<StoredStream>;
  delete (userId: string, streamId: string): Promise<unknown>;
  deleteAll (userId: string, storeId: string): Promise<void>;
}

// ───────────────────────── Mall ─────────────────────────

export interface Mall {
  readonly streams: MallStreams;
  readonly events: MallEvents;
  initialized: boolean;
  addStore (store: DataStore, storeDescription: StoreDescription): void;
  init (): Promise<Mall>;
  deleteUser (userId: string): Promise<void>;
  getUserStorageInfos (userId: string): Promise<Record<string, unknown>>;
  newTransaction (): Promise<MallTransactionLike>;
}
