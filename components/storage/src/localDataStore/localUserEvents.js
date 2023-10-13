/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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
const Readable = require('stream').Readable;
const streamsQueryUtils = require('api-server/src/methods/helpers/streamsQueryUtils');
const ds = require('@pryv/datastore');
const errors = ds.errors;
const handleDuplicateError = require('../Database').handleDuplicateError;
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const DeletionModesFields = require('../DeletionModesFields');
const { localStorePrepareOptions, localStorePrepareQuery } = require('../localStoreEventQueries');
const timestamp = require('unix-timestamp');

/**
 * Local data store: events implementation.
 */
module.exports = ds.createUserEvents({
  eventsCollection: null,
  eventsFileStorage: null,
  deletionSettings: {
    mode: null,
    fields: null,
    removeAttachments: true,
    updateOperatorForHistory: { $unset: {} }
  },
  setIntegrityOnEvent: null,

  init (eventsCollection, eventsFileStorage, setIntegrityOnEventFn) {
    this.eventsCollection = eventsCollection;
    this.eventsFileStorage = eventsFileStorage;
    this.setIntegrityOnEvent = setIntegrityOnEventFn;

    // prepare deletion settings
    this.deletionSettings.mode = this.settings.versioning?.deletionMode || 'keep-nothing';
    this.deletionSettings.fields = DeletionModesFields[this.deletionSettings.mode] || ['integrity'];
    for (const field of this.deletionSettings.fields) {
      this.deletionSettings.updateOperatorForHistory.$unset[field] = '';
    }
    this.deletionSettings.removeAttachments = this.deletionSettings.updateOperatorForHistory.$unset.attachments != null;
    this.keepHistory = this.settings.versioning?.forceKeepHistory || false;
  },

  async getOne (userId, eventId) {
    const cursor = this._getCursor(userId, { _id: eventId }, {});
    const res = (await cursor.toArray()).map((value) => cleanResult({ value }));
    return res[0];
  },

  async get (userId, query, options) {
    const localQuery = localStorePrepareQuery(query);
    const localOptions = localStorePrepareOptions(options);
    const cursor = this._getCursor(userId, getMongoQuery(localQuery), localOptions);
    const res = (await cursor.toArray()).map((value) => cleanResult({ value }));
    return res;
  },

  async getStreamed (userId, query, options) {
    const localQuery = localStorePrepareQuery(query);
    const localOptions = localStorePrepareOptions(options);
    const cursor = this._getCursor(userId, getMongoQuery(localQuery), localOptions);
    return readableStreamFromEventCursor(cursor);
  },

  /**
   * @param {identifier} userId
   * @param {{deletedSince: timestamp}} query
   * @param {{skip: number, limit: number, sortAscending: boolean}} [options]
   * @returns {Promise<Readable>}
   */
  async getDeletionsStreamed (userId, query, options) {
    const mongoQuery = { deleted: { $gt: query.deletedSince } };
    const mongoOptions = { sort: { deleted: options?.sortAscending ? 1 : -1 } };
    if (options?.limit != null) mongoOptions.limit = options.limit;
    if (options?.skip != null) mongoOptions.skip = options.skip;
    const cursor = this._getCursor(userId, mongoQuery, mongoOptions);
    return readableStreamFromEventCursor(cursor);
  },

  async getHistory (userId, eventId) {
    const options = { sort: { modified: 1 } };
    const cursor = this._getCursor(userId, { headId: eventId }, options);
    const res = (await cursor.toArray()).map((value) => cleanHistoryResult({ value }));
    return res;
  },

  async create (userId, event, transaction) {
    try {
      const options = { transactionSession: transaction?.transactionSession };
      const toInsert = structuredClone(event);
      toInsert.userId = userId;
      toInsert._id = event.id;
      delete toInsert.id;
      await this.eventsCollection.insertOne(toInsert, options);
      return event;
    } catch (err) {
      handleDuplicateError(err);
      if (err.isDuplicateIndex != null && err.isDuplicateIndex('_id')) {
        throw errors.itemAlreadyExists('event', { id: event.id }, err);
      }
      throw errors.unexpectedError(err);
    }
  },

  async addAttachment (userId, eventId, attachmentItem, transaction) {
    const fileId = await this.eventsFileStorage.saveAttachmentFromStream(attachmentItem.attachmentData, userId, eventId);
    const attachment = Object.assign({ id: fileId }, attachmentItem);
    delete attachment.attachmentData;
    const event = await this.getOne(userId, eventId);
    event.attachments ??= [];
    event.attachments.push(attachment);
    this.setIntegrityOnEvent(event);
    await this.update(userId, event, transaction);
    return event;
  },

  async getAttachment (userId, eventId, fileId) {
    return this.eventsFileStorage.getAttachmentStream(userId, eventId, fileId);
  },

  async deleteAttachment (userId, eventId, fileId, transaction) {
    const event = await this.getOne(userId, eventId);
    event.attachments = event.attachments.filter((attachment) => {
      return attachment.id !== fileId;
    });
    await this.eventsFileStorage.removeAttachment(userId, eventId, fileId);
    await this.update(userId, event, transaction);
    return event;
  },

  async update (userId, eventData, transaction) {
    const update = structuredClone(eventData);
    update._id = update.id;
    update.userId = userId;
    delete update.id;
    const query = { userId, _id: update._id };
    const options = { transactionSession: transaction?.transactionSession };
    try {
      await this._generateVersionIfNeeded(userId, update._id, null, transaction);
      const res = await this.eventsCollection.replaceOne(query, update, options);
      return res.modifiedCount === 1; // true if an event was updated
    } catch (err) {
      throw errors.unexpectedError(err);
    }
  },

  async delete (userId, originalEvent) {
    const deletedEventContent = structuredClone(originalEvent);
    await this._generateVersionIfNeeded(userId, originalEvent.id, originalEvent);
    // if attachments are to be deleted
    if (this.deletionSettings.removeAttachments && deletedEventContent.attachments != null && deletedEventContent.attachments.length > 0) {
      await this.eventsFileStorage.removeAllForEvent(userId, deletedEventContent.id);
    }
    // eventually delete or update history
    if (this.deletionSettings.mode === 'keep-nothing') await this._deleteHistory(userId, deletedEventContent.id);
    if (this.deletionSettings.mode === 'keep-authors') {
      await this.eventsCollection.updateMany(
        { userId, headId: deletedEventContent.id },
        this.deletionSettings.updateOperatorForHistory, {});
    }

    // prepare event content for mongodb
    deletedEventContent.deleted = timestamp.now();
    for (const field of this.deletionSettings.fields) {
      delete deletedEventContent[field];
    }
    this.setIntegrityOnEvent(deletedEventContent);
    deletedEventContent._id = deletedEventContent.id;
    delete deletedEventContent.id;
    deletedEventContent.userId = userId;
    await this.eventsCollection.replaceOne({ userId, _id: deletedEventContent._id }, deletedEventContent);
  },

  async _deleteHistory (userId, eventId) {
    const options = { sort: { modified: 1 } };
    const query = { userId, headId: eventId };
    return await this.eventsCollection.deleteMany(query, options);
  },

  async _generateVersionIfNeeded (userId, eventId, originalEvent = null, transaction = null) {
    if (!this.keepHistory) return;
    const query = { userId, _id: eventId };
    const options = { transactionSession: transaction?.transactionSession };
    let versionItem = null;
    if (originalEvent != null) {
      versionItem = structuredClone(originalEvent);
      delete versionItem.id;
    } else {
      versionItem = await this.eventsCollection.findOne(query, options);
      delete versionItem._id;
    }
    versionItem.headId = eventId;
    await this.eventsCollection.insertOne(versionItem);
  },

  _getCursor (userId, query, options) {
    query.userId = userId;
    const queryOptions = { projection: options.projection };
    let cursor = this.eventsCollection
      .find(query, queryOptions)
      .sort(options.sort);
    if (options.skip != null) {
      cursor = cursor.skip(options.skip);
    }
    if (options.limit != null) {
      cursor = cursor.limit(options.limit);
    }
    return cursor;
  },

  async _deleteUser (userId) {
    const query = { userId };
    const res = await this.eventsCollection.deleteMany(query, {});
    return res;
  },

  async _getUserStorageSize (userId) {
    // TODO: fix this total HACK
    return await this.eventsCollection.countDocuments({ userId });
  },

  /**
   * Local stores only - as long as SystemStreams are embedded
   */
  async removeAllNonAccountEventsForUser (userId) {
    const allAccountStreamIds = SystemStreamsSerializer.getAccountStreamIds();
    const query = { userId, streamIds: { $nin: allAccountStreamIds } };
    const res = await this.eventsCollection.deleteMany(query, {});
    return res;
  }
});

// --------------- helpers ------------//

/**
 * change _id to id, remove userId, from result
 * @param {any} result
 * @returns {any}
 */
function cleanResult (result) {
  if (result?.value == null) { return result; }
  const value = result.value;
  if (value != null) {
    value.id = value._id;
    delete value._id;
    delete value.userId;
  }
  return value;
}

/**
 * change remove _id to set id to headId, from result
 * @param {any} result
 * @returns {any}
 */
function cleanHistoryResult (result) {
  if (result?.value == null) { return result; }
  const value = result.value;
  if (value != null) {
    value.id = value.headId;
    delete value._id;
    delete value.userId;
    delete value.headId;
  }
  return value;
}

const converters = {
  equal: (content) => {
    const realfield = content.field === 'id' ? '_id' : content.field;
    return { [realfield]: { $eq: content.value } };
  },
  greater: (content) => {
    return { [content.field]: { $gt: content.value } };
  },
  greaterOrEqual: (content) => {
    return { [content.field]: { $gte: content.value } };
  },
  lowerOrEqual: (content) => {
    return { [content.field]: { $lte: content.value } };
  },
  greaterOrEqualOrNull: (content) => {
    return {
      $or: [
        { [content.field]: { $gte: content.value } },
        { [content.field]: null }
      ]
    };
  },
  typesList: (list) => {
    if (list.length === 0) { return null; }
    return { type: { $in: list.map(getTypeQueryValue) } };
  },
  streamsQuery: (content) => {
    return streamsQueryUtils.toMongoDBQuery(content);
  }
};

/**
 * Transform the given events query to the MongoDB format.
 * @param {any[]} query
 * @returns {{ $and: any[] }}}
 */
function getMongoQuery (query) {
  const mongoQuery = { $and: [{ deleted: null, headId: null }] };
  for (const item of query) {
    const newCondition = converters[item.type](item.content);
    if (newCondition != null) {
      mongoQuery.$and.push(newCondition);
    }
  }
  if (mongoQuery.$and.length === 0) { delete mongoQuery.$and; } // remove empty $and
  return mongoQuery;
}

/**
 * Returns the query value to use for the given type, handling possible wildcards.
 *
 * @param {String} requestedType
 * @returns {any}
 */
function getTypeQueryValue (requestedType) {
  const wildcardIndex = requestedType.indexOf('/*');
  return wildcardIndex > 0
    ? new RegExp('^' + requestedType.substr(0, wildcardIndex + 1))
    : requestedType;
}

/**
 * Get a readable stream from a cursor
 * @param {Cursor} cursor
 */
function readableStreamFromEventCursor (cursor) {
  // streaming with backpressure - highWaterMark has really some effect "4000" seems to be an optimnal value
  const readableUnderPressure = new Readable({
    objectMode: true,
    highWaterMark: 4000
  });
  let performingReadRequest = false;
  readableUnderPressure._read = async () => {
    if (performingReadRequest) { return; } // avoid starting a 2nd read request when already pushing.
    performingReadRequest = true;
    try {
      let push = true;
      while (push) {
        if (!(await cursor.hasNext())) {
          readableUnderPressure.push(null);
          break;
        } // stop
        const value = await cursor.next();
        push = readableUnderPressure.push(cleanResult({ value })); // if null reader is "full" (handle back pressure)
      }
      performingReadRequest = false;
    } catch (err) {
      readableUnderPressure.emit('error', err);
    }
  };
  return readableUnderPressure;
}
