/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
import type { Readable as ReadableType } from 'node:stream';
const require = createRequire(import.meta.url);

const { deepMerge } = require('utils');
const assert = require('assert');
// Typed handle so `throwAPIError: never` flows into return-type inference.
const storeDataUtils: typeof import('./helpers/storeDataUtils.ts') = require('./helpers/storeDataUtils.ts');
const eventsUtils = require('./helpers/eventsUtils.ts');
const eventsQueryUtils = require('./helpers/eventsQueryUtils.ts');

const errorFactory = require('errors').factory;
const { getConditionsSupportError } = require('../../../storages/shared/contentQueryConditions.ts');
import type { NormalizedCondition, StoreSupports } from '../../../storages/shared/contentQueryConditions.ts';
const integrity = require('business/src/integrity/index.ts').default;


const { Readable } = require('stream');

const { createId: cuid } = require('@paralleldrive/cuid2');

import type { MallEvents, EventQuery, EventOptions, StoreSettings, ParamsByStore, AttachmentItem, UpdateManySpec, MallTransactionLike, StoredEvent } from './types.ts';

/** Mall-level event: the stored shape, plus pass-through of store-specific
 *  extra fields (deepMerge/fieldsToDelete pipelines index by field name). */
type EventLike = StoredEvent & { [k: string]: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventsStore = any; // Each store's UserEvents implementation; varied per backend.
type StoresHolder = {
  storesById: Map<string, { events: EventsStore, supports?: () => StoreSupports }>;
  storeDescriptionsByStore: Map<unknown, { settings: StoreSettings }>;
};
type Transaction = MallTransactionLike | null | undefined;

/**
 * Storage for events.
 * Dispatches requests to each data store's events.
 */
class MallUserEvents implements MallEvents {
  eventsStores: Map<string, EventsStore> = new Map();
  storeSettings: Map<string, StoreSettings> = new Map();
  storeSupports: Map<string, StoreSupports> = new Map();

  constructor (storesHolder: StoresHolder) {
    for (const [storeId, store] of storesHolder.storesById) {
      this.eventsStores.set(storeId, store.events);
      this.storeSettings.set(storeId, storesHolder.storeDescriptionsByStore.get(store)!.settings);
      this.storeSupports.set(storeId, typeof store.supports === 'function' ? store.supports() : {});
    }
  }

  /**
   * Check content/clientData conditions in `params` against the store's
   * capability declaration (`DataStore.supports`). Returns an error detail
   * string, or null when the store can serve the query.
   */
  getContentQuerySupportError (storeId: string, params: unknown): string | null {
    if (params == null || typeof params !== 'object') return null;
    const p = params as { content?: NormalizedCondition[], clientData?: NormalizedCondition[] };
    if (p.content == null && p.clientData == null) return null;
    const conditions = [...(p.content ?? []), ...(p.clientData ?? [])];
    const detail = getConditionsSupportError(this.storeSupports.get(storeId), conditions);
    return detail == null ? null : `Store '${storeId}': ${detail}.`;
  }

  _assertContentQuerySupported (storeId: string, params: unknown): void {
    const detail = this.getContentQuerySupportError(storeId, params);
    if (detail != null) throw errorFactory.invalidOperation(detail);
  }

  // ----------------- GET ----------------- //

  /**
   * Get one event without filtering
   * Should also return eventual deleted events
   */
  async getOne (userId: string, fullEventId: string): Promise<EventLike | null> {
    const [storeId, storeEventId] = storeDataUtils.parseStoreIdAndStoreItemId(fullEventId);
    const eventsStore = this.eventsStores.get(storeId);
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    try {
      const event = await eventsStore.getOne(userId, storeEventId);
      if (event != null) {
        const converted = eventsUtils.convertEventFromStore(storeId, event);
        if (storeId === storeDataUtils.AccountStoreId && integrity.events.isActive) {
          integrity.events.set(converted);
        }
        return converted;
      }
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
    // Account events have plain field-name IDs (e.g. 'language') that route
    // to the local store. Fall back to the account store when not found locally.
    if (storeId === storeDataUtils.LocalStoreId) {
      const accountStoreId = storeDataUtils.AccountStoreId;
      const accountStore = this.eventsStores.get(accountStoreId);
      if (accountStore) {
        try {
          const event = await accountStore.getOne(userId, fullEventId);
          if (event != null) {
            const converted = eventsUtils.convertEventFromStore(accountStoreId, event);
            if (integrity.events.isActive) integrity.events.set(converted);
            return converted;
          }
        } catch (e) {
          // Ignore — account store doesn't have it either
        }
      }
    }
    return null;
  }

  async getHistory (userId: string, fullEventId: string): Promise<EventLike[]> {
    const [storeId, storeEventId] = storeDataUtils.parseStoreIdAndStoreItemId(fullEventId);
    const eventsStore = this.eventsStores.get(storeId);
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    const res: EventLike[] = [];
    try {
      const events = await eventsStore.getHistory(userId, storeEventId);
      for (const event of events) {
        const converted = eventsUtils.convertEventFromStore(storeId, event);
        if (storeId === storeDataUtils.AccountStoreId && integrity.events.isActive) {
          integrity.events.set(converted);
        }
        res.push(converted);
      }
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
    return res;
  }

  async get (userId: string, params: EventQuery): Promise<EventLike[]> {
    return await this.getWithParamsByStore(userId, eventsQueryUtils.getParamsByStore(params));
  }

  /**
   * Specific to Mall, allow query with a prepared query by store
   */
  async getWithParamsByStore (userId: string, paramsByStore: ParamsByStore): Promise<EventLike[]> {
    const res: EventLike[] = [];
    for (const storeId of Object.keys(paramsByStore)) {
      const eventsStore = this.eventsStores.get(storeId);
      const params = paramsByStore[storeId];
      this._assertContentQuerySupported(storeId, params);
      try {
        const query = eventsQueryUtils.getStoreQueryFromParams(params);
        const options = eventsQueryUtils.getStoreOptionsFromParams(params);
        const events = await eventsStore.get(userId, query, options);
        for (const event of events) {
          res.push(eventsUtils.convertEventFromStore(storeId, event));
        }
      } catch (e) {
        storeDataUtils.throwAPIError(e, storeId);
      }
    }
    return res;
  }

  /**
   * Specific to Mall, allow query with a prepared query by store
   */
  async getStreamedWithParamsByStore (userId: string, paramsByStore: ParamsByStore): Promise<ReadableType | Error> {
    if (Object.keys(paramsByStore).length !== 1) {
      return new Error('getStreamed only supported for one store at a time');
    }
    const storeId = Object.keys(paramsByStore)[0];
    const eventsStore = this.eventsStores.get(storeId);
    const params = paramsByStore[storeId];
    this._assertContentQuerySupported(storeId, params);
    try {
      const query = eventsQueryUtils.getStoreQueryFromParams(params);
      const options = eventsQueryUtils.getStoreOptionsFromParams(params);

      const eventsStreamFromDB = await eventsStore.getStreamed(userId, query, options);
      return eventsStreamFromDB.pipe(new eventsUtils.ConvertEventFromStoreStream(storeId));
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
  }

  /**
   * To create a streamed result from multiple stores. 'events.get' pass a callback in order to add the streams
   * To the result;
   */
  async generateStreamsWithParamsByStore (userId: string, paramsByStore: ParamsByStore, addEventsStreamCallback: (settings: StoreSettings | undefined, stream: ReadableType | Error) => void): Promise<void> {
    for (const storeId of Object.keys(paramsByStore)) {
      const settings = this.storeSettings.get(storeId);
      const params = paramsByStore[storeId];
      try {
        addEventsStreamCallback(settings, await this.getStreamedWithParamsByStore(userId, { [storeId]: params }));
      } catch (e) {
        storeDataUtils.throwAPIError(e, storeId);
      }
    }
  }

  /**
   * @param [options]
   */
  async getDeletionsStreamed (storeId: string, userId: string, query: EventQuery, options?: EventOptions): Promise<AsyncIterable<EventLike>> {
    const eventsStore = this.eventsStores.get(storeId);
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    return eventsStore.getDeletionsStreamed(userId, query, options);
  }

  /**
   * @param [options]
   */
  async getDeletions (storeId: string, userId: string, query: EventQuery, options?: EventOptions): Promise<EventLike[]> {
    const resultStream = await this.getDeletionsStreamed(storeId, userId, query, options);
    const res: EventLike[] = [];
    for await (const item of resultStream) {
      res.push(item);
    }
    return res;
  }

  // ----------------- CREATE ----------------- //

  /**
   *
   * @param [doNotOverrideIntegrity] - Used by tests to create event with preset integrity such as historical data
   */
  async create (userId: string, eventData: Partial<EventLike>, mallTransaction?: Transaction, doNotOverrideIntegrity = false): Promise<EventLike> {
    assert.ok(eventData.attachments == null || eventData.attachments.length === 0,
      'Attachments must be added after event creation');
    const { storeId, eventsStore, storeEvent, storeTransaction } = await this.prepareForStore(eventData, mallTransaction, doNotOverrideIntegrity);
    try {
      const res = await eventsStore.create(userId, storeEvent, storeTransaction);
      return eventsUtils.convertEventFromStore(storeId, res);
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
  }

  // ----------------- ATTACHMENTS ----------------- //

  async addAttachment (userId: string, eventId: string, attachmentItem: AttachmentItem, mallTransaction?: Transaction): Promise<EventLike> {
    const [storeId, storeEventId] = storeDataUtils.parseStoreIdAndStoreItemId(eventId);
    const eventsStore = this.eventsStores.get(storeId);
    const storeEvent = await eventsStore.addAttachment(userId, storeEventId, attachmentItem);
    const event = eventsUtils.convertEventFromStore(storeId, storeEvent);
    return event;
  }

  async getAttachment (userId: string, eventData: EventLike, fileId: string): Promise<unknown> {
    const [storeId, storeEventId] = storeDataUtils.parseStoreIdAndStoreItemId(eventData.id);
    const eventsStore = this.eventsStores.get(storeId);
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    return await eventsStore.getAttachment(userId, storeEventId, fileId);
  }

  async deleteAttachment (userId: string, eventId: string, fileId: string, mallTransaction?: Transaction): Promise<EventLike> {
    const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(eventId);
    const eventsStore = this.eventsStores.get(storeId);
    const storeTransaction = mallTransaction ? await mallTransaction.getStoreTransaction(storeId) : null;
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    const eventFromStore = await eventsStore.deleteAttachment(userId, eventId, fileId, storeTransaction);
    const event = eventsUtils.convertEventFromStore(storeId, eventFromStore);
    return event;
  }

  async createWithAttachments (userId: string, eventDataWithoutAttachments: Partial<EventLike>, attachmentsItems: AttachmentItem[], mallTransaction?: Transaction): Promise<EventLike> {
    let event = await this.create(userId, eventDataWithoutAttachments);
    for (const attachmentItem of attachmentsItems) {
      event = await this.addAttachment(userId, event.id, attachmentItem);
    }
    return event;
  }

  // ----------------- UPDATE ----------------- //

  /**
   * @param opts.onlyIfNotTrashed compare-and-set: apply the update only while
   *   the event is still untrashed. Exactly one of N concurrent callers wins;
   *   the losers get `null` back instead of the usual "could not update" error,
   *   because losing the race is an expected outcome, not a failure.
   */
  async update (userId: string, newEventData: Partial<EventLike>, mallTransaction?: Transaction, opts?: { onlyIfNotTrashed?: boolean; skipVersioning?: boolean }): Promise<EventLike | null> {
    // update integrity field and recalculate if needed
    // integrity caclulation is done on event.id and streamIds that includes the store prefix
    if (integrity.events.isActive) {
      integrity.events.set(newEventData);
    }
    // replace all streamIds by store-less streamIds
    // Invariant: update is only called with an existing event's id set.
    const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(newEventData.id!);
    const storeEvent = eventsUtils.convertEventToStore(storeId, newEventData);

    if (storeEvent?.streamIds) {
      const storeStreamIds: string[] = [];
      for (const fullStreamId of newEventData.streamIds!) {
        const [streamStoreId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(fullStreamId);
        if (streamStoreId !== storeId) {
          // Account stream IDs (e.g. :_system:language) are valid in local store events
          if (storeId === storeDataUtils.LocalStoreId &&
              streamStoreId === storeDataUtils.AccountStoreId) {
            storeStreamIds.push(storeStreamId);
            continue;
          }
          throw errorFactory.invalidRequestStructure('events cannot be moved to a different store', newEventData);
        }
        storeStreamIds.push(storeStreamId);
      }
      storeEvent.streamIds = storeStreamIds;
    }
    const eventsStore = this.eventsStores.get(storeId);
    const storeTransaction = mallTransaction
      ? await mallTransaction.getStoreTransaction(storeId)
      : null;
    try {
      const success = await eventsStore.update(userId, storeEvent, storeTransaction, opts);
      if (!success) {
        if (opts?.onlyIfNotTrashed) return null; // lost the race — expected
        throw errorFactory.invalidItemId('Could not update event with id ' + newEventData.id);
      }
      return eventsUtils.convertEventFromStore(storeId, storeEvent);
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
  }

  /**
   * Utility to change streams for multiple matching events
   * @param userId - userId
   * @param query - query to find events @see events.get parms
   * @param update - perform update as per the following
   * @param update.fieldsToSet - provided object fields with matching events
   * @param update.fieldsToDelete - remove fields from matching events
   * @param update.addStreams - array of streams ids to add to the events streamIds
   * @param update.removeStreams - array of streams ids to be remove from the events streamIds
   * @param update.filter - function to filter events to update (return true to update)
   * @param [forEachEvent] - each updated event is passed as parameter, null is passed after last event.
   */
  async updateMany (userId: string, query: EventQuery, update: UpdateManySpec, forEachEvent: ((e: EventLike | null) => unknown) | null, mallTransaction?: Transaction): Promise<EventLike[] | null> {
    const result: EventLike[] = [];
    const streamedUpdate = await this.updateStreamedMany(userId, query, update, mallTransaction);
    for await (const event of streamedUpdate) {
      if (forEachEvent != null) {
        forEachEvent(event);
      } else {
        result.push(event);
      }
    }
    if (forEachEvent != null) {
      forEachEvent(null);
      return null;
    }
    return result;
  }

  /**
   * Utility to change streams for multiple matching events
   * @param userId - userId
   * @param query - query to find events @see events.get parms
   * @param update - perform update as per the following
   * @param update.fieldsToSet - provided object fields with matching events
   * @param update.fieldsToDelete - remove fields from matching events
   * @param update.addStreams - array of streams ids to add to the events streamIds
   * @param update.removeStreams - array of streams ids to be remove from the events streamIds
   * @param update.filter - function to filter events to update (return true to update)
   */
  async updateStreamedMany (userId: string, query: EventQuery, update: UpdateManySpec = {}, mallTransaction?: Transaction): Promise<ReadableType> {
    const paramsByStore = eventsQueryUtils.getParamsByStore(query);
    // fetch events to be updated
    const streamedMatchingEvents = await this.getStreamedWithParamsByStore(userId, paramsByStore);
    // getStreamed returns an Error for multi-store queries; previously this
    // fell through to a TypeError when iterating — throw it explicitly.
    if (streamedMatchingEvents instanceof Error) throw streamedMatchingEvents;
    // post-guard capture: keeps the narrowing inside the generator closure
    const matchingEvents: ReadableType = streamedMatchingEvents;
    const mallEvents = this;
    async function * reader () {
      for await (const eventData of matchingEvents) {
        const newEventData = deepMerge(eventData, update.fieldsToSet);
        if (update.addStreams && update.addStreams.length > 0) {
          newEventData.streamIds = [...new Set([...(newEventData.streamIds ?? []), ...update.addStreams])];
        }
        if (update.removeStreams && update.removeStreams.length > 0) {
          const toRemove = update.removeStreams;
          newEventData.streamIds = (newEventData.streamIds ?? []).filter((id: string) => !toRemove.includes(id));
        }
        // eventually remove fields from event
        if (update.fieldsToDelete && update.fieldsToDelete.length > 0) {
          // remove attachments if needed
          if (update.fieldsToDelete.includes('attachments') &&
                        eventData.attachments != null) {
            for (const attachment of eventData.attachments) {
              await mallEvents.deleteAttachment(userId, eventData, attachment.id, mallTransaction);
            }
          }
          for (const field of update.fieldsToDelete) {
            delete newEventData[field];
          }
        }
        if (update.filter == null || update.filter(newEventData)) {
          const updatedEvent = await mallEvents.update(userId, newEventData, mallTransaction);
          yield updatedEvent;
        }
      }
      // finish the iterator
      return true;
    }
    return Readable.from(reader());
  }

  // ----------------- DELETE / UPDATE ----------------- //

  async delete (userId: string, originalEvent: EventLike, mallTransaction?: Transaction): Promise<void> {
    const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(originalEvent.id);
    const originalStoreEvent = eventsUtils.convertEventToStore(storeId, originalEvent);
    const eventsStore = this.eventsStores.get(storeId);
    const storeTransaction = mallTransaction ? await mallTransaction.getStoreTransaction(storeId) : null;
    await eventsStore.delete(userId, originalStoreEvent, storeTransaction);
  }

  // ----------------- UTILS -----------------

  /**
   * Common utils for events.create and events.createWithAttachmentss
   * @param [mallTransaction]
   * @param [doNotOverrideIntegrity] - Used during tests to store raw events (ex: history or deleted event)
   * @private
   */
  async prepareForStore (eventData: Partial<EventLike>, mallTransaction: Transaction, doNotOverrideIntegrity = false): Promise<{ storeId: string; eventsStore: EventsStore; storeEvent: EventLike; storeTransaction: unknown }> {
    let storeId = null;
    // add eventual missing id and get storeId from first streamId then
    if (eventData.id == null) {
      const [streamStoreId] = storeDataUtils.parseStoreIdAndStoreItemId(eventData.streamIds![0]);
      if (streamStoreId === storeDataUtils.AccountStoreId) {
        // Account events route to the account store; use stream ID as event ID
        // (account store extracts field name from the prefixed stream ID)
        storeId = storeDataUtils.AccountStoreId;
        eventData.id = eventData.streamIds![0];
      } else {
        storeId = storeDataUtils.isPassthroughStore(streamStoreId)
          ? storeDataUtils.LocalStoreId
          : streamStoreId;
        eventData.id = storeDataUtils.getFullItemId(storeId, cuid());
      }
    } else {
      // get storeId from event id
      [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(eventData.id);
    }
    // set integrity
    if (eventData.integrity != null) {
      if (!doNotOverrideIntegrity) integrity.events.set(eventData);
    } else {
      integrity.events.set(eventData);
    }
    const storeEvent = eventsUtils.convertEventToStore(storeId, eventData);
    const eventsStore = this.eventsStores.get(storeId);
    const storeTransaction = mallTransaction
      ? await mallTransaction.getStoreTransaction(storeId)
      : null;
    return { storeId, eventsStore, storeEvent, storeTransaction };
  }

  // -------------- LOCAL SPECIFIC TO ACCOUNT & SYSTEM STREAMS ----- //

  async localRemoveAllNonAccountEventsForUser (userId: string): Promise<unknown> {
    const localEventsStore = this.eventsStores.get('local');
    return await localEventsStore.removeAllNonAccountEventsForUser(userId);
  }
}
/**
 * Account events live in the local MongoDB store (account store only provides
 * stream definitions). Remap any account-store params into local-store params.
 */
export default MallUserEvents;
export { MallUserEvents };
