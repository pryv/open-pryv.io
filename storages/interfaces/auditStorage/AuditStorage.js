/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * AuditStorage interface — contract for the LRU-cached audit storage manager.
 * Manages per-user audit databases.
 *
 * Use {@link validateAuditStorage} to verify class-based instances.
 */

const REQUIRED_METHODS = [
  'init',
  'getVersion',
  'checkInitialized',
  'forUser',
  'deleteUser',
  'close'
];

/**
 * Validate that a class instance implements all required AuditStorage methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateAuditStorage = function validateAuditStorage (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`AuditStorage implementation missing method: ${method}`);
    }
  }
  return instance;
};

module.exports.REQUIRED_METHODS = REQUIRED_METHODS;
