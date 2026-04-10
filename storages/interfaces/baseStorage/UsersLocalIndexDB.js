/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * UsersLocalIndexDB prototype object.
 * Backend implementations (MongoDB, SQLite) must provide all these methods.
 * Use {@link validateUsersLocalIndexDB} to verify class-based instances.
 * @exports UsersLocalIndexDB
 */
const UsersLocalIndexDB = module.exports.UsersLocalIndexDB = {
  async init () { throw new Error('Not implemented'); },

  /**
   * @param {string} username
   * @param {string} userId
   */
  async addUser (username, userId) { throw new Error('Not implemented'); },

  /**
   * @param {string} username
   * @returns {Promise<string|undefined>}
   */
  async getIdForName (username) { throw new Error('Not implemented'); },

  /**
   * @param {string} userId
   * @returns {Promise<string|undefined>}
   */
  async getNameForId (userId) { throw new Error('Not implemented'); },

  /**
   * @returns {Promise<Object>} Keys are usernames, values are userIds
   */
  async getAllByUsername () { throw new Error('Not implemented'); },

  /**
   * Delete all entries (tests only).
   */
  async deleteAll () { throw new Error('Not implemented'); },

  /**
   * @param {string} userId
   */
  async deleteById (userId) { throw new Error('Not implemented'); },

  // --- Migration methods --- //

  /**
   * Export all user index entries.
   * @returns {Promise<Object>} Keys are usernames, values are userIds
   */
  async exportAll () { throw new Error('Not implemented'); },

  /**
   * Import user index entries.
   * @param {Object} data - Keys are usernames, values are userIds
   */
  async importAll (data) { throw new Error('Not implemented'); },

  /**
   * Clear all entries.
   */
  async clearAll () { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(UsersLocalIndexDB)) {
  Object.defineProperty(UsersLocalIndexDB, propName, { configurable: false });
}

const REQUIRED_METHODS = Object.getOwnPropertyNames(UsersLocalIndexDB);

/**
 * Validate that a class instance implements all required UsersLocalIndexDB methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateUsersLocalIndexDB = function validateUsersLocalIndexDB (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UsersLocalIndexDB implementation missing method: ${method}`);
    }
  }
  return instance;
};
