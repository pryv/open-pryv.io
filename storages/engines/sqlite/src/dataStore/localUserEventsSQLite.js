/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createId: cuid } = require('@paralleldrive/cuid2');
const ds = require('@pryv/datastore');
const errors = ds.errors;
const timestamp = require('unix-timestamp');
const DeletionModesFields = require('../../../../shared/DeletionModesFields');
const localStoreEventQueries = require('../../../../shared/localStoreEventQueries');

/**
 * Local data store: events implementation.
 */
module.exports = ds.createUserEvents({
  storage: null,
  eventsFileStorage: null,
  deletionSettings: null,
  keepHistory: null,
  setIntegrityOnEvent: null,

  init (storage, eventsFileStorage, settings, setIntegrityOnEventFn, systemStreams) {
    this.storage = storage;
    this.eventsFileStorage = eventsFileStorage;
    this.settings = settings;
    this.setIntegrityOnEvent = setIntegrityOnEventFn;
    this.accountStreamIds = systemStreams?.accountStreamIds || [];
    this.deletionSettings = {
      mode: this.settings.versioning?.deletionMode || 'keep-nothing'
    };
    this.deletionSettings.fields = DeletionModesFields[this.deletionSettings.mode] || ['integrity'];
    this.deletionSettings.removeAttachments = this.deletionSettings.fields.includes('attachments');
    this.keepHistory = this.settings.versioning?.forceKeepHistory || false;
  },

  async getOne (userId, eventId) {
    const db = await this.storage.forUser(userId);
    return db.getOneEvent(eventId);
  },

  /**
   * @returns {Promise<any>}
   */
  async get (userId, storeQuery, storeOptions) {
    const db = await this.storage.forUser(userId);
    const query = localStoreEventQueries.localStorePrepareQuery(storeQuery);
    const options = localStoreEventQueries.localStorePrepareOptions(storeOptions);
    return db.getEvents({ query, options });
  },

  /**
   * @returns {Promise<any>}
   */
  async getStreamed (userId, storeQuery, storeOptions) {
    const db = await this.storage.forUser(userId);
    const query = localStoreEventQueries.localStorePrepareQuery(storeQuery);
    const options = localStoreEventQueries.localStorePrepareOptions(storeOptions);
    return db.getEventsStreamed({ query, options });
  },

  /**
   * @returns {Promise<any>}
   */
  async getDeletionsStreamed (userId, query, options) {
    const db = await this.storage.forUser(userId);
    return db.getEventDeletionsStreamed(query.deletedSince);
  },

  /**
   * @returns {Promise<any>}
   */
  async getHistory (userId, eventId) {
    const db = await this.storage.forUser(userId);
    return db.getEventHistory(eventId);
  },

  /**
   * @returns {Promise<any>}
   */
  async create (userId, event, transaction) {
    const db = await this.storage.forUser(userId);
    try {
      await db.createEvent(event);
      return event;
    } catch (err) {
      if (err.message === 'UNIQUE constraint failed: events.eventid') {
        throw errors.itemAlreadyExists('event', { id: event.id }, err);
      }
      throw errors.unexpectedError(err);
    }
  },

  /**
   * @returns {Promise<any>}
   */
  async update (userId, eventData, transaction) {
    const db = await this.storage.forUser(userId);
    await this._generateVersionIfNeeded(db, eventData.id, null, transaction);
    try {
      return db.updateEvent(eventData.id, eventData);
    } catch (err) {
      if (err.message === 'UNIQUE constraint failed: events.eventid') {
        throw errors.itemAlreadyExists('event', { id: eventData.id }, err);
      }
      throw errors.unexpectedError(err);
    }
  },

  /**
   * @returns {Promise<any>}
   */
  async delete (userId, originalEvent, transaction) {
    const db = await this.storage.forUser(userId);
    await this._generateVersionIfNeeded(db, originalEvent.id, originalEvent, transaction);
    const deletedEventContent = structuredClone(originalEvent);
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
    delete deletedEventContent.id;
    return await db.updateEvent(eventId, deletedEventContent);
  },

  async _generateVersionIfNeeded (db, eventId, originalEvent = null, transaction = null) {
    if (!this.keepHistory) return;
    let versionItem = null;
    if (originalEvent != null) {
      versionItem = structuredClone(originalEvent);
    } else {
      versionItem = await db.getOneEvent(eventId);
    }
    versionItem.headId = eventId;
    versionItem.id = cuid();
    await db.createEvent(versionItem);
  },

  /**
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async _deleteUser (userId) {
    const db = await this.storage.forUser(userId);
    await this.eventsFileStorage.removeAllForUser(userId);
    return await db.deleteEvents({ query: [] });
  },

  /**
   * @param {string} userId
   * @returns {Promise<any>}
   */
  async _getStorageInfos (userId) {
    const db = await this.storage.forUser(userId);
    const count = db.countEvents();
    return { count };
  },

  async _getFilesStorageInfos (userId) {
    const sizeKb = await this.eventsFileStorage.getFileStorageInfos(userId);
    return { sizeKb };
  },

  /**
    * Local stores only - as long as SystemStreams are embedded
    */
  async removeAllNonAccountEventsForUser (userId) {
    const db = await this.storage.forUser(userId);
    const allAccountStreamIds = this.accountStreamIds;
    const query = [{ type: 'streamsQuery', content: [[{ any: ['*'] }, { not: allAccountStreamIds }]] }];
    const res = await db.deleteEvents({ query, options: {} });
    await this.eventsFileStorage.removeAllForUser(userId);
    return res;
  }
});
