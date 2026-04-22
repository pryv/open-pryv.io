/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * BackupReader prototype object.
 * All backup reader implementations inherit from this via {@link createBackupReader}.
 *
 * A BackupReader reads a portable backup archive produced by a BackupWriter.
 * Handles JSONL (optionally gzip-compressed), chunked files, and attachments.
 *
 * @exports BackupReader
 */
const BackupReader = module.exports.BackupReader = {
  /**
   * Read the top-level manifest.
   * @returns {Promise<Object>} { version, config, users[], backupType, backupTimestamp, ... }
   */
  async readManifest () { throw new Error('Not implemented'); },

  /**
   * Read platform-level data.
   * @returns {AsyncIterable<Object>} platform records
   */
  async readPlatformData () { throw new Error('Not implemented'); },

  /**
   * Read register-level server mappings (v1 enterprise only).
   * Yields `{username, server}` rows from `register/servers.jsonl[.gz]`.
   * Default implementation yields nothing — sources without register
   * data (open-pryv.io v1.9, v2→v2 backups) inherit this no-op.
   *
   * @returns {AsyncIterable<{username: string, server: string}>}
   */
  async readServerMappings () {
    /* async generator that yields nothing */
    async function * empty () {}
    return empty();
  },

  /**
   * Open a user context for reading backup data.
   * @param {string} userId
   * @returns {Promise<UserBackupReader>}
   */
  async openUser (userId) { throw new Error('Not implemented'); },

  /**
   * Finalize and close the backup reader. Release resources.
   * @returns {Promise<void>}
   */
  async close () { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(BackupReader)) {
  Object.defineProperty(BackupReader, propName, { configurable: false });
}

/**
 * Create a new BackupReader with the given implementation.
 * @param {Object} implementation
 * @returns {BackupReader}
 */
module.exports.createBackupReader = function createBackupReader (implementation) {
  return Object.assign(Object.create(BackupReader), implementation);
};

const REQUIRED_METHODS = Object.getOwnPropertyNames(BackupReader);

/**
 * Validate that an instance implements all required BackupReader methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateBackupReader = function validateBackupReader (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`BackupReader implementation missing method: ${method}`);
    }
  }
  return instance;
};

// ---------------------------------------------------------------------------
// UserBackupReader — returned by BackupReader.openUser()
// ---------------------------------------------------------------------------

/**
 * UserBackupReader prototype object.
 * Handles reading all data scoped to a single user.
 * @exports UserBackupReader
 */
const UserBackupReader = module.exports.UserBackupReader = {
  /**
   * Read the user manifest (userId, username, chunk inventory).
   * @returns {Promise<Object>}
   */
  async readUserManifest () { throw new Error('Not implemented'); },

  /**
   * Read streams data.
   * @returns {AsyncIterable<Object>}
   */
  async readStreams () { throw new Error('Not implemented'); },

  /**
   * Read accesses data.
   * @returns {AsyncIterable<Object>}
   */
  async readAccesses () { throw new Error('Not implemented'); },

  /**
   * Read profile data.
   * @returns {AsyncIterable<Object>}
   */
  async readProfile () { throw new Error('Not implemented'); },

  /**
   * Read webhooks data.
   * @returns {AsyncIterable<Object>}
   */
  async readWebhooks () { throw new Error('Not implemented'); },

  /**
   * Read events data. Reassembles chunks transparently.
   * @returns {AsyncIterable<Object>}
   */
  async readEvents () { throw new Error('Not implemented'); },

  /**
   * Read audit events. Reassembles chunks transparently.
   * @returns {AsyncIterable<Object>}
   */
  async readAudit () { throw new Error('Not implemented'); },

  /**
   * Read HF series data.
   * @returns {AsyncIterable<Object>}
   */
  async readSeries () { throw new Error('Not implemented'); },

  /**
   * Iterate over attachments.
   * @returns {AsyncIterable<{eventId: string, fileId: string, stream: ReadableStream}>}
   */
  async readAttachments () { throw new Error('Not implemented'); },

  /**
   * Read account data (passwords, store key-values, account fields).
   * @returns {Promise<Object>}
   */
  async readAccountData () { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(UserBackupReader)) {
  Object.defineProperty(UserBackupReader, propName, { configurable: false });
}

/**
 * Create a new UserBackupReader with the given implementation.
 * @param {Object} implementation
 * @returns {UserBackupReader}
 */
module.exports.createUserBackupReader = function createUserBackupReader (implementation) {
  return Object.assign(Object.create(UserBackupReader), implementation);
};

const USER_REQUIRED_METHODS = Object.getOwnPropertyNames(UserBackupReader);

/**
 * Validate that an instance implements all required UserBackupReader methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateUserBackupReader = function validateUserBackupReader (instance) {
  for (const method of USER_REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UserBackupReader implementation missing method: ${method}`);
    }
  }
  return instance;
};
