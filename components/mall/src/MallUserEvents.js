/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const _ = require('lodash');
const assert = require('assert');
const storeDataUtils = require('./helpers/storeDataUtils');
const eventsUtils = require('./helpers/eventsUtils');
const eventsQueryUtils = require('./helpers/eventsQueryUtils');

const errorFactory = require('errors').factory;
const integrity = require('business/src/integrity');

const { Readable } = require('stream');

const cuid = require('cuid');

/**
 * Storage for events.
 * Dispatches requests to each data store's events.
 */
class MallUserEvents {
  /**
   * @type {Map<string, UserEvents>}
   */
  eventsStores = new Map();
  /**
   * @type {Map<string, Object>}
   */
  storeSettings = new Map();

  /**
   * @param {{ storesById: Map, storeDescriptionsByStore: Map }} storesHolder
   */
  constructor (storesHolder) {
    for (const [storeId, store] of storesHolder.storesById) {
      this.eventsStores.set(storeId, store.events);
      this.storeSettings.set(storeId, storesHolder.storeDescriptionsByStore.get(store).settings);
    }
  }

  // ----------------- GET ----------------- //

  /**
   * Get one event without filtering
   * Should also return eventual deleted events
   * @param {*} userId
   * @param {*} fullEventId
   * @returns {Promise<any>}
   */
  async getOne (userId, fullEventId) {
    const [storeId, storeEventId] = storeDataUtils.parseStoreIdAndStoreItemId(fullEventId);
    const eventsStore = this.eventsStores.get(storeId);
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    try {
      const event = await eventsStore.getOne(userId, storeEventId);
      if (event != null) { return eventsUtils.convertEventFromStore(storeId, event); }
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
    return null;
  }

  async getHistory (userId, fullEventId) {
    const [storeId, storeEventId] = storeDataUtils.parseStoreIdAndStoreItemId(fullEventId);
    const eventsStore = this.eventsStores.get(storeId);
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    const res = [];
    try {
      const events = await eventsStore.getHistory(userId, storeEventId);
      for (const event of events) {
        res.push(eventsUtils.convertEventFromStore(storeId, event));
      }
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
    return res;
  }

  /**
   * @returns {Promise<any[]>}
   */
  async get (userId, params) {
    return await this.getWithParamsByStore(userId, eventsQueryUtils.getParamsByStore(params));
  }

  /**
   * Specific to Mall, allow query with a prepared query by store
   * @returns {Promise<any[]>}
   */
  async getWithParamsByStore (userId, paramsByStore) {
    const res = [];
    for (const storeId of Object.keys(paramsByStore)) {
      const eventsStore = this.eventsStores.get(storeId);
      const params = paramsByStore[storeId];
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
   * @returns {Promise<any>}
   */
  async getStreamed (userId, params) {
    return await this.getStreamedWithParamsByStore(userId, eventsQueryUtils.getParamsByStore(params));
  }

  /**
   * Specific to Mall, allow query with a prepared query by store
   * @returns {Promise<any>}
   */
  async getStreamedWithParamsByStore (userId, paramsByStore) {
    if (Object.keys(paramsByStore).length !== 1) {
      return new Error('getStreamed only supported for one store at a time');
    }
    const storeId = Object.keys(paramsByStore)[0];
    const eventsStore = this.eventsStores.get(storeId);
    const params = paramsByStore[storeId];
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
   * @returns {Promise<void>}
   */
  async generateStreamsWithParamsByStore (userId, paramsByStore, addEventsStreamCallback) {
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
   * @param {string} storeId
   * @param {string} userId
   * @param {{deletedSince: timestamp}} query
   * @param {{skip: number, limit: number, sortAscending: boolean}} [options]
   * @returns {Promise<Readable>}
   */
  async getDeletionsStreamed (storeId, userId, query, options) {
    const eventsStore = this.eventsStores.get(storeId);
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    return eventsStore.getDeletionsStreamed(userId, query, options);
  }

  /**
   * @param {string} storeId
   * @param {string} userId
   * @param {{deletedSince: timestamp}} query
   * @param {{skip: number, limit: number, sortAscending: boolean}} [options]
   */
  async getDeletions (storeId, userId, query, options) {
    const resultStream = await this.getDeletionsStreamed(storeId, userId, query, options);
    const res = [];
    for await (const item of resultStream) {
      res.push(item);
    }
    return res;
  }

  // ----------------- CREATE ----------------- //

  /**
   *
   * @param {*} userId
   * @param {*} eventData
   * @returns {Promise<any>}
   */
  async create (userId, eventData, mallTransaction) {
    assert.ok(eventData.attachments == null || eventData.attachments.length === 0,
      'Attachments must be added after event creation');
    const { storeId, eventsStore, storeEvent, storeTransaction } = await this.prepareForStore(eventData, mallTransaction);
    try {
      const res = await eventsStore.create(userId, storeEvent, storeTransaction);
      return eventsUtils.convertEventFromStore(storeId, res);
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async createMany (userId, eventsData, mallTransaction) {
    for (const eventData of eventsData) {
      await this.create(userId, eventData, mallTransaction);
    }
  }

  /**
   * Support creating events with headId for history and already deleted events
   * Implies that events have already integrity calculated
   * @returns {Promise<void>}
   */
  async createManyForTests (userId, eventsData) {
    for (const eventData of eventsData) {
      const { eventsStore, storeEvent, storeTransaction } = await this.prepareForStore(eventData, null, true);
      await eventsStore.create(userId, storeEvent, storeTransaction);
    }
  }

  // ----------------- ATTACHMENTS ----------------- //

  /**
   * @param {string} userId
   * @param {string} eventId
   * @param {AttachmentItem} attachmentItem
   * @param {MallTransaction} mallTransaction
   * @returns {Promise<Event>}
   */
  async addAttachment (userId, eventId, attachmentItem, mallTransaction) {
    const [storeId, storeEventId] = storeDataUtils.parseStoreIdAndStoreItemId(eventId);
    const eventsStore = this.eventsStores.get(storeId);
    const storeEvent = await eventsStore.addAttachment(userId, storeEventId, attachmentItem);
    const event = eventsUtils.convertEventFromStore(storeId, storeEvent);
    return event;
  }

  /**
   * @param {string} userId
   * @param {string} fileId
   * @returns {Promise<any>}
   */
  async getAttachment (userId, eventData, fileId) {
    const [storeId, storeEventId] = storeDataUtils.parseStoreIdAndStoreItemId(eventData.id);
    const eventsStore = this.eventsStores.get(storeId);
    if (!eventsStore) {
      throw errorFactory.unknownResource(`Unknown store "${storeId}"`, storeId);
    }
    return await eventsStore.getAttachment(userId, storeEventId, fileId);
  }

  /**
   * @param {string} userId
   * @param {string} eventId
   * @param {string} fileId
   * @param {MallTransaction} mallTransaction
   * @returns {Promise<any>}
   */
  async deleteAttachment (userId, eventId, fileId, mallTransaction) {
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

  /**
   * @param {string} userId
   * @param {any} eventDataWithoutAttachments
   * @param {Array<AttachmentItem>} attachmentsItems
   * @param {MallTransaction} mallTransaction
   * @returns {Promise<void>}
   */
  async createWithAttachments (userId, eventDataWithoutAttachments, attachmentsItems, mallTransaction) {
    let event = await this.create(userId, eventDataWithoutAttachments);
    for (const attachmentItem of attachmentsItems) {
      event = await this.addAttachment(userId, event.id, attachmentItem);
    }
    return event;
  }

  // ----------------- UPDATE ----------------- //

  /**
   * @returns {Promise<any>}
   */
  async update (userId, newEventData, mallTransaction) {
    // update integrity field and recalculate if needed
    // integrity caclulation is done on event.id and streamIds that includes the store prefix
    if (integrity.events.isActive) {
      integrity.events.set(newEventData);
    }
    // replace all streamIds by store-less streamIds
    const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(newEventData.id);
    const storeEvent = eventsUtils.convertEventToStore(storeId, newEventData);

    if (storeEvent?.streamIds) {
      const storeStreamIds = [];
      for (const fullStreamId of newEventData.streamIds) {
        const [streamStoreId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(fullStreamId);
        if (streamStoreId !== storeId) {
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
      const success = await eventsStore.update(userId, storeEvent, storeTransaction);
      if (!success) {
        throw errorFactory.invalidItemId('Could not update event with id ' + newEventData.id);
      }
      return eventsUtils.convertEventFromStore(storeId, storeEvent);
    } catch (e) {
      storeDataUtils.throwAPIError(e, storeId);
    }
  }

  /**
   * Utility to change streams for multiple matching events
   * @param {string} userId - userId
   * @param {*} query - query to find events @see events.get parms
   * @param {any} update - perform update as per the following
   * @param {any} update.fieldsToSet - provided object fields with matching events
   * @param {Array<string>} update.fieldsToDelete - remove fields from matching events
   * @param {Array<string>} update.addStreams - array of streams ids to add to the events streamIds
   * @param {Array<string>} update.removeStreams - array of streams ids to be remove from the events streamIds
   * @param {Function} update.filter - function to filter events to update (return true to update)
   * @param {Function} [forEachEvent] - each updated event is passed as parameter, null is passed after last event.
   * @param {MallTransaction} mallTransaction
   * @returns {Array<Event>|null} Array of updated events or null if forEachEvent is provided
   */
  async updateMany (userId, query, update, forEachEvent, mallTransaction) {
    const result = [];
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
   * @param {string} userId - userId
   * @param {*} query - query to find events @see events.get parms
   * @param {any} update - perform update as per the following
   * @param {any} update.fieldsToSet - provided object fields with matching events
   * @param {Array<string>} update.fieldsToDelete - remove fields from matching events
   * @param {Array<string>} update.addStreams - array of streams ids to add to the events streamIds
   * @param {Array<string>} update.removeStreams - array of streams ids to be remove from the events streamIds
   * @param {Function} update.filter - function to filter events to update (return true to update)
   * @param {MallTransaction} mallTransaction
   * @returns {any} Streams of updated events
   */
  async updateStreamedMany (userId, query, update = {}, mallTransaction) {
    const paramsByStore = eventsQueryUtils.getParamsByStore(query);
    // fetch events to be updated
    const streamedMatchingEvents = await this.getStreamedWithParamsByStore(userId, paramsByStore);
    const mallEvents = this;
    async function * reader () {
      for await (const eventData of streamedMatchingEvents) {
        const newEventData = _.merge(eventData, update.fieldsToSet);
        if (update.addStreams && update.addStreams.length > 0) {
          newEventData.streamIds = _.union(newEventData.streamIds, update.addStreams);
        }
        if (update.removeStreams && update.removeStreams.length > 0) {
          newEventData.streamIds = _.difference(newEventData.streamIds, update.removeStreams);
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

  async delete (userId, originalEvent, mallTransaction) {
    const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(originalEvent.id);
    const originalStoreEvent = eventsUtils.convertEventToStore(storeId, originalEvent);
    const eventsStore = this.eventsStores.get(storeId);
    const storeTransaction = mallTransaction ? await mallTransaction.getStoreTransaction(storeId) : null;
    await eventsStore.delete(userId, originalStoreEvent, storeTransaction);
  }

  // ----------------- UTILS -----------------

  /**
   * Common utils for events.create and events.createWithAttachmentss
   * @param {Object} eventData
   * @param {MallTransaction} [mallTransaction]
   * @private
   * @returns {Promise<{ storeId: any; eventsStore: any; storeEvent: any; storeTransaction: any; }>}
   */
  async prepareForStore (eventData, mallTransaction, isFromTests = false) {
    let storeId = null;
    // add eventual missing id and get storeId from first streamId then
    if (eventData.id == null) {
      [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(eventData.streamIds[0]);
      eventData.id = storeDataUtils.getFullItemId(storeId, cuid());
    } else {
      // get storeId from event id
      [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(eventData.id);
    }
    // set integrity
    if (eventData.integrity != null) {
      if (!isFromTests) integrity.events.set(eventData);
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

  async localRemoveAllNonAccountEventsForUser (userId) {
    const localEventsStore = this.eventsStores.get('local');
    return await localEventsStore.removeAllNonAccountEventsForUser(userId);
  }
}
module.exports = MallUserEvents;
