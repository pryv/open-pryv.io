/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * BackupWriter prototype object.
 * All backup writer implementations inherit from this via {@link createBackupWriter}.
 *
 * A BackupWriter produces a portable, engine-agnostic backup archive.
 * Data is written as JSONL (one JSON object per line), optionally gzip-compressed.
 * Large collections (events, audit) are chunked by maxChunkSize.
 *
 * @exports BackupWriter
 */
const BackupWriter = module.exports.BackupWriter = {
  /**
   * Open a user context for writing backup data.
   * Must be called before any user-scoped write methods.
   * @param {string} userId
   * @param {string} username
   * @returns {Promise<UserBackupWriter>}
   */
  async openUser (userId, username) { throw new Error('Not implemented'); },

  /**
   * Write platform-level data (PlatformDB export).
   * @param {AsyncIterable|Array} data - platform records
   * @returns {Promise<void>}
   */
  async writePlatformData (data) { throw new Error('Not implemented'); },

  /**
   * Write the top-level manifest. Must be called last — acts as completion marker.
   * @param {Object} params
   * @param {string} params.coreVersion - service-core version
   * @param {Object} params.config - engine config, domain, etc.
   * @param {Array<Object>} params.userManifests - per-user manifests from UserBackupWriter.close()
   * @param {string} params.backupType - 'full' or 'incremental'
   * @param {number} [params.snapshotBefore] - consistency cutoff: items modified after this are excluded
   * @param {number} params.backupTimestamp - when this backup was created
   * @returns {Promise<void>}
   */
  async writeManifest (params) { throw new Error('Not implemented'); },

  /**
   * Finalize and close the backup writer. Release resources.
   * @returns {Promise<void>}
   */
  async close () { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(BackupWriter)) {
  Object.defineProperty(BackupWriter, propName, { configurable: false });
}

/**
 * Create a new BackupWriter with the given implementation.
 * @param {Object} implementation
 * @returns {BackupWriter}
 */
module.exports.createBackupWriter = function createBackupWriter (implementation) {
  return Object.assign(Object.create(BackupWriter), implementation);
};

const REQUIRED_METHODS = Object.getOwnPropertyNames(BackupWriter);

/**
 * Validate that an instance implements all required BackupWriter methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateBackupWriter = function validateBackupWriter (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`BackupWriter implementation missing method: ${method}`);
    }
  }
  return instance;
};

// ---------------------------------------------------------------------------
// UserBackupWriter — returned by BackupWriter.openUser()
// ---------------------------------------------------------------------------

/**
 * UserBackupWriter prototype object.
 * Handles writing all data scoped to a single user.
 * @exports UserBackupWriter
 */
const UserBackupWriter = module.exports.UserBackupWriter = {
  /**
   * Write streams data.
   * @param {AsyncIterable|Array} items
   * @returns {Promise<void>}
   */
  async writeStreams (items) { throw new Error('Not implemented'); },

  /**
   * Write accesses data.
   * @param {AsyncIterable|Array} items
   * @returns {Promise<void>}
   */
  async writeAccesses (items) { throw new Error('Not implemented'); },

  /**
   * Write profile data.
   * @param {AsyncIterable|Array} items
   * @returns {Promise<void>}
   */
  async writeProfile (items) { throw new Error('Not implemented'); },

  /**
   * Write webhooks data.
   * @param {AsyncIterable|Array} items
   * @returns {Promise<void>}
   */
  async writeWebhooks (items) { throw new Error('Not implemented'); },

  /**
   * Write events data. Auto-chunks by maxChunkSize.
   * @param {AsyncIterable|Array} items
   * @returns {Promise<void>}
   */
  async writeEvents (items) { throw new Error('Not implemented'); },

  /**
   * Write audit events. Auto-chunks by maxChunkSize.
   * @param {AsyncIterable|Array} items
   * @returns {Promise<void>}
   */
  async writeAudit (items) { throw new Error('Not implemented'); },

  /**
   * Write HF series data (CSV format).
   * @param {AsyncIterable|Array} items
   * @returns {Promise<void>}
   */
  async writeSeries (items) { throw new Error('Not implemented'); },

  /**
   * Write a single attachment file.
   * @param {string} eventId - owning event
   * @param {string} fileId - unique attachment identifier
   * @param {ReadableStream} readStream
   * @returns {Promise<void>}
   */
  async writeAttachment (eventId, fileId, readStream) { throw new Error('Not implemented'); },

  /**
   * Write account data (passwords, store key-values, account fields).
   * @param {Object} data - as returned by UserAccountStorage.exportAll()
   * @returns {Promise<void>}
   */
  async writeAccountData (data) { throw new Error('Not implemented'); },

  /**
   * Close the user writer and return the user manifest.
   * @returns {Promise<Object>} userManifest with userId, username, chunk inventory, stats
   */
  async close () { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(UserBackupWriter)) {
  Object.defineProperty(UserBackupWriter, propName, { configurable: false });
}

/**
 * Create a new UserBackupWriter with the given implementation.
 * @param {Object} implementation
 * @returns {UserBackupWriter}
 */
module.exports.createUserBackupWriter = function createUserBackupWriter (implementation) {
  return Object.assign(Object.create(UserBackupWriter), implementation);
};

const USER_REQUIRED_METHODS = Object.getOwnPropertyNames(UserBackupWriter);

/**
 * Validate that an instance implements all required UserBackupWriter methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
module.exports.validateUserBackupWriter = function validateUserBackupWriter (instance) {
  for (const method of USER_REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UserBackupWriter implementation missing method: ${method}`);
    }
  }
  return instance;
};
