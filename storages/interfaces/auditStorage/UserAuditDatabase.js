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

const REQUIRED_METHODS = [
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
  // Migration methods
  'exportAllEvents',
  'importAllEvents'
];

/**
 * Validate that a class instance implements all required UserAuditDatabase methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateUserAuditDatabase = function validateUserAuditDatabase (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UserAuditDatabase implementation missing method: ${method}`);
    }
  }
  return instance;
};

module.exports.REQUIRED_METHODS = REQUIRED_METHODS;
