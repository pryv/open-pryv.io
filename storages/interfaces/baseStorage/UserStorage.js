/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * UserStorage — common contract for all user-scoped BaseStorage subclasses
 * (Accesses, Profile, Streams, Webhooks).
 *
 * These are constructor/prototype-based classes, so we use the **validate**
 * pattern: check that all required methods exist on the instance's prototype chain.
 */

const REQUIRED_METHODS = [
  'getCollectionInfo',
  'find',
  'findOne',
  'insertOne',
  'findOneAndUpdate',
  'updateOne',
  'updateMany',
  'delete',
  'removeOne',
  'removeMany',
  'removeAll',
  'count',
  'countAll',
  'findDeletions',
  // Cross-user iteration
  'iterateAll',
  // Migration methods
  'exportAll',
  'importAll',
  'clearAll'
];

/**
 * Validate that a class instance implements all required UserStorage methods.
 * Checks the instance and its prototype chain.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateUserStorage = function validateUserStorage (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UserStorage implementation missing method: ${method}`);
    }
  }
  return instance;
};

module.exports.REQUIRED_METHODS = REQUIRED_METHODS;
