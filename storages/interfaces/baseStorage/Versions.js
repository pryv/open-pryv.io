/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Versions interface — contract for the global versions storage.
 * Async/await API matching the existing implementation.
 *
 * Use {@link validateVersions} to verify class-based instances.
 */

const REQUIRED_METHODS = [
  'getCurrent',
  'migrateIfNeeded',
  'removeAll',
  // Migration methods
  'exportAll',
  'importAll'
];

/**
 * Validate that a class instance implements all required Versions methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateVersions = function validateVersions (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`Versions implementation missing method: ${method}`);
    }
  }
  return instance;
};

module.exports.REQUIRED_METHODS = REQUIRED_METHODS;
