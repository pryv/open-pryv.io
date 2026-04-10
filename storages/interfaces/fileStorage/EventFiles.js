/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * EventFiles prototype object.
 * All event file storage implementations inherit from this via {@link createEventFiles}.
 * @exports EventFiles
 */
const EventFiles = module.exports.EventFiles = {
  async init () { throw new Error('Not implemented'); },

  /**
   * Computes storage size for a user's files.
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async getFileStorageInfos (userId) { throw new Error('Not implemented'); },

  /**
   * Save an attachment from a readable stream.
   * @param {ReadableStream} stream
   * @param {string} userId
   * @param {string} eventId
   * @param {string} [fileId]
   * @returns {Promise<string>} The fileId
   */
  async saveAttachmentFromStream (stream, userId, eventId, fileId) { throw new Error('Not implemented'); },

  /**
   * Get a readable stream for an attachment.
   * @param {string} userId
   * @param {string} eventId
   * @param {string} fileId
   * @returns {Promise<ReadableStream>}
   */
  async getAttachmentStream (userId, eventId, fileId) { throw new Error('Not implemented'); },

  /**
   * Remove a single attachment.
   * @param {string} userId
   * @param {string} eventId
   * @param {string} fileId
   */
  async removeAttachment (userId, eventId, fileId) { throw new Error('Not implemented'); },

  /**
   * Remove all attachments for an event.
   * @param {string} userId
   * @param {string} eventId
   */
  async removeAllForEvent (userId, eventId) { throw new Error('Not implemented'); },

  /**
   * Remove all attachments for a user.
   * @param {string} userId
   */
  async removeAllForUser (userId) { throw new Error('Not implemented'); },

  /**
   * Attach file operations to an event store.
   * @param {Object} es - EventDataStore
   * @param {Function} setIntegrityOnEvent
   */
  attachToEventStore (es, setIntegrityOnEvent) { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(EventFiles)) {
  Object.defineProperty(EventFiles, propName, { configurable: false });
}

/**
 * Create a new EventFiles object with the given implementation (plain-object pattern).
 * @param {Object} implementation
 * @returns {EventFiles}
 */
module.exports.createEventFiles = function createEventFiles (implementation) {
  return Object.assign(Object.create(EventFiles), implementation);
};

const REQUIRED_METHODS = Object.getOwnPropertyNames(EventFiles);

/**
 * Validate that an instance implements all required EventFiles methods
 * (checks prototype chain for class/prototype-based implementations).
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateEventFiles = function validateEventFiles (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`EventFiles implementation missing method: ${method}`);
    }
  }
  return instance;
};
