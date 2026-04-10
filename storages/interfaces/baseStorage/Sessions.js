/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Sessions interface — contract for the global sessions storage.
 * Callback-based API matching the existing MongoDB implementation.
 *
 * Use {@link validateSessions} to verify class-based instances.
 */

const REQUIRED_METHODS = [
  'get',
  'getMatching',
  'generate',
  'touch',
  'destroy',
  'clearAll',
  'expireNow',
  'remove',
  // Migration methods
  'exportAll',
  'importAll'
];

/**
 * Validate that a class instance implements all required Sessions methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateSessions = function validateSessions (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`Sessions implementation missing method: ${method}`);
    }
  }
  return instance;
};

module.exports.REQUIRED_METHODS = REQUIRED_METHODS;
