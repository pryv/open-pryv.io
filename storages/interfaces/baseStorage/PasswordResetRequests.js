/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PasswordResetRequests interface — contract for the global password reset storage.
 * Callback-based API matching the existing MongoDB implementation.
 *
 * Use {@link validatePasswordResetRequests} to verify class-based instances.
 */

const REQUIRED_METHODS = [
  'get',
  'generate',
  'destroy',
  'clearAll',
  // Migration methods
  'exportAll',
  'importAll'
];

/**
 * Validate that a class instance implements all required PasswordResetRequests methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validatePasswordResetRequests = function validatePasswordResetRequests (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`PasswordResetRequests implementation missing method: ${method}`);
    }
  }
  return instance;
};

module.exports.REQUIRED_METHODS = REQUIRED_METHODS;
