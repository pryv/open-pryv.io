/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Readable as ReadableType } from 'node:stream';
const require = createRequire(import.meta.url);

const { createId: cuid } = require('@paralleldrive/cuid2');
const ds = require('@pryv/datastore');
const errors = ds.errors;
const timestamp = require('unix-timestamp');
const { DeletionModesFields } = require('../../../../shared/DeletionModesFields.ts');
const { localStoreEventQueries } = require('../../../../shared/localStoreEventQueries.ts');

import type { StoredEvent } from '../../../../interfaces/_shared/domain.ts';
/** Datastore-level event: the canonical stored shape plus the open tail the
 *  deletion-mode field scrubbing indexes dynamically. */
type EventLike = StoredEvent & { [k: string]: unknown };
type DeletionSettings = {
  mode: 'keep-nothing' | 'keep-authors' | 'keep-everything' | string;
  fields: string[];
  removeAttachments: boolean;
};
type Settings = { versioning?: { deletionMode?: string; forceKeepHistory?: boolean } };
type SystemStreams = { accountStreamIds?: string[] };
type StoreQuery = unknown;
type StoreOptions = unknown;
// Per-user SQLite DB handle (userSQLite/UserDatabase) — the methods used here.
// getEvents is modelled as EventLike[]: better-sqlite3 `.all()` always yields an
// array, so UserDatabase's `| null` branch is unreachable.
type UserDbLike = {
  getOneEvent: (eventId: string) => EventLike | null;
  getEvents: (params: { query: unknown[]; options: unknown }) => EventLike[];
  getEventsStreamed: (params: { query: unknown[]; options: unknown }) => ReadableType;
  getEventDeletionsStreamed: (deletedSince: number) => ReadableType;
  getEventHistory: (eventId: string) => EventLike[];
  createEvent: (event: EventLike) => Promise<void>;
  updateEvent: (eventId: string, eventData: EventLike) => Promise<EventLike | null>;
  minimizeEventHistory: (eventId: string, fieldsToRemove: string[]) => Promise<void>;
  deleteEventHistory: (eventId: string) => Promise<void>;
  deleteEvents: (params: { query: unknown[]; options?: unknown }) => Promise<{ changes: number } | null>;
  countEvents: () => number;
};
type StorageFactory = { forUser: (userId: string) => Promise<UserDbLike> };
type EventsFileStorageLike = {
  removeAllForEvent: (userId: string, eventId: string) => Promise<void>;
  removeAllForUser: (userId: string) => Promise<void>;
  getFileStorageInfos: (userId: string) => Promise<number>;
};

type Store = {
  storage: StorageFactory;
  eventsFileStorage: EventsFileStorageLike;
  settings: Settings;
  setIntegrityOnEvent: (event: EventLike) => void;
  accountStreamIds: string[];
  deletionSettings: DeletionSettings;
  keepHistory: boolean;
  // own helper method of the store literal, so `this.<helper>()` typechecks
  _generateVersionIfNeeded (db: UserDbLike, eventId: string, originalEvent?: EventLike | null, transaction?: unknown): Promise<void>;
};

/**
 * Local data store: events implementation.
 */
const userEvents = ds.createUserEvents({
  storage: null,
  eventsFileStorage: null,
  deletionSettings: null,
  keepHistory: null,
  setIntegrityOnEvent: null,

  init (this: Store, storage: StorageFactory, eventsFileStorage: EventsFileStorageLike, settings: Settings, setIntegrityOnEventFn: (event: EventLike) => void, systemStreams: SystemStreams): void {
    this.storage = storage;
    this.eventsFileStorage = eventsFileStorage;
    this.settings = settings;
    this.setIntegrityOnEvent = setIntegrityOnEventFn;
    this.accountStreamIds = systemStreams?.accountStreamIds || [];
    const mode = this.settings.versioning?.deletionMode || 'keep-nothing';
    const fields = DeletionModesFields[mode] || ['integrity'];
    this.deletionSettings = {
      mode,
      fields,
      removeAttachments: fields.includes('attachments')
    };
    this.keepHistory = this.settings.versioning?.forceKeepHistory || false;
  },

  async getOne (this: Store, userId: string, eventId: string): Promise<EventLike | null> {
    const db = await this.storage.forUser(userId);
    return db.getOneEvent(eventId);
  },

  async get (this: Store, userId: string, storeQuery: StoreQuery, storeOptions: StoreOptions): Promise<EventLike[]> {
    const db = await this.storage.forUser(userId);
    const query = localStoreEventQueries.localStorePrepareQuery(storeQuery);
    const options = localStoreEventQueries.localStorePrepareOptions(storeOptions);
    return db.getEvents({ query, options });
  },

  async getStreamed (this: Store, userId: string, storeQuery: StoreQuery, storeOptions: StoreOptions): Promise<ReadableType> {
    const db = await this.storage.forUser(userId);
    const query = localStoreEventQueries.localStorePrepareQuery(storeQuery);
    const options = localStoreEventQueries.localStorePrepareOptions(storeOptions);
    return db.getEventsStreamed({ query, options });
  },

  async getDeletionsStreamed (this: Store, userId: string, query: { deletedSince: number }, _options: unknown): Promise<ReadableType> {
    const db = await this.storage.forUser(userId);
    return db.getEventDeletionsStreamed(query.deletedSince);
  },

  async getHistory (this: Store, userId: string, eventId: string): Promise<EventLike[]> {
    const db = await this.storage.forUser(userId);
    return db.getEventHistory(eventId);
  },

  async create (this: Store, userId: string, event: EventLike, _transaction: unknown): Promise<EventLike> {
    const db = await this.storage.forUser(userId);
    try {
      await db.createEvent(event);
      return event;
    } catch (err: unknown) {
      if ((err as Error).message === 'UNIQUE constraint failed: events.eventid') {
        throw errors.itemAlreadyExists('event', { id: event.id }, err);
      }
      throw errors.unexpectedError(err);
    }
  },

  // `null` when no row matched — mirrors the PG peer's update semantics.
  async update (this: Store, userId: string, eventData: EventLike, transaction: unknown): Promise<EventLike | null> {
    const db = await this.storage.forUser(userId);
    await this._generateVersionIfNeeded(db, eventData.id, null, transaction);
    try {
      return db.updateEvent(eventData.id, eventData);
    } catch (err: unknown) {
      if ((err as Error).message === 'UNIQUE constraint failed: events.eventid') {
        throw errors.itemAlreadyExists('event', { id: eventData.id }, err);
      }
      throw errors.unexpectedError(err);
    }
  },

  async delete (this: Store, userId: string, originalEvent: EventLike, transaction: unknown): Promise<unknown> {
    const db = await this.storage.forUser(userId);
    await this._generateVersionIfNeeded(db, originalEvent.id, originalEvent, transaction);
    const deletedEventContent: EventLike = structuredClone(originalEvent);
    const eventId = deletedEventContent.id;

    // if attachments are to be deleted
    if (this.deletionSettings.removeAttachments && deletedEventContent.attachments != null && deletedEventContent.attachments.length > 0) {
      await this.eventsFileStorage.removeAllForEvent(userId, eventId);
    }
    // eventually delete or update history
    if (this.deletionSettings.mode === 'keep-nothing') await db.deleteEventHistory(eventId);
    if (this.deletionSettings.mode === 'keep-authors') {
      await db.minimizeEventHistory(eventId, this.deletionSettings.fields);
    }

    // prepare event content for DB
    deletedEventContent.deleted = timestamp.now();
    for (const field of this.deletionSettings.fields) {
      delete deletedEventContent[field];
    }
    this.setIntegrityOnEvent(deletedEventContent);
    delete (deletedEventContent as Partial<EventLike>).id;
    return await db.updateEvent(eventId, deletedEventContent);
  },

  async _generateVersionIfNeeded (this: Store, db: UserDbLike, eventId: string, originalEvent: EventLike | null = null, _transaction: unknown = null): Promise<void> {
    if (!this.keepHistory) return;
    let versionItem: EventLike;
    if (originalEvent != null) {
      versionItem = structuredClone(originalEvent);
    } else {
      // History generation is only requested for events known to exist.
      versionItem = (await db.getOneEvent(eventId))!;
    }
    versionItem.headId = eventId;
    versionItem.id = cuid();
    await db.createEvent(versionItem);
  },

  async _deleteUser (this: Store, userId: string): Promise<unknown> {
    const db = await this.storage.forUser(userId);
    await this.eventsFileStorage.removeAllForUser(userId);
    return await db.deleteEvents({ query: [] });
  },

  async _getStorageInfos (this: Store, userId: string): Promise<{ count: number }> {
    const db = await this.storage.forUser(userId);
    const count = db.countEvents();
    return { count };
  },

  async _getFilesStorageInfos (this: Store, userId: string): Promise<{ sizeKb: number }> {
    const sizeKb = await this.eventsFileStorage.getFileStorageInfos(userId);
    return { sizeKb };
  },

  /**
    * Local stores only - as long as SystemStreams are embedded
    */
  async removeAllNonAccountEventsForUser (this: Store, userId: string): Promise<unknown> {
    const db = await this.storage.forUser(userId);
    const allAccountStreamIds = this.accountStreamIds;
    const query = [{ type: 'streamsQuery', content: [[{ any: ['*'] }, { not: allAccountStreamIds }]] }];
    const res = await db.deleteEvents({ query, options: {} });
    await this.eventsFileStorage.removeAllForUser(userId);
    return res;
  }
});

export { userEvents };
